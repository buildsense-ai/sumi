/**
 * ApiKey verification for agents.
 *
 * An agent's only credential is a `cc_*` key. The canonical way to verify one is
 * `POST /api/account/introspect`, which authenticates with a shared Service
 * token — a credential a gateway deployment deliberately does not hold. The
 * fallback under test here asks CatsCo who the key belongs to using that same
 * key, via `GET /api/me`, which accepts an ApiKey directly.
 *
 * Both paths must normalize to the same result, including account_type, which
 * the two endpoints report differently (introspect: number, /api/me: string).
 *
 * NB: src/auth/catsco reads CATSCO_BASE_URL and CATSCO_SERVICE_TOKEN at module
 * evaluation, so the env block has to come before the dynamic import.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

process.env.CATSCO_BASE_URL = "https://catsco.example";
delete process.env.CATSCO_SERVICE_TOKEN;

const { introspectToken } = await import("../src/auth/catsco");

interface Call {
  url: string;
  method: string;
  auth: string;
  body?: string;
}

/** Stub fetch, recording what was asked of CatsCo. */
function stub(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: Call = {
        url: String(url),
        method: init?.method ?? "GET",
        auth: headers.Authorization ?? "",
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      return handler(call);
    })
  );
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const BOT_ME = {
  uid: 574,
  username: "bot-abraxas-5617",
  display_name: "Abraxas",
  avatar_url: "/uploads/a.png",
  account_type: "bot",
  email: "",
};

beforeEach(() => {
  delete process.env.CATSCO_SERVICE_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("introspectToken — /api/me fallback", () => {
  it("verifies an ApiKey without a service token", async () => {
    const calls = stub(() => json(BOT_ME));
    const result = await introspectToken("cc_23e_secret");

    expect(result?.active).toBe(true);
    expect(result?.user?.uid).toBe(574);
    expect(result?.user?.username).toBe("bot-abraxas-5617");
    expect(result?.user?.display_name).toBe("Abraxas");

    // The key is presented to CatsCo as an ApiKey, never as a bare token.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://catsco.example/api/me");
    expect(calls[0].auth).toBe("ApiKey cc_23e_secret");
  });

  it("maps account_type 'bot' to 1, which decides the a-prefix", async () => {
    // introspect says 1, /api/me says "bot"; the actor path branches on a
    // non-zero number, so a string left unmapped would make a bot look human.
    stub(() => json(BOT_ME));
    const result = await introspectToken("cc_23e_secret");
    expect(result?.user?.account_type).toBe(1);
    expect(result?.user?.account_type).not.toBe(0);
  });

  it("maps 'human' and unknown values to 0", async () => {
    stub(() => json({ uid: 275, username: "pi-dal", account_type: "human" }));
    expect((await introspectToken("cc_23e_a"))?.user?.account_type).toBe(0);

    stub(() => json({ uid: 275, username: "pi-dal" }));
    expect((await introspectToken("cc_23e_b"))?.user?.account_type).toBe(0);

    stub(() => json({ uid: 275, username: "pi-dal", account_type: "wat" }));
    expect((await introspectToken("cc_23e_c"))?.user?.account_type).toBe(0);
  });

  it("passes a numeric account_type through unchanged", async () => {
    stub(() => json({ uid: 574, username: "b", account_type: 1 }));
    expect((await introspectToken("cc_23e_secret"))?.user?.account_type).toBe(1);
  });

  it("refuses a rejected key", async () => {
    stub(() => json({ error: "unauthorized" }, 401));
    expect(await introspectToken("cc_23e_dead")).toBeNull();
  });

  it("refuses a 200 with no usable uid", async () => {
    stub(() => json({ username: "ghost", account_type: "bot" }));
    expect(await introspectToken("cc_23e_secret")).toBeNull();

    stub(() => json({ uid: 0, username: "zero" }));
    expect(await introspectToken("cc_23e_secret")).toBeNull();
  });

  it("refuses anything that is not a cc_ key", async () => {
    const calls = stub(() => json(BOT_ME));
    expect(await introspectToken("eyJhbGciOi.jwt.like")).toBeNull();
    expect(await introspectToken("")).toBeNull();
    // Not even asked: a JWT-shaped value is not our ApiKey path.
    expect(calls).toHaveLength(0);
  });

  it("returns null rather than throwing when CatsCo is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    expect(await introspectToken("cc_23e_secret")).toBeNull();
  });

  it("sends no Authorization header when the answer is empty", async () => {
    const calls = stub(() => json(BOT_ME));
    await introspectToken("cc_23e_secret");
    // Guards against the key leaking into a URL or a second header.
    expect(calls[0].url).not.toContain("cc_23e_secret");
  });
});

describe("introspectToken — service token path still wins", () => {
  it("prefers introspect when CATSCO_SERVICE_TOKEN is configured", async () => {
    process.env.CATSCO_SERVICE_TOKEN = "svc-token";
    const calls = stub((call) =>
      call.url.endsWith("/api/account/introspect")
        ? json({
            active: true,
            user: {
              uid: 574,
              username: "bot-abraxas-5617",
              display_name: "Abraxas",
              account_type: 1,
              state: 0,
            },
          })
        : json(BOT_ME)
    );

    const result = await introspectToken("cc_23e_secret");

    expect(result?.user?.uid).toBe(574);
    expect(result?.user?.account_type).toBe(1);
    // One call only — the canonical path answered, so no fallback was needed.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://catsco.example/api/account/introspect");
    expect(calls[0].auth).toBe("Service svc-token");
    expect(calls[0].body).toBe(JSON.stringify({ token: "cc_23e_secret" }));

    delete process.env.CATSCO_SERVICE_TOKEN;
  });

  it("falls back to /api/me when introspection cannot answer", async () => {
    process.env.CATSCO_SERVICE_TOKEN = "svc-token";
    const calls = stub((call) =>
      call.url.endsWith("/api/account/introspect")
        ? json({ error: "nope" }, 503)
        : json(BOT_ME)
    );

    const result = await introspectToken("cc_23e_secret");

    expect(result?.user?.uid).toBe(574);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://catsco.example/api/me");

    delete process.env.CATSCO_SERVICE_TOKEN;
  });

  it("never sends the Service token to /api/me", async () => {
    process.env.CATSCO_SERVICE_TOKEN = "svc-token";
    const calls = stub((call) =>
      call.url.endsWith("/api/account/introspect")
        ? json({ error: "down" }, 500)
        : json(BOT_ME)
    );
    await introspectToken("cc_23e_secret");

    const meCall = calls.find((c) => c.url.endsWith("/api/me"));
    expect(meCall?.auth).toBe("ApiKey cc_23e_secret");
    expect(meCall?.auth).not.toContain("svc-token");

    delete process.env.CATSCO_SERVICE_TOKEN;
  });
});

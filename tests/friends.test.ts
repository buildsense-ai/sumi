/**
 * The CatsCo roster proxy.
 *
 * This route is why the member picker said "CatsCo hasn't given you any friends
 * or bots yet" on an account with 18 friends and 9 bots. Two independent bugs
 * stacked:
 *
 *   - /api/friends returns `id`; the mapping read `uid` and filtered on it, so
 *     every friend was dropped. /api/bots does return `uid`. Accepting both is
 *     the whole point of the mapper.
 *   - The route demanded the caller's own CatsCo bearer token. Behind the
 *     artifact gateway the browser holds a viewer cookie and there is no bearer
 *     token, so the request was refused before it reached CatsCo.
 *
 * And a third, quieter one: failures came back as an empty list, so a broken
 * deployment looked exactly like a lonely account.
 *
 * NB: nothing statically imported here may transitively reach src/auth/catsco.
 * That module reads OC_JWT_SECRET and CATSCO_BASE_URL at module-evaluation time,
 * and static imports are hoisted above the assignments below. Hence the dynamic
 * imports and the env block being first.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import * as jose from "jose";

const TEST_DIR = `/tmp/sumi-friends-test-${process.pid}`;
process.env.SUMI_DATA_DIR = TEST_DIR;
process.env.OC_JWT_SECRET = "test-secret-friends";
process.env.CATSCO_BASE_URL = "https://catsco.example";

// Imported after the env above is in place — see the note at the top.
const { GET } = await import("../app/api/friends/route");
const { resetDbForTests } = await import("../src/db");

/** A CatsCo-shaped user JWT — the caller's own credential. */
async function userJwt(uid: number, username = `user${uid}`): Promise<string> {
  return new jose.SignJWT({ userId: uid, username, token_type: "user" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("catscompany")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.OC_JWT_SECRET));
}

/** A response shape real CatsCo produces for GET /api/friends. */
function friendsPayload() {
  return {
    friends: [
      // A human friend: `id`, no `uid` — the shape the old mapping dropped.
      { id: 363, username: "Yii", display_name: "", account_type: "human" },
      { id: 85, username: "arrowhaken", display_name: "arrowhaken", account_type: "human" },
      // A bot friend: also `id`, and it appears in /api/bots too.
      {
        id: 574,
        username: "bot-abraxas-5617",
        display_name: "Abraxas",
        avatar_url: "/uploads/a.png",
        account_type: "bot",
      },
    ],
  };
}

function botsPayload() {
  return {
    bots: [
      {
        uid: 574,
        id: 574,
        username: "bot-abraxas-5617",
        display_name: "Abraxas",
        avatar_url: "/uploads/a.png",
        is_owner: true,
        owner_id: 275,
      },
      // Mine, but not a friend — /api/friends never mentions it.
      { uid: 559, id: 559, username: "bot-bot-3279", display_name: "开发者", is_owner: true },
    ],
  };
}

interface StubOpts {
  friends?: unknown;
  bots?: unknown;
  friendsStatus?: number;
  botsStatus?: number;
  /** Answer for /_gateway/me. null means "gateway says anonymous". */
  viewer?: { uid: number; username?: string; kind?: string } | null;
  /** Throw instead of answering, for both rosters. */
  offline?: boolean;
  /** Status for the ApiKey verification call. */
  meStatus?: number;
}

/**
 * Stub fetch for the gateway identity endpoint and the two CatsCo rosters.
 *
 * Only the CatsCo calls are recorded: the gateway lookup is not part of what
 * these assertions are about.
 */
function stubUpstreams(opts: StubOpts = {}) {
  const calls: Array<{ url: string; auth: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);

      if (target.includes("/_gateway/me")) {
        const viewer =
          opts.viewer === undefined
            ? { uid: 275, username: "pi-dal", kind: "user" }
            : opts.viewer;
        return new Response(
          JSON.stringify(
            viewer ? { authenticated: true, viewer } : { authenticated: false }
          ),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // ApiKey verification — CatsCo answers who the key belongs to. Not
      // recorded, because it is the caller's identity check rather than one of
      // the two roster reads these assertions are about.
      if (target.endsWith("/api/me")) {
        return new Response(
          JSON.stringify({
            uid: 574,
            username: "bot-abraxas-5617",
            display_name: "Abraxas",
            account_type: "bot",
          }),
          { status: opts.meStatus ?? 200, headers: { "Content-Type": "application/json" } }
        );
      }

      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: target, auth: headers.Authorization ?? "" });

      if (opts.offline) throw new Error("ECONNREFUSED");

      const isFriends = target.endsWith("/api/friends");
      const status = isFriends ? opts.friendsStatus ?? 200 : opts.botsStatus ?? 200;
      const body = isFriends
        ? opts.friends ?? friendsPayload()
        : opts.bots ?? botsPayload();

      return new Response(
        JSON.stringify(status === 200 ? body : { error: "nope" }),
        { status, headers: { "Content-Type": "application/json" } }
      );
    })
  );
  return calls;
}

function getReq(credential?: string): Request {
  return new Request("http://localhost/api/friends", {
    headers: credential ? { Authorization: credential } : {},
  });
}

/** Every subjectId the roster returned, users and agents alike. */
function allIds(body: { users: Array<{ subjectId: string }>; agents: Array<{ subjectId: string }> }) {
  return [...body.users, ...body.agents].map((c) => c.subjectId);
}

let testCounter = 0;

beforeEach(async () => {
  resetDbForTests();
  process.env.SUMI_DATA_DIR = `${TEST_DIR}-${testCounter++}`;
  await fs.rm(process.env.SUMI_DATA_DIR, { recursive: true, force: true });
  process.env.CATSCO_BASE_URL = "https://catsco.example";
  delete process.env.CATSCO_ACCOUNT_TOKEN;
  delete process.env.CATSCO_ACCOUNT_UID;
  delete process.env.CATSCO_ARTIFACT_APP_ID;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("GET /api/friends — roster mapping", () => {
  it("keeps friends that expose `id` instead of `uid`", async () => {
    stubUpstreams();
    const res = await GET(getReq(`Bearer ${await userJwt(275)}`));
    expect(res.status).toBe(200);

    const body = await res.json();
    // The regression: these were all dropped, so the panel said "no friends".
    expect(allIds(body)).toContain("u363");
    expect(allIds(body)).toContain("u85");
    expect(body.users).toHaveLength(2);
  });

  it("marks a bot friend as an agent, not a user", async () => {
    stubUpstreams();
    const res = await GET(getReq(`Bearer ${await userJwt(275)}`));
    const body = await res.json();

    const abraxas = body.agents.find((c: { subjectId: string }) => c.subjectId === "a574");
    expect(abraxas).toBeDefined();
    expect(abraxas.kind).toBe("agent");
    expect(body.users.some((c: { subjectId: string }) => c.subjectId === "a574")).toBe(false);
  });

  it("lists a bot once when it appears in both rosters", async () => {
    stubUpstreams();
    const res = await GET(getReq(`Bearer ${await userJwt(275)}`));
    const body = await res.json();

    expect(allIds(body).filter((s: string) => s === "a574")).toHaveLength(1);
    // …and the bot that is mine but not a friend still shows up.
    expect(allIds(body)).toContain("a559");
  });

  it("carries avatarUrl and a usable displayName", async () => {
    stubUpstreams();
    const res = await GET(getReq(`Bearer ${await userJwt(275)}`));
    const body = await res.json();

    const abraxas = body.agents.find((c: { subjectId: string }) => c.subjectId === "a574");
    expect(abraxas.avatarUrl).toBe("/uploads/a.png");
    expect(abraxas.displayName).toBe("Abraxas");
  });

  it("falls back to the username when display_name is empty", async () => {
    stubUpstreams();
    const res = await GET(getReq(`Bearer ${await userJwt(275)}`));
    const body = await res.json();

    const yii = body.users.find((c: { subjectId: string }) => c.subjectId === "u363");
    expect(yii.displayName).toBe("Yii");
  });

  it("tolerates rows with no usable id", async () => {
    stubUpstreams({
      friends: { friends: [{ username: "ghost" }, { id: 0 }, null] },
      bots: { bots: [] },
    });
    const res = await GET(getReq(`Bearer ${await userJwt(275)}`));
    const body = await res.json();

    expect(body.users).toEqual([]);
    expect(body.agents).toEqual([]);
  });
});

describe("GET /api/friends — credentials", () => {
  it("forwards the caller's own Authorization header untouched", async () => {
    const calls = stubUpstreams();
    const jwt = await userJwt(275);
    await GET(getReq(`Bearer ${jwt}`));

    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.auth).toBe(`Bearer ${jwt}`);
  });

  it("turns a ?token= query parameter into a Bearer header", async () => {
    const calls = stubUpstreams();
    const jwt = await userJwt(275);
    const res = await GET(
      new Request(`http://localhost/api/friends?token=${jwt}`) as Request
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.auth).toBe(`Bearer ${jwt}`);
  });

  it("refuses an ApiKey caller — the roster picker is a human surface", async () => {
    // Verifying the key now works (that is what unblocks agents on the WS room),
    // but this route itself stays user-only: it feeds the "add member" picker in
    // the browser, and an agent has no business listing a human's friends.
    const calls = stubUpstreams();
    const res = await GET(getReq("ApiKey cc_test_key"));

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("user required");
    expect(calls).toHaveLength(0);
  });

  it("does not leak the roster when a key is rejected outright", async () => {
    const calls = stubUpstreams({ meStatus: 401 });
    const res = await GET(getReq("ApiKey cc_dead_key"));

    // Either refusal is fine — what must not happen is a 200 with someone's list.
    expect([403, 503]).toContain(res.status);
    expect(calls).toHaveLength(0);
  });

  it("uses the deployment credential for its own account when the caller has none", async () => {
    // Exactly the gateway-cookie browser: an actor, but no credential of its own.
    const calls = stubUpstreams();
    process.env.CATSCO_ARTIFACT_APP_ID = "sumi";
    process.env.CATSCO_ACCOUNT_TOKEN = "Bearer account-token";
    process.env.CATSCO_ACCOUNT_UID = "275";

    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.auth).toBe("Bearer account-token");
  });

  it("adds the Bearer scheme to a bare deployment token", async () => {
    // The value people paste is the token itself; sending it without a scheme
    // is a silent 401 that reads as "wrong token".
    const calls = stubUpstreams();
    process.env.CATSCO_ARTIFACT_APP_ID = "sumi";
    process.env.CATSCO_ACCOUNT_TOKEN = "eyJhbGciOiJIUzI1NiJ9.bare.token";
    process.env.CATSCO_ACCOUNT_UID = "275";

    const res = await GET(getReq());
    expect(res.status).toBe(200);
    for (const c of calls) expect(c.auth).toBe("Bearer eyJhbGciOiJIUzI1NiJ9.bare.token");
  });

  it("leaves a complete header value alone", async () => {
    const calls = stubUpstreams();
    process.env.CATSCO_ARTIFACT_APP_ID = "sumi";
    process.env.CATSCO_ACCOUNT_TOKEN = "ApiKey cc_deployment_key";
    process.env.CATSCO_ACCOUNT_UID = "275";

    const res = await GET(getReq());
    expect(res.status).toBe(200);
    for (const c of calls) expect(c.auth).toBe("ApiKey cc_deployment_key");
  });

  it("refuses the deployment credential for a different account", async () => {
    // Same gateway, but the visitor is uid 999. Handing them uid 275's friend
    // list would be a privacy leak dressed up as a fallback.
    const calls = stubUpstreams({ viewer: { uid: 999, username: "someone-else" } });
    process.env.CATSCO_ARTIFACT_APP_ID = "sumi";
    process.env.CATSCO_ACCOUNT_TOKEN = "Bearer account-token";
    process.env.CATSCO_ACCOUNT_UID = "275";

    const res = await GET(new Request("http://localhost/api/friends") as Request);
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("refuses an unlabelled deployment credential", async () => {
    const calls = stubUpstreams();
    process.env.CATSCO_ARTIFACT_APP_ID = "sumi";
    process.env.CATSCO_ACCOUNT_TOKEN = "Bearer account-token";
    delete process.env.CATSCO_ACCOUNT_UID;

    const res = await GET(getReq());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("no catsco credential");
    expect(calls).toHaveLength(0);
  });

  it("reports 503 rather than an empty roster when no credential exists", async () => {
    stubUpstreams();
    process.env.CATSCO_ARTIFACT_APP_ID = "sumi";

    const res = await GET(getReq());
    expect(res.status).toBe(503);
    const body = await res.json();
    // Crucially not 200 with empty lists — that read as "you have no friends".
    expect(body.error).toBe("no catsco credential");
    expect(body.detail).toContain("CATSCO_ACCOUNT_TOKEN");
  });

  it("rejects an anonymous caller", async () => {
    stubUpstreams({ viewer: null });
    process.env.CATSCO_ARTIFACT_APP_ID = "sumi";
    process.env.CATSCO_ACCOUNT_TOKEN = "Bearer account-token";
    process.env.CATSCO_ACCOUNT_UID = "275";

    const res = await GET(getReq());
    expect(res.status).toBe(403);
  });
});

describe("GET /api/friends — failures are not emptiness", () => {
  it("502s when both upstreams are unreachable", async () => {
    stubUpstreams({ offline: true });
    const res = await GET(getReq(`Bearer ${await userJwt(275)}`));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("catsco_unreachable");
    expect(body.users).toEqual([]);
    expect(body.agents).toEqual([]);
  });

  it("502s when both upstreams reject the credential", async () => {
    stubUpstreams({ friendsStatus: 401, botsStatus: 401 });
    const res = await GET(getReq(`Bearer ${await userJwt(275)}`));

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("catsco_unauthorized");
  });

  it("returns the half it could read, with a warning", async () => {
    stubUpstreams({ botsStatus: 401 });
    const res = await GET(getReq(`Bearer ${await userJwt(275)}`));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.length).toBeGreaterThan(0);
    expect(body.warning).toBe("catsco_bots_unavailable");
    expect(body.detail).toContain("catsco_unauthorized");
  });

  it("names the base URL it could not reach", async () => {
    stubUpstreams({ offline: true });
    const res = await GET(getReq(`Bearer ${await userJwt(275)}`));
    const body = await res.json();

    expect(body.detail).toContain("https://catsco.example");
  });

  it("does not call CatsCo twice with different credentials", async () => {
    // Guards against a regression where the fallback token was appended to a
    // per-request list rather than chosen once.
    const calls = stubUpstreams();
    process.env.CATSCO_ARTIFACT_APP_ID = "sumi";
    process.env.CATSCO_ACCOUNT_TOKEN = "Bearer account-token";
    process.env.CATSCO_ACCOUNT_UID = "275";
    await GET(getReq());

    const auths = new Set(calls.map((c) => c.auth));
    expect(auths.size).toBe(1);
  });
});

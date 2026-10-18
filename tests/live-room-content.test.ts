/**
 * Which copy of a document the read path serves.
 *
 * The room is authoritative while a client holds it open; the blob is only what a
 * fresh room seeds from. Reading the blob alone returned content up to one autosave
 * interval old after every edit, and stale indefinitely when nobody stayed
 * connected — so an applied edit could come back as if it had been reverted.
 *
 * The internal secret matters here: without it the ws-server refuses the read, the
 * caller silently falls back to the stale blob, and the bug reappears with no error
 * anywhere. That is why the header is asserted directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";

const TEST_DIR = `/tmp/sumi-live-read-test-${process.pid}`;
process.env.SUMI_DATA_DIR = TEST_DIR;
process.env.INTERNAL_API_SECRET = "test-internal-secret";
process.env.WS_PORT = "1234";

const { liveRoomContent, currentDocContent, docKey } = await import(
  "../src/doc-content"
);
const { getStorage, resetStorageForTests } = await import("../src/storage");

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Stub the ws-server document read. */
function stubRoom(handler: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return handler(String(url));
    })
  );
  return calls;
}

function roomJson(content: string): Response {
  return new Response(JSON.stringify({ content, length: content.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const P = "prj_ed691a809e5605136a9249e4";

beforeEach(async () => {
  vi.unstubAllGlobals();
  resetStorageForTests();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("liveRoomContent", () => {
  it("presents the internal secret", async () => {
    const calls = stubRoom(() => roomJson("hello"));
    await liveRoomContent(P, "notes.md");

    expect(calls).toHaveLength(1);
    expect(calls[0].headers["x-internal-secret"]).toBe("test-internal-secret");
  });

  it("returns what the room holds", async () => {
    stubRoom(() => roomJson("房间里的内容"));
    expect(await liveRoomContent(P, "notes.md")).toBe("房间里的内容");
  });

  it("treats empty room content as an answer, not as absence", async () => {
    // "" and null mean different things: an emptied document is not a missing room.
    stubRoom(() => roomJson(""));
    const result = await liveRoomContent(P, "notes.md");
    expect(result).toBe("");
    expect(result).not.toBeNull();
  });

  it("returns null when there is no room in memory", async () => {
    stubRoom(() => new Response(JSON.stringify({ error: "Document not found" }), { status: 404 }));
    expect(await liveRoomContent(P, "notes.md")).toBeNull();
  });

  it("returns null when the ws-server is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    expect(await liveRoomContent(P, "notes.md")).toBeNull();
  });

  it("addresses the ws-server, and escapes the file id", async () => {
    const calls = stubRoom(() => roomJson("x"));
    await liveRoomContent(P, "docs/intro.md");
    expect(calls[0].url).toBe(
      `http://localhost:1234/doc/${P}/docs%2Fintro.md`
    );
  });

  it("does not put the secret in the URL", async () => {
    const calls = stubRoom(() => roomJson("x"));
    await liveRoomContent(P, "notes.md");
    expect(calls[0].url).not.toContain("test-internal-secret");
  });
});

describe("currentDocContent", () => {
  it("prefers the live room over a stale blob", async () => {
    // The regression this whole fix exists for: the blob lags, the room does not.
    const storage = await getStorage();
    await storage.upload(docKey(P, "notes.md"), "旧内容", "text/markdown");

    stubRoom(() => roomJson("刚改的内容"));
    expect(await currentDocContent(P, "notes.md")).toBe("刚改的内容");
  });

  it("falls back to the blob when no room is open", async () => {
    const storage = await getStorage();
    await storage.upload(docKey(P, "notes.md"), "落盘内容", "text/markdown");

    stubRoom(() => new Response("{}", { status: 404 }));
    expect(await currentDocContent(P, "notes.md")).toBe("落盘内容");
  });

  it("falls back to the blob when the ws-server is down", async () => {
    const storage = await getStorage();
    await storage.upload(docKey(P, "notes.md"), "落盘内容", "text/markdown");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    expect(await currentDocContent(P, "notes.md")).toBe("落盘内容");
  });

  it("returns null when neither copy exists", async () => {
    stubRoom(() => new Response("{}", { status: 404 }));
    expect(await currentDocContent(P, "missing.md")).toBeNull();
  });
});

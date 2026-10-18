/**
 * The document size ceiling.
 *
 * One runaway room reached 90 MB on disk and 33 M characters in memory before
 * anyone noticed, so the guard exists to turn "grows until something breaks" into
 * "stops and says so". The boundary cases matter more than the happy path: the
 * limit is in bytes (CJK is 3 bytes per character in UTF-8), and hitting it must
 * block the write without touching the room or the stored copy.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import * as Y from "yjs";

const TEST_DIR = `/tmp/sumi-size-guard-test-${process.pid}`;
process.env.SUMI_DATA_DIR = TEST_DIR;

const { getStorage, resetStorageForTests } = await import("../src/storage");
const { persistRoomToStorage, docStorageKey, MAX_PERSIST_BYTES, exceedsPersistLimit } =
  await import("../src/server/room-persistence");

const ROOM = "prj_ed691a809e5605136a9249e4-notes.md";
const PROJECT = "prj_ed691a809e5605136a9249e4";

function makeDoc(text: string): Y.Doc {
  const doc = new Y.Doc();
  if (text) doc.getText("content").insert(0, text);
  return doc;
}

async function readBlob(): Promise<string | null> {
  const storage = await getStorage();
  const key = docStorageKey(PROJECT, "notes.md");
  if (!(await storage.exists(key))) return null;
  return (await storage.download(key)).toString("utf8");
}

beforeEach(async () => {
  vi.restoreAllMocks();
  resetStorageForTests();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("exceedsPersistLimit", () => {
  it("allows ordinary documents", () => {
    expect(exceedsPersistLimit("")).toBe(false);
    expect(exceedsPersistLimit("一篇很短的笔记")).toBe(false);
    expect(exceedsPersistLimit("x".repeat(100_000))).toBe(false);
  });

  it("measures bytes, not characters", () => {
    // 4 MB of limit; 2 M CJK characters are ~6 MB of UTF-8, over the line despite
    // being fewer "characters" than the limit suggests.
    const cjk = "字".repeat(MAX_PERSIST_BYTES / 3 + 1000);
    expect(cjk.length).toBeLessThan(MAX_PERSIST_BYTES);
    expect(exceedsPersistLimit(cjk)).toBe(true);
  });

  it("refuses the size that actually occurred", () => {
    // The real escape was ~33 M characters.
    expect(exceedsPersistLimit("a".repeat(33_000_000))).toBe(true);
  });

  it("is exactly at the boundary, not near it", () => {
    expect(exceedsPersistLimit("a".repeat(MAX_PERSIST_BYTES))).toBe(false);
    expect(exceedsPersistLimit("a".repeat(MAX_PERSIST_BYTES + 1))).toBe(true);
  });
});

describe("persistRoomToStorage under the ceiling", () => {
  it("still writes a normal document", async () => {
    expect(await persistRoomToStorage(ROOM, makeDoc("正常内容"), { trustEmpty: true })).toBe(
      "written"
    );
    expect(await readBlob()).toBe("正常内容");
  });

  it("refuses an oversized write and leaves the stored copy alone", async () => {
    // Existing, sane content must survive a runaway room.
    await persistRoomToStorage(ROOM, makeDoc("原有内容"), { trustEmpty: true });
    expect(await readBlob()).toBe("原有内容");

    const huge = "膨胀".repeat(3_000_000); // ~18 MB of UTF-8
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await persistRoomToStorage(ROOM, makeDoc(huge), { trustEmpty: true })).toBe(
      "skipped"
    );
    expect(await readBlob()).toBe("原有内容");
  });

  it("says why it refused", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await persistRoomToStorage(ROOM, makeDoc("膨胀".repeat(3_000_000)), {
      trustEmpty: true,
    });
    expect(spy).toHaveBeenCalled();
    const msg = String(spy.mock.calls[0][0]);
    expect(msg).toContain("refusing to persist");
    expect(msg).toContain("SUMI_MAX_DOC_BYTES");
  });

  it("checks the ceiling before creating a file that never existed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await persistRoomToStorage(ROOM, makeDoc("膨胀".repeat(3_000_000)), {
      trustEmpty: true,
    });
    expect(await readBlob()).toBeNull();
  });
});

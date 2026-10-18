/**
 * Keeping a room and its persisted blob in step.
 *
 * Without Redis the room is the only copy of an edit until a client's autosave
 * writes the blob, and the room is destroyed when its last client leaves. Two
 * directions matter, and both have a way to lose data if they are careless:
 *
 *   seedRoomFromStorage   — must never let "no document yet" pass as "blank"
 *   persistRoomToStorage  — must never let an unseeded empty room erase a file
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { promises as fs } from "fs";
import * as Y from "yjs";

const TEST_DIR = `/tmp/sumi-room-persist-test-${process.pid}`;
process.env.SUMI_DATA_DIR = TEST_DIR;

const { getStorage, resetStorageForTests } = await import("../src/storage");
const { persistRoomToStorage, seedRoomFromStorage, docStorageKey } = await import(
  "../src/server/room-persistence"
);

const ROOM = "prj_ed691a809e5605136a9249e4-notes.md";
const PROJECT = "prj_ed691a809e5605136a9249e4";

function makeDoc(text: string): Y.Doc {
  const doc = new Y.Doc();
  if (text) doc.getText("content").insert(0, text);
  return doc;
}

async function putBlob(projectId: string, fileId: string, content: string) {
  const storage = await getStorage();
  await storage.upload(docStorageKey(projectId, fileId), content, "text/markdown");
}

async function readBlob(projectId: string, fileId: string): Promise<string | null> {
  const storage = await getStorage();
  const key = docStorageKey(projectId, fileId);
  if (!(await storage.exists(key))) return null;
  return (await storage.download(key)).toString("utf8");
}

beforeEach(async () => {
  vi.restoreAllMocks();
  resetStorageForTests();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("seedRoomFromStorage", () => {
  it("fills an empty room from the blob", async () => {
    await putBlob(PROJECT, "notes.md", "# 调试笔记\n正文");
    const doc = makeDoc("");

    expect(await seedRoomFromStorage(ROOM, doc)).toBe(true);
    expect(doc.getText("content").toString()).toBe("# 调试笔记\n正文");
  });

  it("reports no baseline when there is no blob yet", async () => {
    // A brand-new document. The room stays empty and, crucially, the caller is
    // told not to treat that emptiness as the document's content.
    const doc = makeDoc("");
    expect(await seedRoomFromStorage(ROOM, doc)).toBe(false);
    expect(doc.getText("content").toString()).toBe("");
  });

  it("treats an existing but empty blob as a known baseline", async () => {
    await putBlob(PROJECT, "notes.md", "");
    const doc = makeDoc("");
    expect(await seedRoomFromStorage(ROOM, doc)).toBe(true);
    expect(doc.getText("content").toString()).toBe("");
  });

  it("leaves a room that already has content alone", async () => {
    // The Redis-restore case: state came from elsewhere, do not append to it.
    await putBlob(PROJECT, "notes.md", "落盘内容");
    const doc = makeDoc("房间已有内容");

    expect(await seedRoomFromStorage(ROOM, doc)).toBe(true);
    expect(doc.getText("content").toString()).toBe("房间已有内容");
  });

  it("reports no baseline when the blob cannot be read", async () => {
    const storage = await getStorage();
    vi.spyOn(storage, "exists").mockRejectedValueOnce(new Error("boom"));

    // Not knowing the baseline must not be reported as "the document is empty".
    expect(await seedRoomFromStorage(ROOM, makeDoc(""))).toBe(false);
  });

  it("seeds nothing for a name it cannot attribute", async () => {
    expect(await seedRoomFromStorage("chat-room", makeDoc(""))).toBe(false);
  });

  it("seeds nested paths", async () => {
    await putBlob(PROJECT, "docs/intro.md", "嵌套内容");
    const doc = makeDoc("");
    expect(await seedRoomFromStorage(`${PROJECT}-docs/intro.md`, doc)).toBe(true);
    expect(doc.getText("content").toString()).toBe("嵌套内容");
  });
});

// ---------------------------------------------------------------------------

describe("persistRoomToStorage", () => {
  it("writes the room's text when the blob is behind", async () => {
    const outcome = await persistRoomToStorage(ROOM, makeDoc("# 调试笔记\n正文"), {
      trustEmpty: true,
    });
    expect(outcome).toBe("written");
    expect(await readBlob(PROJECT, "notes.md")).toBe("# 调试笔记\n正文");
  });

  it("overwrites an older blob — that is the whole point", async () => {
    await putBlob(PROJECT, "notes.md", "旧内容");
    const outcome = await persistRoomToStorage(ROOM, makeDoc("新内容"), {
      trustEmpty: true,
    });
    expect(outcome).toBe("written");
    expect(await readBlob(PROJECT, "notes.md")).toBe("新内容");
  });

  it("reports unchanged rather than rewriting identical content", async () => {
    await putBlob(PROJECT, "notes.md", "一样的内容");
    expect(
      await persistRoomToStorage(ROOM, makeDoc("一样的内容"), { trustEmpty: true })
    ).toBe("unchanged");
  });

  it("does not create a document for an untouched room", async () => {
    const outcome = await persistRoomToStorage(ROOM, makeDoc(""), {
      trustEmpty: false,
    });
    expect(outcome).toBe("skipped");
    expect(await readBlob(PROJECT, "notes.md")).toBeNull();
  });

  it("never lets an unseeded empty room erase a real document", async () => {
    // The dangerous combination: a room that never learned the document's state
    // (RelPos enrichment creates rooms this way) closing while empty. Erasing here
    // would destroy the file with nobody having asked for it.
    await putBlob(PROJECT, "notes.md", "不该被抹掉的内容");
    const outcome = await persistRoomToStorage(ROOM, makeDoc(""), {
      trustEmpty: false,
    });
    expect(outcome).toBe("skipped");
    expect(await readBlob(PROJECT, "notes.md")).toBe("不该被抹掉的内容");
  });

  it("does persist an intentional emptying by a room that knew the document", async () => {
    // Deleting everything is a real edit; refusing to store it would resurrect the
    // content on the next open.
    await putBlob(PROJECT, "notes.md", "要被删掉的内容");
    const outcome = await persistRoomToStorage(ROOM, makeDoc(""), {
      trustEmpty: true,
    });
    expect(outcome).toBe("written");
    expect(await readBlob(PROJECT, "notes.md")).toBe("");
  });

  it("skips a name it cannot attribute to a project", async () => {
    expect(
      await persistRoomToStorage("chat-room", makeDoc("内容"), { trustEmpty: true })
    ).toBe("skipped");
    expect(
      await persistRoomToStorage("project-thing", makeDoc("内容"), { trustEmpty: true })
    ).toBe("skipped");
  });

  it("keys the blob the same way the rest of the code does", () => {
    expect(docStorageKey("prj_a", "notes.md")).toBe("sumi/prj_a/files/notes.md");
    expect(docStorageKey("prj_a", "docs/intro.md")).toBe(
      "sumi/prj_a/files/docs/intro.md"
    );
  });

  it("uses the file id from the room name, including nested paths", async () => {
    const outcome = await persistRoomToStorage(
      `${PROJECT}-docs/intro.md`,
      makeDoc("嵌套路径"),
      { trustEmpty: true }
    );
    expect(outcome).toBe("written");
    expect(await readBlob(PROJECT, "docs/intro.md")).toBe("嵌套路径");
  });

  it("keeps the two documents in a project apart", async () => {
    await persistRoomToStorage(`${PROJECT}-a.md`, makeDoc("AAA"), { trustEmpty: true });
    await persistRoomToStorage(`${PROJECT}-b.md`, makeDoc("BBB"), { trustEmpty: true });
    expect(await readBlob(PROJECT, "a.md")).toBe("AAA");
    expect(await readBlob(PROJECT, "b.md")).toBe("BBB");
  });

  it("round-trips: seed, edit, flush, seed again", async () => {
    // The whole point of the pair, in one sequence.
    await putBlob(PROJECT, "notes.md", "第一版");

    const first = makeDoc("");
    expect(await seedRoomFromStorage(ROOM, first)).toBe(true);
    expect(first.getText("content").toString()).toBe("第一版");

    first.getText("content").insert(0, "第二版\n");
    expect(await persistRoomToStorage(ROOM, first, { trustEmpty: true })).toBe(
      "written"
    );

    const second = makeDoc("");
    await seedRoomFromStorage(ROOM, second);
    expect(second.getText("content").toString()).toBe("第二版\n第一版");
  });
});

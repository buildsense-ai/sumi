/**
 * Keeping a room and its persisted blob in step.
 *
 * Two functions, and both are needed for the same reason: without Redis the room
 * is the only copy of an edit until a client's autosave writes the blob, and the
 * room is destroyed as soon as its last client leaves.
 *
 *   seedRoomFromStorage    — a new room starts from the blob, never from nothing
 *   persistRoomToStorage   — a closing room writes its text back to the blob
 *
 * The seeding half is not optional. Rooms are created by any code path that asks
 * for the doc, including the RelPos enrichment on the propose-edit route, so a room
 * could spring into existence with no client anywhere near it. An unseeded room is
 * an *empty* room that the rest of the system treats as authoritative, which turns
 * "propose an edit while nobody is looking" into "the document is blank".
 *
 * Lives in its own module rather than inside the ws-server so it can be tested
 * without starting a server — the ws-server listens on import.
 */

import type * as Y from "yjs";
import { parseRoomName } from "./yjs-persistence";
import { getStorage } from "../storage";

export type FlushOutcome = "written" | "unchanged" | "skipped";

/**
 * Refuse to persist a document beyond this size.
 *
 * A runaway can't be diagnosed from inside the process that is producing it, and
 * the failure mode is severe: one inflated room reached 90 MB on disk and 33 M
 * characters in memory, which is both a storage problem and a memory one. A ceiling
 * turns "grows until something breaks" into "stops and says so".
 *
 * Generous for markdown (4 MB is far past any real note), overridable, and it only
 * ever blocks a write — reads and edits in the editor keep working.
 */
export const MAX_PERSIST_BYTES = Number(
  process.env.SUMI_MAX_DOC_BYTES || 4 * 1024 * 1024
);

/** True when this content is too large to be a real document. */
export function exceedsPersistLimit(content: string): boolean {
  // Byte length, not character count: the limit protects storage, and CJK text is
  // 3 bytes per character in UTF-8.
  return Buffer.byteLength(content, "utf8") > MAX_PERSIST_BYTES;
}

/** Storage key for a document's canonical blob. */
export function docStorageKey(projectId: string, fileId: string): string {
  return `sumi/${projectId}/files/${fileId}`;
}

async function readBlob(
  docName: string
): Promise<{ key: string; content: string } | null> {
  const parsed = parseRoomName(docName);
  if (!parsed) return null;
  const { projectId, fileId } = parsed;
  const key = docStorageKey(projectId, fileId);
  const storage = await getStorage();
  if (!(await storage.exists(key))) return null;
  return { key, content: (await storage.download(key)).toString("utf8") };
}

/**
 * Populate an empty room from its persisted blob.
 *
 * Returns whether the room now has a known baseline — true when it already had
 * content (restored from Redis), when a blob was loaded, or when a blob exists and
 * is legitimately empty. False means "there is no document yet", which the caller
 * needs in order to know that an empty room is not an instruction to erase
 * anything.
 */
export async function seedRoomFromStorage(
  docName: string,
  doc: Y.Doc
): Promise<boolean> {
  const ytext = doc.getText("content");
  if (ytext.length > 0) return true;

  try {
    const blob = await readBlob(docName);
    if (!blob) return false;
    if (blob.content.length > 0) ytext.insert(0, blob.content);
    return true;
  } catch (err) {
    console.error(`❌ seed ${docName} failed:`, err);
    // Treat a failed read as "unknown", not as "empty": a caller that cannot read
    // the baseline must not be allowed to conclude the document is blank.
    return false;
  }
}

/**
 * Write the room's text back to the blob.
 *
 * Three outcomes, distinguished so a caller can tell "nothing to do" from
 * "the write failed":
 *   written   — content differed and was stored
 *   unchanged — the blob already holds this text
 *   skipped   — nothing worth storing
 *
 * `trustEmpty` is the guard that keeps this from erasing a document. Empty content
 * means "the user deleted everything" only when the room had a baseline to delete
 * from; in a room that was never seeded, empty means "nobody has written yet", and
 * storing it would replace a real document with nothing.
 */
export async function persistRoomToStorage(
  docName: string,
  doc: Y.Doc,
  opts: { trustEmpty: boolean }
): Promise<FlushOutcome> {
  const parsed = parseRoomName(docName);
  if (!parsed) return "skipped";

  const content = doc.getText("content").toString();
  if (content.length === 0 && !opts.trustEmpty) return "skipped";

  if (exceedsPersistLimit(content)) {
    console.error(
      `❌ refusing to persist ${docName}: ${Buffer.byteLength(content, "utf8")} bytes ` +
        `exceeds SUMI_MAX_DOC_BYTES (${MAX_PERSIST_BYTES}). The in-memory room is left ` +
        `untouched; the stored copy stays as it was.`
    );
    return "skipped";
  }

  const { projectId, fileId } = parsed;
  const key = docStorageKey(projectId, fileId);
  const storage = await getStorage();
  const exists = await storage.exists(key);

  // Nothing to create and nothing to erase.
  if (!exists && content.length === 0) return "skipped";

  if (exists) {
    const current = (await storage.download(key)).toString("utf8");
    if (current === content) return "unchanged";
  }

  await storage.upload(key, content, "text/markdown");
  return "written";
}

/**
 * Sumi Yjs WebSocket collaboration server.
 *
 * Based on a distilled Yjs sync server — keeps:
 *   - y-protocols sync + awareness
 *   - Redis persistence (optional via REDIS_URL)
 *   - Internal HTTP admin surface (/clear, /replace, /doc, /rooms,
 *     /relpos, /update-line-numbers, /locks, /vibe-lock, /admin/clear-project)
 *   - Agent auth token (viewer role drops write messages)
 *   - Heartbeat, init-in-flight tracking, zombie-connection guards
 *
 * Drops:
 *   - chat room broadcasting (kept out of scope for Sumi)
 *   - LaTeX / SyncTeX specifics
 *   - any UI markup (it's transport only)
 *
 * Run:
 *   pnpm ws-server         # once
 *   pnpm dev               # tsx watch
 *
 * Env:
 *   WS_PORT                  (default 12345)
 *   REDIS_URL                optional — enables persistence
 *   INTERNAL_API_SECRET      required for /clear, /replace, /admin/* and agent tokens
 *   WS_AGENT_TOKEN_SECRET    overrides INTERNAL_API_SECRET for agent-token signing
 */

import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import {
  parseRoomName,
  restoreDocument,
  bindDocumentToPersistence,
  clearPersistence,
  closeAllPersistence,
} from "./yjs-persistence";
import { createRelPosForEdit, getLineFromRelPos } from "./edit-position-tracker";
import { persistRoomToStorage, seedRoomFromStorage } from "./room-persistence";
import { getDb } from "../db";
import { getStorage } from "../storage";
import {
  resolveActor,
  projectRoleFor,
  type Actor,
  type EffectiveRole,
} from "../auth/actor";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 12345;
/**
 * Opt-in CORS. The management surface used to answer every origin with `*`,
 * which let any page read the admin endpoints from a browser. WebSocket clients
 * are unaffected by CORS, so real-time collaboration does not need it.
 * Set `WS_CORS_ORIGIN` to one exact origin when a browser really must call the
 * HTTP surface cross-origin.
 */
const CORS_ORIGIN = process.env.WS_CORS_ORIGIN || "";
const HEARTBEAT_INTERVAL_MS = 30_000;
const EMPTY_DOC_CLEANUP_DELAY_MS = 5 * 60_000;
const INIT_ORPHAN_CLEANUP_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const messageSync = 0;
const messageAwareness = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentSocketContext {
  /** principal kind — 'user' for human sockets, 'agent' for machine */
  kind: "user" | "agent";
  /** sumi subject id — "u{uid}" or "a{uid}" */
  actorId: string;
  /** display name for awareness */
  actorName: string;
  /** the project this socket is bound to */
  projectId: string;
  /** derived role for this socket on this project */
  effectiveRole: "viewer" | "editor" | "owner";
}

type TrackedWebSocket = WebSocket & {
  isAlive?: boolean;
  agentContext?: AgentSocketContext | null;
};

interface DocData {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<WebSocket>;
  persistenceCleanup?: () => void;
  /**
   * Whether this room knows the document's real state — restored from Redis, or
   * seeded from the persisted blob, or the blob genuinely held an empty document.
   *
   * An unseeded room is not "an empty document"; it is a room nobody has written
   * to yet. The distinction is what stops a closing room from erasing a real file.
   */
  baselineKnown: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const docs = new Map<string, DocData>();
const initializingDocs = new Map<string, Promise<DocData>>();

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function requireInternalSecret(req: http.IncomingMessage): boolean {
  const expected = process.env.INTERNAL_API_SECRET || "";
  if (!expected) return false;
  const provided = (req.headers["x-internal-secret"] as string | undefined) || "";
  if (!provided) return false;
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function requireInternalSecretOrReply(
  req: http.IncomingMessage,
  res: http.ServerResponse
): boolean {
  if (!process.env.INTERNAL_API_SECRET) {
    sendJson(res, 500, { error: "INTERNAL_API_SECRET not configured" });
    return false;
  }
  if (!requireInternalSecret(req)) {
    sendJson(res, 401, { error: "Invalid internal secret" });
    return false;
  }
  return true;
}

type DocAccess =
  | { via: "secret" }
  | { via: "actor"; actor: Actor; role: EffectiveRole };

/**
 * Gate for the per-document management routes.
 *
 * Accepts either the internal secret (server-to-server callers and agent CLIs)
 * or a resolved CatsCo actor that actually holds a role on the project named in
 * the URL. Callers that present neither get a 401 and the route does not run.
 *
 * Returns null when access was refused; the reply has already been sent.
 */
async function requireDocAccessOrReply(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  projectId: string
): Promise<DocAccess | null> {
  // Internal secret stays a full-access path — it is how the Next.js layer and
  // the agent CLIs reach this surface.
  if (requireInternalSecret(req)) return { via: "secret" };

  let url: URL;
  try {
    url = new URL(req.url || "/", "http://localhost");
  } catch {
    sendJson(res, 400, { error: "Bad request URL" });
    return null;
  }

  try {
    const db = await getDb();
    const actor = await resolveActor(db, req, url);
    const role = actor ? projectRoleFor(db, projectId, actor.id) : null;
    if (actor && role) {
      return { via: "actor", actor, role };
    }
  } catch (err) {
    console.error("❌ management auth failed:", err);
  }

  sendJson(res, 401, { error: "unauthorized" });
  return null;
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

async function getYDoc(docName: string): Promise<DocData> {
  const existing = docs.get(docName);
  if (existing) return existing;

  const inflight = initializingDocs.get(docName);
  if (inflight) return inflight;

  const initPromise = (async (): Promise<DocData> => {
    try {
      const doc = new Y.Doc();
      const awareness = new awarenessProtocol.Awareness(doc);
      let persistenceCleanup: (() => void) | undefined;

      const parsed = parseRoomName(docName);
      let baselineKnown = false;
      if (parsed) {
        const { projectId, fileId } = parsed;
        const restored = await restoreDocument(doc, projectId, fileId);
        if (restored) {
          console.log(`📥 restored ${docName}`);
          baselineKnown = true;
        } else {
          // No Redis in this deployment, so the persisted blob is the baseline a
          // fresh room starts from. Seeding is not optional: rooms are created by
          // any code path that asks for the doc — the RelPos enrichment on the
          // propose-edit route, for one — so without it a room could appear, hold
          // nothing, and be treated as authoritative, blanking the document for
          // everyone who reads next.
          baselineKnown = await seedRoomFromStorage(docName, doc);
          if (baselineKnown && doc.getText("content").length > 0) {
            console.log(`🌱 seeded ${docName} from storage`);
          }
        }
        persistenceCleanup = bindDocumentToPersistence(doc, projectId, fileId);
      } else {
        console.warn(`⚠️ unparsable room name (no persistence): ${docName}`);
      }

      // Relay awareness updates to all clients in this room.
      awareness.on(
        "update",
        ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
          const changed = added.concat(updated).concat(removed);
          const docData = docs.get(docName);
          if (!docData) return;
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, messageAwareness);
          encoding.writeVarUint8Array(
            enc,
            awarenessProtocol.encodeAwarenessUpdate(awareness, changed)
          );
          const msg = encoding.toUint8Array(enc);
          docData.clients.forEach((c) => {
            if (c.readyState === WebSocket.OPEN) c.send(msg);
          });
        }
      );

      const docData: DocData = {
        doc,
        awareness,
        clients: new Set(),
        persistenceCleanup,
        baselineKnown,
      };
      docs.set(docName, docData);
      return docData;
    } finally {
      initializingDocs.delete(docName);
    }
  })();

  initializingDocs.set(docName, initPromise);
  return initPromise;
}

/** Await any in-flight init so callers never operate on a stale snapshot. */
async function resolveDocData(roomName: string): Promise<DocData | null> {
  const existing = docs.get(roomName);
  if (existing) return existing;
  const inflight = initializingDocs.get(roomName);
  if (!inflight) return null;
  try {
    return await inflight;
  } catch {
    return null;
  }
}

function cleanupDocIfEmpty(docName: string): void {
  const docData = docs.get(docName);
  if (!docData || docData.clients.size > 0) return;

  // Flush first, tear down second — see room-persistence.ts for why the order
  // matters. This runs before destroying the doc so the content still exists at
  // the moment it is written.
  void persistRoomToStorage(docName, docData.doc, {
    // Only a room that knew the document may write an empty one back — otherwise
    // "nobody has written yet" would be stored as "the document is blank".
    trustEmpty: docData.baselineKnown,
  })
    .then((outcome) => {
      if (outcome === "written") console.log(`💾 flushed ${docName} to storage`);
    })
    .catch((err) => console.error(`❌ flush ${docName} failed:`, err))
    .finally(() => {
    // Re-check: a client may have reconnected while the flush was in flight, in
    // which case the room is live again and must not be destroyed underneath it.
    const current = docs.get(docName);
    if (current !== docData || current.clients.size > 0) return;
    current.persistenceCleanup?.();
    current.doc.destroy();
    docs.delete(docName);
    console.log(`🧹 cleaned empty doc: ${docName}`);
  });
}

// ---------------------------------------------------------------------------
// HTTP admin surface
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  if (CORS_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-internal-secret");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(CORS_ORIGIN ? 200 : 204);
    res.end();
    return;
  }

  const url = req.url || "";

  // -- POST /admin/clear-project/:projectId ----------------------------------
  const clearProjectMatch = url.match(/^\/admin\/clear-project\/([^/]+)$/);
  if (req.method === "POST" && clearProjectMatch) {
    if (!requireInternalSecretOrReply(req, res)) return;
    const [, projectId] = clearProjectMatch;

    const prefix = `${projectId}-`;
    const matches = (name: string) =>
      name === projectId || name.startsWith(prefix) || name.startsWith(`ws/${prefix}`);

    const docNames = new Set([
      ...Array.from(docs.keys()).filter(matches),
      ...Array.from(initializingDocs.keys()).filter(matches),
    ]);

    let closedClients = 0;
    let clearedDocs = 0;

    for (const docName of docNames) {
      const docData = await resolveDocData(docName);
      if (!docData) continue;
      docData.clients.forEach((client) => {
        try {
          if (client.readyState === WebSocket.OPEN) {
            closedClients++;
            client.close(4001, "version_restore");
          }
        } catch { /* ignore */ }
      });
      try { docData.persistenceCleanup?.(); } catch { /* ignore */ }
      try { docData.doc.destroy(); } catch { /* ignore */ }
      docs.delete(docName);
      initializingDocs.delete(docName);
      clearedDocs++;
    }

    sendJson(res, 200, { success: true, projectId, clearedDocs, closedClients });
    return;
  }

  // -- POST /clear/:projectId/:fileId ---------------------------------------
  const clearMatch = url.match(/^\/clear\/([^/]+)\/(.+)$/);
  if (req.method === "POST" && clearMatch) {
    if (!requireInternalSecretOrReply(req, res)) return;
    const [, projectId, fileId] = clearMatch;
    const decodedFileId = decodeURIComponent(fileId);
    const roomName = `${projectId}-${decodedFileId}`;

    try {
      const docData = await resolveDocData(roomName);
      if (docData) {
        // Unbind persistence first so we don't race a write-back to Redis.
        try { docData.persistenceCleanup?.(); } catch { /* ignore */ }
        docData.clients.forEach((client) => {
          try { client.close(); } catch { /* ignore */ }
        });
        try { docData.doc.destroy(); } catch { /* ignore */ }
        docs.delete(roomName);
      }
      await clearPersistence(projectId, decodedFileId);
      console.log(`🧹 /clear ${roomName}, memory=${!!docData}`);
      sendJson(res, 200, { success: true, roomName, clearedMemory: !!docData });
    } catch (err) {
      console.error("❌ /clear failed:", err);
      sendJson(res, 500, { success: false, error: "Failed to clear document" });
    }
    return;
  }

  // -- POST /replace/:projectId/:fileId -------------------------------------
  // Force-set the Y.Text content — used when a non-client actor wrote to disk
  // and we want the change to reach all connected browsers through sync.
  const replaceMatch = url.match(/^\/replace\/([^/]+)\/(.+)$/);
  if (req.method === "POST" && replaceMatch) {
    if (!requireInternalSecretOrReply(req, res)) return;
    const [, projectId, fileId] = replaceMatch;
    const decodedFileId = decodeURIComponent(fileId);
    const roomName = `${projectId}-${decodedFileId}`;

    const body = await readBody(req);
    try {
      const { content } = JSON.parse(body) as { content: string };
      if (typeof content !== "string") {
        sendJson(res, 400, { error: "content must be a string" });
        return;
      }
      const docData = await resolveDocData(roomName);
      if (docData) {
        const ytext = docData.doc.getText("content");
        docData.doc.transact(() => {
          ytext.delete(0, ytext.length);
          ytext.insert(0, content);
        });
        console.log(`🔄 /replace ${roomName}, ${content.length} chars, clients=${docData.clients.size}`);
      } else {
        // No in-memory doc: drop stale persistence so next connect re-reads from disk.
        await clearPersistence(projectId, decodedFileId);
      }
      sendJson(res, 200, {
        success: true,
        roomName,
        inMemory: !!docData,
        contentLength: content.length,
      });
    } catch (err) {
      console.error("❌ /replace failed:", err);
      sendJson(res, 500, { success: false, error: "Failed to replace document" });
    }
    return;
  }

  // -- GET /doc/:projectId/:fileId ------------------------------------------
  const docMatch = url.match(/^\/doc\/([^/]+)\/(.+)$/);
  if (req.method === "GET" && docMatch) {
    const [, projectId, fileId] = docMatch;
    const access = await requireDocAccessOrReply(req, res, projectId);
    if (!access) return;
    const decodedFileId = decodeURIComponent(fileId);
    const roomName = `${projectId}-${decodedFileId}`;
    const docData = await resolveDocData(roomName);
    if (!docData) {
      sendJson(res, 404, {
        error: "Document not found",
        roomName,
      });
      return;
    }
    const content = docData.doc.getText("content").toString();
    sendJson(res, 200, {
      projectId,
      fileId: decodedFileId,
      content,
      length: content.length,
    });
    return;
  }

  // -- POST /doc/:projectId/:fileId — apply line-based edit blocks ----------
  if (req.method === "POST" && docMatch) {
    const [, projectId, fileId] = docMatch;
    const access = await requireDocAccessOrReply(req, res, projectId);
    if (!access) return;
    if (access.via === "actor" && access.role === "viewer") {
      sendJson(res, 403, { error: "editor role required" });
      return;
    }
    const decodedFileId = decodeURIComponent(fileId);
    const roomName = `${projectId}-${decodedFileId}`;
    const body = await readBody(req);
    try {
      const { blocks } = JSON.parse(body) as {
        blocks?: Array<{
          startLine: number;
          endLine: number;
          updated: string;
          startRelPos?: object;
          endRelPos?: object;
        }>;
      };
      const docData = await resolveDocData(roomName);
      if (!docData) {
        // Nothing was written, and the caller must be able to tell.
        //
        // This used to answer `{success: true}` with a message saying no update
        // was needed. A caller reading `success` concluded the edit had landed
        // and marked it applied, while the document was untouched: with no
        // client holding the room open there is no in-memory doc to mutate, and
        // a line-based block cannot be applied without one. `applied: 0` plus
        // `inMemory: false` gives the caller what it needs to fall back to the
        // persisted blob instead of reporting a success that did not happen.
        sendJson(res, 200, {
          success: false,
          inMemory: false,
          applied: 0,
          message:
            "Document not in memory; no blocks applied. Apply to the persisted content instead.",
        });
        return;
      }
      const ytext = docData.doc.getText("content");

      if (blocks && Array.isArray(blocks)) {
        // Re-resolve RelPos anchors to current line numbers when available.
        // Falling back to raw line numbers when the block carries no anchors.
        const resolved = blocks.map((b) => {
          if (b.startRelPos && b.endRelPos) {
            const s = getLineFromRelPos(docData.doc, ytext, b.startRelPos);
            const e = getLineFromRelPos(docData.doc, ytext, b.endRelPos);
            if (s && e && s <= e) {
              return { ...b, startLine: s, endLine: e };
            }
          }
          return b;
        });
        // Apply bottom-up so earlier offsets stay valid.
        const sorted = [...resolved].sort((a, b) => b.startLine - a.startLine);
        docData.doc.transact(() => {
          for (const block of sorted) {
            const content = ytext.toString();
            const lines = content.split("\n");
            const startIdx = block.startLine - 1;
            const endIdx = block.endLine - 1;
            if (startIdx < 0 || endIdx >= lines.length || startIdx > endIdx) {
              console.warn(`invalid line range: ${block.startLine}-${block.endLine}`);
              continue;
            }
            let fromOffset = 0;
            for (let i = 0; i < startIdx; i++) fromOffset += lines[i].length + 1;
            let toOffset = fromOffset;
            for (let i = startIdx; i <= endIdx; i++) {
              toOffset += lines[i].length;
              if (i < lines.length - 1) toOffset += 1;
            }
            let insert = block.updated;
            const replacingLastLine = endIdx === lines.length - 1;
            if (!replacingLastLine && !insert.endsWith("\n")) insert += "\n";
            ytext.delete(fromOffset, toOffset - fromOffset);
            ytext.insert(fromOffset, insert);
          }
        });
        console.log(`✏️ blocks applied: ${roomName}`);
        sendJson(res, 200, {
          success: true,
          inMemory: true,
          applied: Array.isArray(blocks) ? blocks.length : 0,
          roomName,
        });
      } else {
        sendJson(res, 200, {
          success: false,
          inMemory: true,
          applied: 0,
          roomName,
          message: "No blocks supplied",
        });
      }
    } catch (err) {
      console.error("❌ POST /doc failed:", err);
      sendJson(res, 500, { error: "Failed to update document" });
    }
    return;
  }

  // -- POST /relpos/:projectId/:fileId — compute RelPos anchors -------------
  const relposMatch = url.match(/^\/relpos\/([^/]+)\/(.+)$/);
  if (req.method === "POST" && relposMatch) {
    const [, projectId, fileId] = relposMatch;
    const access = await requireDocAccessOrReply(req, res, projectId);
    if (!access) return;
    const decodedFileId = decodeURIComponent(fileId);
    const roomName = `${projectId}-${decodedFileId}`;
    const body = await readBody(req);
    try {
      const { blocks } = JSON.parse(body) as {
        blocks: Array<{ startLine: number; endLine: number; updated: string }>;
      };
      const docData = await getYDoc(roomName);
      const ytext = docData.doc.getText("content");
      const result = blocks.map((block) => {
        const { startRelPos, endRelPos } = createRelPosForEdit(
          ytext,
          block.startLine,
          block.endLine
        );
        return { ...block, startRelPos, endRelPos };
      });
      sendJson(res, 200, { success: true, blocks: result });
    } catch (err) {
      console.error("❌ /relpos failed:", err);
      sendJson(res, 500, { error: "Failed to calculate RelativePosition" });
    }
    return;
  }

  // -- POST /update-line-numbers/:projectId/:fileId -------------------------
  const updateLinesMatch = url.match(/^\/update-line-numbers\/([^/]+)\/(.+)$/);
  if (req.method === "POST" && updateLinesMatch) {
    const [, projectId, fileId] = updateLinesMatch;
    const access = await requireDocAccessOrReply(req, res, projectId);
    if (!access) return;
    const decodedFileId = decodeURIComponent(fileId);
    const roomName = `${projectId}-${decodedFileId}`;
    const body = await readBody(req);
    try {
      const { blocks } = JSON.parse(body) as {
        blocks: Array<{
          startLine: number;
          endLine: number;
          updated: string;
          original?: string;
          startRelPos?: object;
          endRelPos?: object;
        }>;
      };
      if (!Array.isArray(blocks)) {
        sendJson(res, 200, { success: true, blocks: [] });
        return;
      }
      const docData = docs.get(roomName);
      if (!docData) {
        sendJson(res, 200, {
          success: true,
          blocks,
          message: "Document not in memory, using original line numbers",
        });
        return;
      }
      const ydoc = docData.doc;
      const ytext = ydoc.getText("content");
      const content = ytext.toString();

      const updated = blocks.map((block) => {
        if (!block.startRelPos || !block.endRelPos) return block;
        try {
          const startAbs = Y.createAbsolutePositionFromRelativePosition(
            Y.createRelativePositionFromJSON(block.startRelPos),
            ydoc
          );
          const endAbs = Y.createAbsolutePositionFromRelativePosition(
            Y.createRelativePositionFromJSON(block.endRelPos),
            ydoc
          );
          if (!startAbs || !endAbs) return block;
          return {
            ...block,
            startLine: content.slice(0, startAbs.index).split("\n").length,
            endLine: content.slice(0, endAbs.index).split("\n").length,
          };
        } catch {
          return block;
        }
      });
      sendJson(res, 200, { success: true, blocks: updated });
    } catch (err) {
      console.error("❌ /update-line-numbers failed:", err);
      sendJson(res, 500, { error: "Failed to update line numbers" });
    }
    return;
  }

  // -- GET /locks/:projectId/:fileId — pending-edit locks (via Y.Map) --------
  const locksMatch = url.match(/^\/locks\/([^/]+)\/(.+)$/);
  if (req.method === "GET" && locksMatch) {
    const [, projectId, fileId] = locksMatch;
    const access = await requireDocAccessOrReply(req, res, projectId);
    if (!access) return;
    const decodedFileId = decodeURIComponent(fileId);
    const roomName = `${projectId}-${decodedFileId}`;
    const docData = docs.get(roomName);
    if (!docData) {
      sendJson(res, 200, {
        projectId,
        fileId: decodedFileId,
        locks: [],
        message: "Document not in memory",
      });
      return;
    }
    try {
      interface Lock {
        id: string;
        userId: string;
        userName: string;
        fileId: string;
        startLine: number;
        endLine: number;
        startRelPos?: object;
        endRelPos?: object;
      }
      const locksMap = docData.doc.getMap<Lock>("pendingLocks");
      const locks: Array<{ userId: string; userName: string; startLine: number; endLine: number }> = [];
      locksMap.forEach((lock) => {
        if (
          lock.fileId === decodedFileId ||
          lock.fileId === fileId ||
          lock.fileId?.endsWith(decodedFileId) ||
          decodedFileId.endsWith(lock.fileId || "")
        ) {
          let startLine = lock.startLine;
          let endLine = lock.endLine;
          if (lock.startRelPos && lock.endRelPos) {
            try {
              const content = docData.doc.getText("content").toString();
              const s = Y.createAbsolutePositionFromRelativePosition(
                Y.createRelativePositionFromJSON(lock.startRelPos),
                docData.doc
              );
              const e = Y.createAbsolutePositionFromRelativePosition(
                Y.createRelativePositionFromJSON(lock.endRelPos),
                docData.doc
              );
              if (s && e) {
                startLine = content.slice(0, s.index).split("\n").length;
                endLine = content.slice(0, e.index).split("\n").length;
              }
            } catch { /* ignore */ }
          }
          locks.push({ userId: lock.userId, userName: lock.userName, startLine, endLine });
        }
      });
      sendJson(res, 200, { projectId, fileId: decodedFileId, locks });
    } catch (err) {
      console.error("❌ /locks failed:", err);
      sendJson(res, 500, { error: "Failed to get locks" });
    }
    return;
  }

  // -- GET /vibe-lock/:projectId/:fileId — AI processing lock via awareness --
  const vibeLockMatch = url.match(/^\/vibe-lock\/([^/]+)\/(.+)$/);
  if (req.method === "GET" && vibeLockMatch) {
    const [, projectId, fileId] = vibeLockMatch;
    const access = await requireDocAccessOrReply(req, res, projectId);
    if (!access) return;
    const decodedFileId = decodeURIComponent(fileId);
    const roomName = `${projectId}-${decodedFileId}`;
    const docData = docs.get(roomName);
    if (!docData) {
      sendJson(res, 200, {
        projectId,
        fileId: decodedFileId,
        isLocked: false,
        message: "Document not in memory",
      });
      return;
    }
    try {
      const states = docData.awareness.getStates();
      let lockedBy: { userId: string; userName: string } | null = null;
      states.forEach((state, clientId) => {
        if (state.vibeWriting === decodedFileId || state.vibeWriting === fileId) {
          const user = state.user as { id?: string; name?: string } | undefined;
          if (user) {
            lockedBy = {
              userId: user.id || `client_${clientId}`,
              userName: user.name || "Unknown User",
            };
          }
        }
      });
      sendJson(res, 200, {
        projectId,
        fileId: decodedFileId,
        isLocked: !!lockedBy,
        lockedBy,
      });
    } catch (err) {
      console.error("❌ /vibe-lock failed:", err);
      sendJson(res, 500, { error: "Failed to get vibe lock" });
    }
    return;
  }

  // -- GET /page-state/:projectId — aggregate all clients' pageState across docs
  const pageStateMatch = url.match(/^\/page-state\/([^/]+)$/);
  if (req.method === "GET" && pageStateMatch) {
    const [, projectId] = pageStateMatch;
    const access = await requireDocAccessOrReply(req, res, projectId);
    if (!access) return;
    const members: Array<{
      clientId: number;
      roomName: string;
      fileId: string;
      user: { id?: string; name?: string; image?: string } | null;
      userKind: "user" | "agent" | "unknown";
      pageState: unknown;
    }> = [];
    docs.forEach((docData, roomName) => {
      if (!roomName.startsWith(`${projectId}-`)) return;
      const fileId = roomName.slice(projectId.length + 1);
      const states = docData.awareness.getStates();
      states.forEach((state, clientId) => {
        const user = state.user as { id?: string; name?: string; image?: string } | undefined;
        // Infer kind: 'a*' = agent, 'u*' = user, else unknown
        const uid = (user?.id || "").toString();
        const userKind: "user" | "agent" | "unknown" =
          uid.startsWith("a") ? "agent" : uid.startsWith("u") ? "user" : "unknown";
        if (state.pageState) {
          members.push({
            clientId,
            roomName,
            fileId,
            user: user || null,
            userKind,
            pageState: state.pageState,
          });
        }
      });
    });
    sendJson(res, 200, { projectId, members, clientCount: members.length });
    return;
  }

  // -- GET /rooms ------------------------------------------------------------
  // Spans every project, so a per-project role check cannot apply. Internal
  // callers only.
  if (req.method === "GET" && url === "/rooms") {
    if (!requireInternalSecretOrReply(req, res)) return;
    sendJson(res, 200, {
      rooms: Array.from(docs.entries()).map(([name, d]) => ({
        name,
        clients: d.clients.size,
        contentLength: d.doc.getText("content").toString().length,
      })),
    });
    return;
  }

  // -- default status --------------------------------------------------------
  sendJson(res, 200, {
    status: "ok",
    service: "sumi-ws",
    docs: docs.size,
    connections: Array.from(docs.values()).reduce((s, d) => s + d.clients.size, 0),
    endpoints: [
      "GET  /                          status",
      "GET  /rooms                      list active rooms",
      "GET  /doc/:projectId/:fileId     get doc content",
      "POST /doc/:projectId/:fileId     apply line-based blocks",
      "POST /replace/:projectId/:fileId replace doc content (auth)",
      "POST /clear/:projectId/:fileId   clear doc memory+persistence (auth)",
      "POST /admin/clear-project/:projectId clear all project rooms (auth)",
      "POST /relpos/:projectId/:fileId  compute RelPos anchors for blocks",
      "POST /update-line-numbers/:projectId/:fileId re-resolve block lines",
      "GET  /locks/:projectId/:fileId   pending-edit locks",
      "GET  /vibe-lock/:projectId/:fileId AI-processing lock",
    ],
  });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({
  server,
  // Disable permessage-deflate — Node's native WebSocket (undici) sometimes
  // negotiates it in a way that drops binary frames, and we don't need the
  // bandwidth savings for local dev.
  perMessageDeflate: false,
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((client) => {
    const s = client as TrackedWebSocket;
    if (s.isAlive === false) {
      console.warn("⚠️ terminating stale websocket");
      s.terminate();
      return;
    }
    s.isAlive = false;
    try {
      s.ping();
    } catch {
      s.terminate();
    }
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => clearInterval(heartbeat));

wss.on("connection", async (ws: WebSocket, req) => {
  const tracked = ws as TrackedWebSocket;
  tracked.isAlive = true;
  ws.on("pong", () => {
    tracked.isAlive = true;
  });

  // The y-websocket client sends its sync-step-1 immediately on `open` — long
  // before auth + doc init complete. Buffer every inbound message until the
  // real handler is attached so nothing is dropped silently.
  const pendingMessages: Buffer[] = [];
  const earlyMessageHandler = (data: Buffer) => {
    pendingMessages.push(data);
  };
  ws.on("message", earlyMessageHandler);

  let requestUrl: URL;
  try {
    requestUrl = new URL(req.url || "/", "http://localhost");
  } catch {
    requestUrl = new URL("/", "http://localhost");
  }

  // Room name: strip slashes + optional ws/ prefix + URL-decode so
  // docs Map keys are consistent with /clear, /doc, /replace.
  let docName = requestUrl.pathname.replace(/^\/+/, "") || "default";
  if (docName.startsWith("ws/")) docName = docName.slice(3);
  try {
    docName = decodeURIComponent(docName);
  } catch { /* ignore malformed encoding */ }
  console.log(`📝 join room: ${docName}`);

  // --- resolve actor + authorize -------------------------------------------
  const parsed = parseRoomName(docName);
  if (!parsed) {
    console.warn(`❌ unparsable room name: ${docName}`);
    ws.close(1008, "bad_room_name");
    return;
  }

  let db;
  let actor: Actor | null;
  try {
    db = await getDb();
    actor = await resolveActor(db, req, requestUrl);
  } catch (err) {
    console.error(`❌ auth resolution failed for ${docName}:`, err);
    try { ws.close(1011, "auth_error"); } catch { /* ignore */ }
    return;
  }
  if (!actor) {
    console.warn(`❌ unauthenticated connection to ${docName}`);
    ws.close(1008, "unauthenticated");
    return;
  }

  const role = projectRoleFor(db, parsed.projectId, actor.id);
  if (!role) {
    console.warn(
      `❌ no project access: ${actor.kind}=${actor.id} room=${docName}`
    );
    ws.close(1008, "forbidden");
    return;
  }

  tracked.agentContext = {
    kind: actor.kind,
    actorId: actor.id,
    actorName: actor.name,
    projectId: parsed.projectId,
    effectiveRole: role,
  };

  console.log(
    `🔐 ${tracked.agentContext.kind}=${tracked.agentContext.actorId} role=${role} room=${docName}`
  );

  // --- attach to doc ---------------------------------------------------------
  let docData: DocData;
  try {
    docData = await getYDoc(docName);
  } catch (err) {
    console.error(`❌ init failed for ${docName}:`, err);
    try { ws.close(1011, "internal_error"); } catch { /* ignore */ }
    return;
  }

  // Socket may have closed while we awaited init — don't register a zombie.
  if (ws.readyState !== WebSocket.OPEN) {
    console.log(`⚠️ socket closed during init, skipping: ${docName}`);
    setTimeout(() => cleanupDocIfEmpty(docName), INIT_ORPHAN_CLEANUP_DELAY_MS);
    return;
  }

  const { doc, awareness } = docData;
  docData.clients.add(ws);

  // Track the awareness clientID for this connection (the first one it sends
  // is its own — needed to remove awareness on close).
  let awarenessClientID: number | null = null;

  // Send sync step 1
  {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, messageSync);
    syncProtocol.writeSyncStep1(enc, doc);
    ws.send(encoding.toUint8Array(enc));
  }

  // Send current awareness states
  const awarenessStates = awareness.getStates();
  if (awarenessStates.size > 0) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, messageAwareness);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awarenessStates.keys()))
    );
    ws.send(encoding.toUint8Array(enc));
  }

  ws.on("message", (data: Buffer) => {
    try {
      handleDocMessage(data);
    } catch (err) {
      console.error("❌ ws message error:", err);
    }
  });

  function handleDocMessage(data: Buffer) {
      const message = new Uint8Array(data);
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);

      if (messageType === messageSync) {
        const syncMessageType = decoding.readVarUint(decoder);
        const role = tracked.agentContext?.effectiveRole || "editor";
        if (
          role === "viewer" &&
          (syncMessageType === syncProtocol.messageYjsSyncStep2 ||
            syncMessageType === syncProtocol.messageYjsUpdate)
        ) {
          console.warn(
            `🔒 dropped write from read-only ${tracked.agentContext?.kind}=${tracked.agentContext?.actorId} in ${docName}`
          );
          return;
        }

        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, messageSync);
        switch (syncMessageType) {
          case syncProtocol.messageYjsSyncStep1:
            syncProtocol.readSyncStep1(decoder, enc, doc);
            break;
          case syncProtocol.messageYjsSyncStep2:
            syncProtocol.readSyncStep2(decoder, doc, null);
            break;
          case syncProtocol.messageYjsUpdate:
            syncProtocol.readUpdate(decoder, doc, null);
            break;
          default:
            console.warn(`⚠️ unknown sync message: ${syncMessageType}`);
            return;
        }
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      } else if (messageType === messageAwareness) {
        const update = decoding.readVarUint8Array(decoder);
        awarenessProtocol.applyAwarenessUpdate(awareness, update, ws);
        if (awarenessClientID === null) {
          try {
            const d2 = decoding.createDecoder(update);
            const len = decoding.readVarUint(d2);
            if (len > 0) {
              awarenessClientID = decoding.readVarUint(d2);
            }
          } catch { /* ignore */ }
        }
      }
  }

  // Swap the early buffering handler for the real one and replay anything that
  // arrived while getYDoc was still loading.
  ws.off("message", earlyMessageHandler);
  for (const m of pendingMessages) {
    try { handleDocMessage(m); } catch (err) {
      console.error("❌ ws message error (replayed):", err);
    }
  }
  pendingMessages.length = 0;

  // Broadcast doc updates to other clients
  const updateHandler = (update: Uint8Array, origin: unknown) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, messageSync);
    syncProtocol.writeUpdate(enc, update);
    const msg = encoding.toUint8Array(enc);
    docData.clients.forEach((client) => {
      if (client !== origin && client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  };
  doc.on("update", updateHandler);

  ws.on("close", () => {
    docData.clients.delete(ws);
    doc.off("update", updateHandler);
    if (awarenessClientID !== null) {
      awarenessProtocol.removeAwarenessStates(awareness, [awarenessClientID], null);
    }
    if (docData.clients.size === 0) {
      setTimeout(() => cleanupDocIfEmpty(docName), EMPTY_DOC_CLEANUP_DELAY_MS);
    }
    console.log(`👋 leave room: ${docName}, remaining=${docData.clients.size}`);
  });

  ws.on("error", (err) => {
    console.error("❌ ws error:", err);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`✅ sumi-ws listening on ws://localhost:${PORT}`);
  console.log(`📌 client URL: ws://localhost:${PORT}/{room-name}`);
});

process.on("SIGINT", async () => {
  console.log("\n🛑 shutting down");
  docs.forEach((docData) => {
    awarenessProtocol.removeAwarenessStates(
      docData.awareness,
      Array.from(docData.awareness.getStates().keys()),
      null
    );
    docData.persistenceCleanup?.();
    docData.doc.destroy();
  });
  await closeAllPersistence();
  wss.close(() => {
    server.close(() => process.exit(0));
  });
});

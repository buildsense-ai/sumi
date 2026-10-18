/**
 * Apply a pending edit — land the change in the document.
 *
 * POST body: { projectId, filePath, blocks: EditBlock[], editId? }
 *
 * `editId` alone is enough: the pending edit already records its own project,
 * file and blocks, so a caller holding only an id can apply it. Requiring the
 * caller to repeat the payload meant the CLI — whose whole interface for this is
 * `apply-edit --id` — could never complete the call, and there is no other route
 * that will hand you an edit by id.
 *
 * Two destinations, because the document lives in two places:
 *
 *   - The live Yjs room, while a client holds it open. A line-based edit there
 *     preserves concurrent edits, so this is the path to prefer.
 *   - The persisted blob, which is what a fresh room seeds from. With nobody
 *     connected there is no in-memory doc at all, and this is the only place the
 *     edit can land.
 *
 * The room used to be the only destination, and it answered `{success: true}`
 * even when there was no doc to write — so a pending edit was marked applied
 * while the document was untouched. Both destinations are now used, and the
 * status only flips once something actually landed.
 */

import { actorFromRequest } from "@/lib/http-auth";
import { getDb } from "@/src/db";
import { projectRoleFor } from "@/src/auth/actor";
import { publishUiPatch } from "@/src/ui-bus/event-bus";
import { applyBlocksToContent, detectDrift } from "@/src/edit-blocks";
import { docKey } from "@/src/doc-content";
import { getStorage } from "@/src/storage";
import crypto from "crypto";

const WS_PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 1234;
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || "";

export async function POST(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const body = (await request.json()) as {
    projectId?: string;
    filePath?: string;
    blocks?: Array<{ startLine: number; endLine: number; updated: string }>;
    editId?: string;
  };

  let { projectId, filePath, blocks } = body;
  const { editId } = body;

  const db = await getDb();

  // Resolve missing fields from the pending edit itself.
  if (editId && (!projectId || !filePath || !Array.isArray(blocks) || blocks.length === 0)) {
    const { getPendingEdit } = await import("@/src/pending-edits");
    const edit = getPendingEdit(db, editId);
    if (!edit) {
      return Response.json({ error: "edit not found" }, { status: 404 });
    }
    projectId = projectId || edit.projectId;
    filePath = filePath || edit.fileId;
    if (!Array.isArray(blocks) || blocks.length === 0) {
      blocks = (edit.blocks || []).map((b) => ({
        startLine: b.startLine,
        endLine: b.endLine,
        updated: b.updated,
        // Carry the anchor text through: the storage path uses it to notice that
        // the document moved since the proposal was written.
        original: b.original,
      }));
    }
  }

  if (!projectId || !filePath || !Array.isArray(blocks) || blocks.length === 0) {
    return Response.json(
      { error: "projectId, filePath, blocks required" },
      { status: 400 }
    );
  }

  const role = projectRoleFor(db, projectId, actor.id);
  if (role !== "owner" && role !== "editor") {
    return Response.json({ error: "editor role required" }, { status: 403 });
  }

  // Try the live room first: applying there keeps concurrent editors' changes
  // intact and broadcasts immediately.
  const fileId = encodeURIComponent(filePath);
  const wsUrl = `http://localhost:${WS_PORT}/doc/${projectId}/${fileId}`;

  let landedInMemory = false;
  let skipped: Array<{ block: unknown; reason: string }> = [];

  try {
    const res = await fetch(wsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // internal-secret bypasses client auth for backend-mediated writes
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({ blocks }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      inMemory?: boolean;
      error?: string;
    };
    if (!res.ok) {
      return Response.json(
        { error: data.error || "ws-server apply failed" },
        { status: res.status }
      );
    }
    // `inMemory: false` means nothing was written — fall through to storage
    // rather than reporting a success that did not happen.
    landedInMemory = data.inMemory === true && data.success !== false;
  } catch {
    // ws-server unreachable: the persisted blob is still authoritative for the
    // next room, so the edit can still land. Not an error on its own.
    landedInMemory = false;
  }

  // Fall back to the persisted content — the blob a fresh room seeds from.
  // Without this, an edit applied while nobody has the doc open is recorded as
  // applied and then never appears.
  if (!landedInMemory) {
    const storage = await getStorage();
    const key = docKey(projectId, filePath);

    if (!(await storage.exists(key))) {
      return Response.json(
        { error: "document not found", detail: `no blob at ${key}` },
        { status: 404 }
      );
    }

    const current = (await storage.download(key)).toString("utf8");

    // No CRDT anchors on this path, so verify the passage the reviewer approved is
    // still the passage these line numbers point at. Writing blind would replace
    // whatever moved into those lines — the reviewer would see a different edit
    // than the one they accepted.
    const drift = detectDrift(current, blocks);
    if (drift.length > 0) {
      return Response.json(
        {
          error: "document changed since this edit was proposed",
          drift,
          hint: "re-read the document and propose the edit again",
        },
        { status: 409 }
      );
    }

    const result = applyBlocksToContent(current, blocks);
    skipped = result.skipped;

    if (result.applied === 0) {
      // Every block was unplaceable. Report which and why; do not mark the edit
      // applied, or the diff disappears while the document is unchanged.
      return Response.json(
        {
          error: "no blocks could be applied",
          skipped,
          lines: current.split("\n").length,
        },
        { status: 409 }
      );
    }

    await storage.upload(key, result.content, "text/markdown");
  }

  // Status flips only now, with something actually written.
  if (editId) {
    const { updatePendingEditStatus, getPendingEdit } = await import(
      "@/src/pending-edits"
    );
    updatePendingEditStatus(db, editId, "applied");

    // Broadcast to all project members — humans see the diff disappear,
    // agents get the applied event via SSE.
    const appliedEdit = getPendingEdit(db, editId);
    const members = db
      .prepare("SELECT subject_id FROM project_members WHERE project_id = ?")
      .all(projectId) as { subject_id: string }[];
    for (const m of members) {
      void publishUiPatch({
        userId: m.subject_id,
        projectId,
        patch: {
          type: "pending_edit_changed",
          projectId,
          fileId: filePath,
          edit: appliedEdit,
        },
        source: "system",
      });
    }
  }

  return Response.json({
    ok: true,
    roomName: `${projectId}-${filePath}`,
    inMemory: landedInMemory,
    // Which path the edit took, so a caller can tell whether a connected client
    // and a fresh room will agree about the content.
    destination: landedInMemory ? "yjs-room" : "storage",
    ...(skipped.length ? { skipped } : {}),
  });
}

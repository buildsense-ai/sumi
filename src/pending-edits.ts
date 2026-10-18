/**
 * Pending edits — agent-proposed changes awaiting human review.
 *
 * Distilled from paperanim's storage model but adapted to Sumi:
 *   - sqlite table (not S3/JSON blob)
 *   - one row per pending edit (not a per-user blob)
 *   - tied to (projectId, fileId, targetUserId) — each collaborator has
 *     their own pending queue
 */

import crypto from "crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EditBlock } from "./server/edit-position-tracker";

export interface PendingEditRow {
  id: string;
  projectId: string;
  fileId: string;
  userId: string;          // subject this edit was proposed FOR (the reviewer)
  authorId: string;
  authorName: string | null;
  description: string | null;
  blocks: EditBlock[];
  status: "pending" | "applying" | "applied" | "rejected";
  createdAt: number;
  updatedAt: number;
}

const id = () =>
  `edit_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function addPendingEdit(
  db: DatabaseSync,
  input: {
    projectId: string;
    fileId: string;
    userId: string;
    authorId: string;
    authorName?: string;
    description?: string;
    blocks: EditBlock[];
  }
): PendingEditRow[] {
  // One PendingEdit row per block — so the reviewer can keep/reject each chunk.
  const created: PendingEditRow[] = [];
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO pending_edits
       (id, project_id, file_id, user_id, author_id, author_name, description, blocks, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  );
  for (let i = 0; i < input.blocks.length; i++) {
    const editId = `${id()}_${i}`;
    insert.run(
      editId,
      input.projectId,
      input.fileId,
      input.userId,
      input.authorId,
      input.authorName ?? null,
      input.description ?? null,
      JSON.stringify([input.blocks[i]]),
      now + i,
      now + i
    );
    created.push({
      id: editId,
      projectId: input.projectId,
      fileId: input.fileId,
      userId: input.userId,
      authorId: input.authorId,
      authorName: input.authorName ?? null,
      description: input.description ?? null,
      blocks: [input.blocks[i]],
      status: "pending",
      createdAt: now + i,
      updatedAt: now + i,
    });
  }
  return created;
}

export function listPendingEdits(
  db: DatabaseSync,
  input: { projectId: string; userId?: string; authorId?: string; fileId?: string }
): PendingEditRow[] {
  // Two sides of the same queue. A reviewer asks "what is waiting for me"; an
  // author (typically an agent) asks "did my proposals land". Filtering only by
  // reviewer made the second question unanswerable from the API — an agent that
  // had just proposed two edits was told the queue was empty.
  const column = input.authorId ? "author_id" : "user_id";
  const owner = input.authorId ?? input.userId;
  if (!owner) return [];

  const clauses = ["project_id = ?", `${column} = ?`, "status = 'pending'"];
  const values: string[] = [input.projectId, owner];
  if (input.fileId) {
    clauses.push("file_id = ?");
    values.push(input.fileId);
  }

  const rows = db
    .prepare(
      `SELECT * FROM pending_edits WHERE ${clauses.join(" AND ")}
       ORDER BY created_at ASC`
    )
    .all(...values) as Array<{
    id: string;
    project_id: string;
    file_id: string;
    user_id: string;
    author_id: string;
    author_name: string | null;
    description: string | null;
    blocks: string;
    status: string;
    created_at: number;
    updated_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    fileId: r.file_id,
    userId: r.user_id,
    authorId: r.author_id,
    authorName: r.author_name,
    description: r.description,
    blocks: JSON.parse(r.blocks) as EditBlock[],
    status: r.status as PendingEditRow["status"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * Every pending edit in a project, regardless of who proposed or reviews it.
 *
 * For the owner's view of the queue: they are the one who has to clear it, and
 * a queue they cannot enumerate in one call is not a queue they can trust.
 */
export function listProjectPendingEdits(
  db: DatabaseSync,
  input: { projectId: string; fileId?: string }
): PendingEditRow[] {
  const clauses = ["project_id = ?", "status = 'pending'"];
  const values: string[] = [input.projectId];
  if (input.fileId) {
    clauses.push("file_id = ?");
    values.push(input.fileId);
  }

  const rows = db
    .prepare(
      `SELECT * FROM pending_edits WHERE ${clauses.join(" AND ")}
       ORDER BY created_at ASC`
    )
    .all(...values) as Array<{
    id: string;
    project_id: string;
    file_id: string;
    user_id: string;
    author_id: string;
    author_name: string | null;
    description: string | null;
    blocks: string;
    status: string;
    created_at: number;
    updated_at: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    fileId: r.file_id,
    userId: r.user_id,
    authorId: r.author_id,
    authorName: r.author_name,
    description: r.description,
    blocks: JSON.parse(r.blocks) as EditBlock[],
    status: r.status as PendingEditRow["status"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function getPendingEdit(
  db: DatabaseSync,
  editId: string
): PendingEditRow | null {
  const r = db
    .prepare(`SELECT * FROM pending_edits WHERE id = ?`)
    .get(editId) as
    | {
        id: string;
        project_id: string;
        file_id: string;
        user_id: string;
        author_id: string;
        author_name: string | null;
        description: string | null;
        blocks: string;
        status: string;
        created_at: number;
        updated_at: number;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    projectId: r.project_id,
    fileId: r.file_id,
    userId: r.user_id,
    authorId: r.author_id,
    authorName: r.author_name,
    description: r.description,
    blocks: JSON.parse(r.blocks) as EditBlock[],
    status: r.status as PendingEditRow["status"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function updatePendingEditStatus(
  db: DatabaseSync,
  editId: string,
  status: "applying" | "applied" | "rejected"
): boolean {
  const res = db
    .prepare(
      "UPDATE pending_edits SET status = ?, updated_at = ? WHERE id = ?"
    )
    .run(status, Date.now(), editId);
  return res.changes > 0;
}

export function deletePendingEdit(
  db: DatabaseSync,
  editId: string
): boolean {
  const res = db.prepare("DELETE FROM pending_edits WHERE id = ?").run(editId);
  return res.changes > 0;
}

/** All members of a project that should see an edit notification. */
export function listMemberSubjects(
  db: DatabaseSync,
  projectId: string
): string[] {
  const rows = db
    .prepare(
      "SELECT subject_id AS subjectId FROM project_members WHERE project_id = ?"
    )
    .all(projectId) as Array<{ subjectId: string }>;
  return rows.map((r) => r.subjectId);
}

// ---------------------------------------------------------------------------
// Doc snapshots — captured at propose-time so apply can do 3-way sanity checks
// ---------------------------------------------------------------------------

export function saveDocSnapshot(
  db: DatabaseSync,
  input: { projectId: string; fileId: string; content: string; contentHash: string }
): void {
  db.prepare(
    `INSERT INTO doc_snapshots (project_id, file_id, content, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (project_id, file_id) DO UPDATE SET
       content = excluded.content,
       content_hash = excluded.content_hash,
       created_at = excluded.created_at`
  ).run(input.projectId, input.fileId, input.content, input.contentHash, Date.now());
}

export function getDocSnapshot(
  db: DatabaseSync,
  projectId: string,
  fileId: string
): { content: string; contentHash: string; createdAt: number } | null {
  const r = db
    .prepare(
      `SELECT content, content_hash AS contentHash, created_at AS createdAt
       FROM doc_snapshots WHERE project_id = ? AND file_id = ?`
    )
    .get(projectId, fileId) as
    | { content: string; contentHash: string; createdAt: number }
    | undefined;
  return r ?? null;
}

/**
 * Two sides of the pending-edit queue.
 *
 * `listPendingEdits` originally only answered "what is waiting for my review".
 * That is the right question for a human, but it made the agent's question —
 * "did the edits I proposed land?" — unanswerable through the API: an agent that
 * had just proposed two edits was told the queue was empty, because it was the
 * author and not the reviewer.
 *
 * These pin both sides plus the project-wide view the owner needs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "fs";
import { getDb, resetDbForTests } from "../src/db";
import {
  upsertSubject,
  createProject,
  grantMembership,
} from "../src/auth/identity";
import {
  addPendingEdit,
  listPendingEdits,
  listProjectPendingEdits,
  updatePendingEditStatus,
} from "../src/pending-edits";

const TEST_DIR = `/tmp/sumi-pending-scope-test-${process.pid}`;
process.env.SUMI_DATA_DIR = TEST_DIR;

let testCounter = 0;

beforeEach(async () => {
  resetDbForTests();
  process.env.SUMI_DATA_DIR = `${TEST_DIR}-${testCounter++}`;
  await fs.rm(process.env.SUMI_DATA_DIR, { recursive: true, force: true });
});

/** Owner u1, editor u2, agent a9 (the author of everything below). */
async function seed() {
  const db = await getDb();
  upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "Owner" });
  upsertSubject(db, { subjectId: "u2", kind: "user", displayName: "Editor" });
  upsertSubject(db, { subjectId: "a9", kind: "agent", displayName: "bot" });
  const project = createProject(db, { name: "x", ownerSubjectId: "u1" });
  grantMembership(db, {
    projectId: project.id,
    subjectId: "u2",
    role: "editor",
    grantedBy: "u1",
  });
  grantMembership(db, {
    projectId: project.id,
    subjectId: "a9",
    role: "editor",
    grantedBy: "u1",
  });
  return { db, project };
}

describe("pending-edit queue — author vs reviewer", () => {
  it("shows an author their own proposals", async () => {
    const { db, project } = await seed();
    addPendingEdit(db, {
      projectId: project.id,
      fileId: "notes.md",
      userId: "u1", // review lands with the owner
      authorId: "a9",
      description: "fix typos",
      blocks: [
        { startLine: 1, endLine: 1, updated: "a" },
        { startLine: 3, endLine: 3, updated: "b" },
      ],
    });

    // The regression: asking as the author returned nothing.
    const authored = listPendingEdits(db, {
      projectId: project.id,
      authorId: "a9",
    });
    expect(authored).toHaveLength(2);
    expect(authored.every((e) => e.authorId === "a9")).toBe(true);

    // …and the reviewer still sees them as work to do.
    const forReview = listPendingEdits(db, {
      projectId: project.id,
      userId: "u1",
    });
    expect(forReview).toHaveLength(2);
  });

  it("does not mix the two sides together", async () => {
    const { db, project } = await seed();
    // a9 proposes to u1
    addPendingEdit(db, {
      projectId: project.id,
      fileId: "notes.md",
      userId: "u1",
      authorId: "a9",
      blocks: [{ startLine: 1, endLine: 1, updated: "from a9" }],
    });
    // u2 proposes to a9 — the reverse direction, so a9 is the reviewer here
    addPendingEdit(db, {
      projectId: project.id,
      fileId: "notes.md",
      userId: "a9",
      authorId: "u2",
      blocks: [{ startLine: 2, endLine: 2, updated: "from u2" }],
    });

    const asAuthor = listPendingEdits(db, { projectId: project.id, authorId: "a9" });
    expect(asAuthor).toHaveLength(1);
    expect(asAuthor[0].authorId).toBe("a9");

    const asReviewer = listPendingEdits(db, { projectId: project.id, userId: "a9" });
    expect(asReviewer).toHaveLength(1);
    expect(asReviewer[0].userId).toBe("a9");
    expect(asReviewer[0].authorId).toBe("u2");
  });

  it("scopes by file on both sides", async () => {
    const { db, project } = await seed();
    for (const fileId of ["a.md", "b.md"]) {
      addPendingEdit(db, {
        projectId: project.id,
        fileId,
        userId: "u1",
        authorId: "a9",
        blocks: [{ startLine: 1, endLine: 1, updated: fileId }],
      });
    }

    expect(
      listPendingEdits(db, { projectId: project.id, authorId: "a9", fileId: "a.md" })
    ).toHaveLength(1);
    expect(
      listPendingEdits(db, { projectId: project.id, userId: "u1", fileId: "b.md" })
    ).toHaveLength(1);
  });

  it("drops an edit from both sides once it is applied", async () => {
    const { db, project } = await seed();
    const [edit] = addPendingEdit(db, {
      projectId: project.id,
      fileId: "notes.md",
      userId: "u1",
      authorId: "a9",
      blocks: [{ startLine: 1, endLine: 1, updated: "x" }],
    });

    expect(listPendingEdits(db, { projectId: project.id, authorId: "a9" })).toHaveLength(1);
    updatePendingEditStatus(db, edit.id, "applied");
    expect(listPendingEdits(db, { projectId: project.id, authorId: "a9" })).toHaveLength(0);
    expect(listPendingEdits(db, { projectId: project.id, userId: "u1" })).toHaveLength(0);
  });

  it("returns nothing when neither side is identified", async () => {
    const { db, project } = await seed();
    addPendingEdit(db, {
      projectId: project.id,
      fileId: "notes.md",
      userId: "u1",
      authorId: "a9",
      blocks: [{ startLine: 1, endLine: 1, updated: "x" }],
    });

    // Without an owner column there is no filter to apply — refusing beats
    // silently returning the whole project.
    expect(listPendingEdits(db, { projectId: project.id })).toEqual([]);
  });

  it("lists every pending edit in the project regardless of party", async () => {
    const { db, project } = await seed();
    addPendingEdit(db, {
      projectId: project.id,
      fileId: "notes.md",
      userId: "u1",
      authorId: "a9",
      blocks: [{ startLine: 1, endLine: 1, updated: "one" }],
    });
    addPendingEdit(db, {
      projectId: project.id,
      fileId: "notes.md",
      userId: "a9",
      authorId: "u2",
      blocks: [{ startLine: 2, endLine: 2, updated: "two" }],
    });

    const all = listProjectPendingEdits(db, { projectId: project.id });
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.authorId).sort()).toEqual(["a9", "u2"]);

    // Still honours the file filter, and still excludes settled edits.
    expect(
      listProjectPendingEdits(db, { projectId: project.id, fileId: "notes.md" })
    ).toHaveLength(2);
    expect(
      listProjectPendingEdits(db, { projectId: project.id, fileId: "other.md" })
    ).toHaveLength(0);
  });

  it("keeps the project view inside its project", async () => {
    const { db, project } = await seed();
    const other = createProject(db, { name: "y", ownerSubjectId: "u1" });
    addPendingEdit(db, {
      projectId: other.id,
      fileId: "notes.md",
      userId: "u1",
      authorId: "a9",
      blocks: [{ startLine: 1, endLine: 1, updated: "elsewhere" }],
    });

    expect(listProjectPendingEdits(db, { projectId: project.id })).toHaveLength(0);
    expect(listProjectPendingEdits(db, { projectId: other.id })).toHaveLength(1);
  });
});

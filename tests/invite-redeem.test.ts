/**
 * Invite redemption — joining a project through a shared link.
 *
 * The route is the one place a non-owner can create a membership for
 * themselves, so what matters is that it refuses anything but a validly signed
 * token, refuses unknown projects, and never lowers a role someone already
 * holds.
 *
 * NB: nothing statically imported here may transitively reach src/auth/catsco.
 * That module reads OC_JWT_SECRET at module-evaluation time, and static imports
 * are hoisted above the assignments below, so pulling it in eagerly would leave
 * it holding an empty secret and every JWT check would fail with a 403.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "fs";
import * as jose from "jose";
import { getDb, resetDbForTests } from "../src/db";
import {
  upsertSubject,
  createProject,
  grantMembership,
  listMembers,
} from "../src/auth/identity";

const TEST_DIR = `/tmp/sumi-invite-test-${process.pid}`;
process.env.SUMI_DATA_DIR = TEST_DIR;
process.env.OC_JWT_SECRET = "test-secret-invite";
process.env.INVITE_SIGNING_SECRET = "test-invite-signing-secret";

// Imported after the secrets above are set — see the note at the top.
const { POST: redeem } = await import("../app/api/invite/redeem/route");
const { signInvite } = await import("../lib/invite-token");

let testCounter = 0;

beforeEach(async () => {
  resetDbForTests();
  process.env.SUMI_DATA_DIR = `${TEST_DIR}-${testCounter++}`;
  await fs.rm(process.env.SUMI_DATA_DIR, { recursive: true, force: true });
});

/** Mint a CatsCo-shaped user JWT for the given numeric uid. */
async function userJwt(uid: number, username = `user${uid}`): Promise<string> {
  return new jose.SignJWT({ userId: uid, username, token_type: "user" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("catscompany")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.OC_JWT_SECRET));
}

function redeemReq(token: string, credential: string): Request {
  return new Request("http://localhost/api/invite/redeem", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify({ token }),
  });
}

/** u1 owns the project, u2 is an editor, u3 is a stranger. */
async function seed() {
  const db = await getDb();
  upsertSubject(db, { subjectId: "u1", kind: "user", displayName: "Owner" });
  upsertSubject(db, { subjectId: "u2", kind: "user", displayName: "Editor" });
  upsertSubject(db, { subjectId: "u3", kind: "user", displayName: "Newcomer" });
  const project = createProject(db, { name: "x", ownerSubjectId: "u1" });
  grantMembership(db, {
    projectId: project.id,
    subjectId: "u2",
    role: "editor",
    grantedBy: "u1",
  });
  return { db, project };
}

const roleOf = (db: Awaited<ReturnType<typeof getDb>>, projectId: string, id: string) =>
  listMembers(db, projectId).find((m) => m.subjectId === id)?.role ?? null;

describe("POST /api/invite/redeem", () => {
  it("rejects a bare project id — the project id alone is not a capability", async () => {
    const { project } = await seed();

    const res = await redeem(redeemReq(project.id, await userJwt(3)));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid invite");
    const db = await getDb();
    expect(roleOf(db, project.id, "u3")).toBeNull();
  });

  it("rejects a token whose signature was tampered with", async () => {
    const { project } = await seed();
    const token = signInvite(project.id)!;
    const [payload, mac] = token.split(".");
    const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");

    const res = await redeem(redeemReq(`${payload}.${flipped}`, await userJwt(3)));

    expect(res.status).toBe(400);
    const db = await getDb();
    expect(roleOf(db, project.id, "u3")).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const { project } = await seed();
    const original = process.env.INVITE_SIGNING_SECRET;
    process.env.INVITE_SIGNING_SECRET = "some-other-secret";
    const foreign = signInvite(project.id)!;
    process.env.INVITE_SIGNING_SECRET = original;

    const res = await redeem(redeemReq(foreign, await userJwt(3)));

    expect(res.status).toBe(400);
  });

  it("404s for an unknown project instead of failing on the foreign key", async () => {
    const db = await getDb();
    upsertSubject(db, { subjectId: "u3", kind: "user", displayName: "Newcomer" });
    const token = signInvite("prj_does_not_exist")!;

    const res = await redeem(redeemReq(token, await userJwt(3)));

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("project not found");
  });

  it("adds a stranger as viewer with a valid token", async () => {
    const { db, project } = await seed();

    const res = await redeem(redeemReq(signInvite(project.id)!, await userJwt(3)));

    expect(res.status).toBe(200);
    expect(roleOf(db, project.id, "u3")).toBe("viewer");
  });

  it("does not downgrade an existing editor", async () => {
    const { db, project } = await seed();

    const res = await redeem(redeemReq(signInvite(project.id)!, await userJwt(2)));

    expect(res.status).toBe(200);
    expect((await res.json()).alreadyMember).toBe(true);
    expect(roleOf(db, project.id, "u2")).toBe("editor");
  });

  it("leaves the owner's membership row as owner", async () => {
    const { db, project } = await seed();

    const res = await redeem(redeemReq(signInvite(project.id)!, await userJwt(1)));

    expect(res.status).toBe(200);
    expect(roleOf(db, project.id, "u1")).toBe("owner");
  });

  it("refuses a credential that is not a user session", async () => {
    const { project } = await seed();

    const res = await redeem(redeemReq(signInvite(project.id)!, "cc_not_a_jwt"));

    expect(res.status).toBe(403);
  });

  it("requires a token", async () => {
    await seed();

    const res = await redeem(
      new Request("http://localhost/api/invite/redeem", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await userJwt(3)}`,
        },
        body: JSON.stringify({}),
      })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("token required");
  });
});

/**
 * POST /api/invite/redeem — join a project as viewer via an invite link.
 *
 * Unlike POST /members (owner-only), this lets an authenticated user add
 * themselves to a project they were given a link for. The link's `invite`
 * parameter is a signed token, not a project id: the project id alone used to be
 * the whole capability, and ids travel in document URLs, room names and logs.
 *
 * body: { token }
 */

import { getDb } from "@/src/db";
import { getProject, grantMembership } from "@/src/auth/identity";
import { projectRoleFor } from "@/src/auth/actor";
import { actorFromRequest } from "@/lib/http-auth";
import { verifyInvite } from "@/lib/invite-token";

export async function POST(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor || actor.kind !== "user") {
    return Response.json({ error: "user required" }, { status: 403 });
  }

  const body = (await request.json()) as { token?: string };
  if (!body.token || typeof body.token !== "string") {
    return Response.json({ error: "token required" }, { status: 400 });
  }

  const projectId = verifyInvite(body.token);
  if (!projectId) {
    return Response.json({ error: "invalid invite" }, { status: 400 });
  }

  const db = await getDb();

  // A valid signature only proves the link was issued for this project; it can
  // still outlive the project itself.
  if (!getProject(db, projectId)) {
    return Response.json({ error: "project not found" }, { status: 404 });
  }

  // Already in the project — leave the existing role alone.
  //
  // grantMembership upserts with `DO UPDATE SET role = excluded.role`, so
  // redeeming used to rewrite the caller's row to "viewer": an editor who opened
  // a colleague's link silently lost edit rights. Redeeming a link may add a
  // membership, never lower one.
  if (projectRoleFor(db, projectId, actor.id)) {
    return Response.json({
      ok: true,
      subjectId: actor.id,
      projectId,
      alreadyMember: true,
    });
  }

  try {
    grantMembership(db, {
      projectId,
      subjectId: actor.id,
      role: "viewer",
      grantedBy: `invite:${actor.id}`,
    });
    return Response.json({ ok: true, subjectId: actor.id, projectId });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

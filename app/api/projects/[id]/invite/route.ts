/**
 * POST /api/projects/:id/invite — mint a signed invite token for this project.
 *
 * Restricted to members who could already grow the project (owner or editor).
 * A viewer handing out access would let read-only members widen the membership.
 *
 * The token is what makes the invite link a capability; see lib/invite-token.ts.
 */

import { actorForProject } from "@/lib/http-auth";
import { getDb } from "@/src/db";
import { getProject } from "@/src/auth/identity";
import { signInvite, inviteSigningAvailable } from "@/lib/invite-token";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  const actor = await actorForProject(request, projectId);
  if (!actor) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (actor.projectRole !== "owner" && actor.projectRole !== "editor") {
    return Response.json({ error: "owner or editor required" }, { status: 403 });
  }

  const db = await getDb();
  if (!getProject(db, projectId)) {
    return Response.json({ error: "project not found" }, { status: 404 });
  }

  if (!inviteSigningAvailable()) {
    // Fail closed: without a secret we cannot mint a verifiable token, and an
    // unsigned one is exactly what this replaced.
    return Response.json(
      { error: "invite signing not configured" },
      { status: 503 }
    );
  }

  const token = signInvite(projectId);
  if (!token) {
    return Response.json(
      { error: "invite signing not configured" },
      { status: 503 }
    );
  }
  return Response.json({ token });
}

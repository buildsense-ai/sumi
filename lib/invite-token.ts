/**
 * Signed invite tokens.
 *
 * The invite link used to carry nothing but the project id, so any
 * authenticated caller who learned a project id could add themselves to it —
 * and project ids travel: they appear in document URLs, room names and logs.
 * The link is now a capability: an HMAC over the project id, checked before any
 * membership is created.
 *
 * The secret is deliberately its own variable rather than reusing
 * INTERNAL_API_SECRET. That one guards server-to-server calls and is echoed in
 * headers; sharing it would mean a leak of either surface hands out the other.
 */

import crypto from "node:crypto";

function signingSecret(): string {
  return process.env.INVITE_SIGNING_SECRET || "";
}

/** False when the deployment has no signing secret — callers must fail closed. */
export function inviteSigningAvailable(): boolean {
  return signingSecret().length > 0;
}

/** `payload.signature`, or null when no secret is configured. */
export function signInvite(projectId: string): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  // base64url has no "." in its alphabet, so the separator is unambiguous.
  const payload = Buffer.from(projectId, "utf8").toString("base64url");
  const mac = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${mac}`;
}

/** The project id this token vouches for, or null if it does not verify. */
export function verifyInvite(token: string): string | null {
  const secret = signingSecret();
  if (!secret || typeof token !== "string") return null;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  try {
    const projectId = Buffer.from(payload, "base64url").toString("utf8");
    return projectId.length > 0 ? projectId : null;
  } catch {
    return null;
  }
}

/**
 * Friends + bots — proxy to CatsCo.
 *
 * CatsCo owns the social graph. Sumi forwards a credential and merges the two
 * rosters it returns:
 *   { users: [...], agents: [...] }
 *
 * Each row carries a ready-to-use `subjectId` for /api/projects/:id/members.
 *
 * Two things this route used to get wrong, both of which made the member picker
 * show "CatsCo hasn't given you any friends or bots yet" on an account that had
 * plenty:
 *
 *  1. It read `uid` off the friends payload, but /api/friends returns `id`.
 *     `rows.filter((u) => u && u.uid)` therefore dropped every single entry.
 *  2. It required the caller to hand over their own CatsCo bearer token. Behind
 *     the artifact gateway the browser holds a viewer cookie and no bearer token
 *     exists, so the route answered 400 before it ever called CatsCo.
 *
 * And one thing it got wrong in a quieter way: a failed upstream call and an
 * empty roster both came back as `{users: [], agents: []}`, so a broken
 * deployment was indistinguishable from a lonely account. Failures are now
 * reported as failures.
 */

import { actorFromRequest } from "@/lib/http-auth";
import { apiPath } from "@/lib/api-path";

const CATSCO_BASE_URL = (
  process.env.CATSCO_BASE_URL || "http://localhost:8080"
).replace(/\/+$/, "");

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * A CatsCo credential for deployments whose visitors have none of their own.
 *
 * Behind the artifact gateway the viewer cookie proves *who* is visiting but is
 * not a CatsCo API credential, so it cannot be forwarded upstream. A
 * single-account deployment sets this to that account's token and the picker
 * works; leave it unset and the route still refuses anonymous callers, it just
 * cannot answer the roster either.
 *
 * Callers that do send a credential always win — the list is then theirs, not
 * the deployment's.
 */
function fallbackAccountToken(): string {
  const raw = (process.env.CATSCO_ACCOUNT_TOKEN || "").trim();
  if (!raw) return "";
  // Operators paste either the bare token or a complete header value; both are
  // reasonable, and a missing scheme is a silent 401 that looks like a wrong
  // token. Normalize instead of trusting the format.
  return /^[A-Za-z]+\s/.test(raw) ? raw : `Bearer ${raw}`;
}

/** The uid the fallback credential belongs to. */
function fallbackAccountUid(): number | null {
  const raw = Number(process.env.CATSCO_ACCOUNT_UID);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * The deployment credential, but only for the account it belongs to.
 *
 * Handing it to any other viewer would show them someone else's friend list,
 * which is a privacy leak dressed up as a fallback. Requiring
 * CATSCO_ACCOUNT_UID to match the viewer makes that impossible: a deployment
 * either serves its own account or nobody.
 */
function fallbackFor(actorUid: number): string {
  const token = fallbackAccountToken();
  if (!token) return "";
  const uid = fallbackAccountUid();
  if (uid === null) return ""; // unlabelled credential — refuse to guess
  return uid === actorUid ? token : "";
}

/**
 * The caller's own credential, if they brought one — scheme included.
 *
 * The scheme has to survive: CatsCo reads `Authorization: Bearer <jwt>` and
 * `Authorization: ApiKey <cc_…>`, and forwarding the bare token would 401. The
 * query-parameter forms are only accepted where a header cannot be set.
 */
function forwardedCredential(request: Request): string {
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ") || auth.startsWith("ApiKey ")) return auth;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (token) return `Bearer ${token}`;
  const apiKey = url.searchParams.get("api_key");
  if (apiKey) return `ApiKey ${apiKey}`;
  return "";
}

/**
 * Public origin of this deployment, without a path.
 *
 * NEXT_PUBLIC_SUMI_URL is the origin only (`https://artifact.catsco.cc`); the
 * app's own prefix comes from apiPath(). Keeping the two separate is what stops
 * a share link from dropping /<app-id>/ and 404ing at the gateway root.
 */
function publicOrigin(request: Request): string {
  return (process.env.NEXT_PUBLIC_SUMI_URL || new URL(request.url).origin).replace(
    /\/+$/,
    ""
  );
}

// ---------------------------------------------------------------------------
// Upstream calls
// ---------------------------------------------------------------------------

/** Shape of a row in GET /api/friends — note `id`, not `uid`. */
interface CatsCoFriend {
  id?: number;
  uid?: number;
  username?: string;
  display_name?: string;
  avatar_url?: string;
  /** "human" | "bot" — a bot can be a friend without being yours. */
  account_type?: string;
}

/** Shape of a row in GET /api/bots. */
interface CatsCoBot {
  id?: number;
  uid?: number;
  username?: string;
  display_name?: string;
  avatar_url?: string;
  owner?: { uid?: number };
  owner_id?: number;
  is_owner?: boolean;
}

type CatsFailure = { ok: false; reason: string; status: number | null };
type CatsResult<T> = { ok: true; data: T } | CatsFailure;

async function catsGet<T>(path: string, credential: string): Promise<CatsResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${CATSCO_BASE_URL}${path}`, {
      headers: { Authorization: credential },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        // 401/403 is a configuration problem, not an outage — say which.
        reason:
          res.status === 401 || res.status === 403
            ? "catsco_unauthorized"
            : `catsco_error_${res.status}`,
      };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: null,
      reason: aborted ? "catsco_timeout" : "catsco_unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export interface Contact {
  subjectId: string;
  uid: number;
  username: string;
  displayName: string;
  avatarUrl?: string;
  kind: "user" | "agent";
}

/**
 * One roster row → one contact.
 *
 * `id` is the field /api/friends returns and `uid` the one /api/bots returns;
 * accepting both is what makes the two rosters mergeable. `kindWhenUnknown`
 * covers /api/bots, whose rows carry no account_type — everything there is an
 * agent.
 */
function toContact(
  raw: CatsCoFriend | CatsCoBot,
  kindWhenUnknown: "user" | "agent"
): Contact | null {
  const uid = Number(raw?.uid ?? raw?.id);
  if (!Number.isFinite(uid) || uid <= 0) return null;

  const accountType = String(
    (raw as CatsCoFriend).account_type || ""
  ).toLowerCase();
  const kind: "user" | "agent" =
    accountType === "bot" || kindWhenUnknown === "agent" ? "agent" : "user";

  return {
    subjectId: `${kind === "agent" ? "a" : "u"}${uid}`,
    uid,
    username: raw.username || "",
    displayName: raw.display_name || raw.username || `${kind === "agent" ? "a" : "u"}${uid}`,
    avatarUrl: raw.avatar_url,
    kind,
  };
}

// ---------------------------------------------------------------------------
// GET — the merged roster
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor || actor.kind !== "user") {
    return Response.json({ error: "user required" }, { status: 403 });
  }

  // Prefer the caller's own credential; fall back to the deployment's, and only
  // for the account that credential belongs to.
  const credential = forwardedCredential(request) || fallbackFor(actor.uid);
  if (!credential) {
    return Response.json(
      {
        error: "no catsco credential",
        detail: fallbackAccountToken()
          ? "This deployment holds a CatsCo credential for a different account " +
            "than the one you are signed in as."
          : "This deployment has no CatsCo credential to read the roster with. " +
            "Set CATSCO_ACCOUNT_TOKEN and CATSCO_ACCOUNT_UID, or send your own " +
            "bearer token.",
      },
      { status: 503 }
    );
  }

  // Fire both in parallel — friends (users and bots) and my bots (agents).
  const [friendsRes, botsRes] = await Promise.all([
    catsGet<{ friends: CatsCoFriend[] }>("/api/friends", credential),
    catsGet<{ bots: CatsCoBot[] }>("/api/bots", credential),
  ]);

  // Both down: report it. An empty roster here would be a lie, and the panel
  // would blame the user's CatsCo account for the deployment's misconfiguration.
  if (!friendsRes.ok && !botsRes.ok) {
    return Response.json(
      {
        error: friendsRes.reason,
        detail: `Could not reach CatsCo at ${CATSCO_BASE_URL}`,
        users: [],
        agents: [],
      },
      { status: 502 }
    );
  }

  // Merge into one roster keyed by subjectId: a bot can appear in both
  // /api/friends (as a friend) and /api/bots (as mine), and listing it twice
  // would offer two identical "add" buttons.
  const roster = new Map<string, Contact>();

  if (friendsRes.ok) {
    for (const raw of friendsRes.data?.friends ?? []) {
      const contact = toContact(raw ?? {}, "user");
      if (!contact) continue;
      const existing = roster.get(contact.subjectId);
      if (!existing) {
        roster.set(contact.subjectId, contact);
      } else if (contact.kind === "agent" && existing.kind !== "agent") {
        // A bot is an agent, however the other roster described it.
        roster.set(contact.subjectId, contact);
      }
    }
  }

  if (botsRes.ok) {
    for (const raw of botsRes.data?.bots ?? []) {
      const contact = toContact(raw ?? {}, "agent");
      if (!contact) continue;
      const existing = roster.get(contact.subjectId);
      if (!existing) {
        roster.set(contact.subjectId, contact);
      } else if (!existing.displayName || existing.displayName === existing.subjectId) {
        roster.set(contact.subjectId, contact);
      }
    }
  }

  const all = [...roster.values()];
  const partial = !friendsRes.ok || !botsRes.ok;

  return Response.json({
    users: all.filter((c) => c.kind === "user"),
    agents: all.filter((c) => c.kind === "agent"),
    // Non-fatal: one of the two rosters is missing, so the list is incomplete.
    ...(partial
      ? {
          warning: friendsRes.ok ? "catsco_bots_unavailable" : "catsco_friends_unavailable",
          detail: partialDetail(friendsRes, botsRes),
        }
      : {}),
  });
}

function partialDetail(
  friendsRes: CatsResult<unknown>,
  botsRes: CatsResult<unknown>
): string {
  const parts: string[] = [];
  if (!friendsRes.ok) parts.push(`friends: ${friendsRes.reason}`);
  if (!botsRes.ok) parts.push(`bots: ${botsRes.reason}`);
  return `${parts.join("; ")} (${CATSCO_BASE_URL})`;
}

// ---------------------------------------------------------------------------
// POST — share Sumi with a friend / send onboarding to a bot
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const actor = await actorFromRequest(request);
  if (!actor || actor.kind !== "user") {
    return Response.json({ error: "user required" }, { status: 403 });
  }

  const credential = forwardedCredential(request) || fallbackAccountToken();
  if (!credential) {
    return Response.json(
      { error: "no catsco credential", detail: "Set CATSCO_ACCOUNT_TOKEN." },
      { status: 503 }
    );
  }

  const body = (await request.json()) as {
    subjectId?: string;
    kind?: "user" | "agent";
    projectId?: string;
    projectName?: string;
  };
  if (!body.subjectId || !body.kind) {
    return Response.json(
      { error: "subjectId + kind required" },
      { status: 400 }
    );
  }

  const { subjectId, kind, projectId, projectName } = body;

  if (kind === "user") {
    // -- Send the friend a P2P CatsCo message with the Sumi link ------
    //
    // Left as-is on purpose. Making this link a signed capability belongs with
    // the invite change, not here: this branch is about who the roster shows and
    // how an agent authenticates, and pulling the invite plumbing in would make
    // it depend on a change that has not landed.
    const shareUrl = `${process.env.SUMI_PUBLIC_ORIGIN || process.env.NEXT_PUBLIC_SUMI_URL || "http://localhost:3000"}/?invite=${encodeURIComponent(
      subjectId
    )}${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`;

    // CatsCo P2P topic: p2p_{smaller_uid}_{larger_uid}
    const myUid = actor.uid;
    const friendUid = Number(subjectId.slice(1)); // strip 'u' prefix
    const [a, b] = myUid < friendUid ? [myUid, friendUid] : [friendUid, myUid];
    const topicId = `p2p_${a}_${b}`;

    const res = await fetch(`${CATSCO_BASE_URL}/api/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: credential,
      },
      body: JSON.stringify({
        topic_id: topicId,
        msg_type: "markdown",
        content: `**${actor.name}** 邀请你加入 Sumi 项目「${projectName || projectId || "一个项目"}」

🔗 ${shareUrl}`,
      }),
    });
    if (!res.ok) {
      return Response.json(
        { error: `cats-co message failed (${res.status})` },
        { status: 502 }
      );
    }
    return Response.json({ ok: true, type: "p2p_message", topicId });
  }

  if (kind === "agent") {
    // -- Send the bot a setup prompt via CatsCo P2P message — the bot's
    // owner reads it in CatsCo chat and pastes it into their agent runtime.
    // The prompt tells the bot to install sumi-kit, set env vars, and connect.
    const origin = publicOrigin(request);
    const setupUrl = `${origin}${apiPath(
      `/api/projects/${projectId}/agent-setup?fileId=README.md`
    )}`;

    const prompt = `# Sumi 协作 — agent 接入指南

你被邀请加入 Sumi 项目「${projectName || projectId}」。

## 快速接入

\`\`\`bash
export SUMI_BASE_URL="${origin}${apiPath("")}"
export SUMI_API_KEY="cc_..."   # 你的 CatsCo ApiKey

# 1. 安装 sumi-kit（如果还没有）
# curl -fsSL https://github.com/buildsense-ai/sumi/raw/main/sumi-kit/install.py | python3 -

# 2. 验证连接
sumi whoami

# 3. 拿完整的 agent prompt（推荐 — 有项目上下文）
sumi get-onboard-prompt --project ${projectId} --file README.md
\`\`\`

或者一次性看 prompt：

\`\`\`bash
curl -H "Authorization: Bearer $SUMI_API_KEY" "${setupUrl}" | jq -r .instructions
\`\`\`
`;

    // CatsCo P2P topic: p2p_{smaller_uid}_{larger_uid}
    const myUid = actor.uid;
    const botUid = Number(subjectId.slice(1)); // strip 'a' prefix
    const [a, b] = myUid < botUid ? [myUid, botUid] : [botUid, myUid];
    const topicId = `p2p_${a}_${b}`;

    const res = await fetch(`${CATSCO_BASE_URL}/api/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: credential,
      },
      body: JSON.stringify({
        topic_id: topicId,
        msg_type: "markdown",
        content: prompt,
      }),
    });
    if (!res.ok) {
      return Response.json(
        { error: `cats-co message failed (${res.status})` },
        { status: 502 }
      );
    }
    return Response.json({ ok: true, type: "p2p_message", topicId });
  }

  return Response.json({ error: "invalid kind" }, { status: 400 });
}

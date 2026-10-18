/**
 * What the ask dock should show.
 *
 * The dock is deliberately not a chat panel: no thread list, no scrollback, no
 * history. It answers one question — "what happened to the thing I last asked?" —
 * and that is the whole of its display logic, so it lives here rather than being
 * spread through the component.
 *
 * Pure and dependency-free; the component decides how to render the result.
 */

export interface AskIntentLike {
  id: string;
  projectId: string;
  fileId: string;
  status: string;
  prompt?: string | null;
  answerText?: string | null;
  answerEditId?: string | null;
  createdAt?: number | null;
}

export interface AskScope {
  projectId: string | null;
  fileId: string | null;
}

export type AskDockState =
  | { kind: "idle" }
  | { kind: "waiting"; prompt: string }
  | { kind: "answered"; prompt: string; answer: string; editId: string | null };

/**
 * The most recent ask in this scope, and what came of it.
 *
 * Only the newest counts: an older answer has already been read or acted on, and
 * surfacing it again is how a "no history" surface turns into an accidental
 * history. A stale answer left on screen while a new ask is in flight would also
 * read as a reply to the wrong question, so a newer unanswered ask wins over an
 * older answered one.
 */
export function askDockState(
  intents: readonly AskIntentLike[],
  scope: AskScope
): AskDockState {
  if (!scope.projectId) return { kind: "idle" };

  const relevant = intents.filter((i) => {
    if (!i || i.projectId !== scope.projectId) return false;
    // A null fileId means the project-wide surface; otherwise the ask must belong
    // to the document currently open.
    if (scope.fileId && i.fileId !== scope.fileId) return false;
    // Closed is settled and the author moved on — nothing to report.
    return i.status !== "closed";
  });

  if (relevant.length === 0) return { kind: "idle" };

  const newest = relevant.reduce((best, cur) =>
    (cur.createdAt ?? 0) >= (best.createdAt ?? 0) ? cur : best
  );

  const prompt = (newest.prompt ?? "").trim();
  const answer = (newest.answerText ?? "").trim();

  // An answered status with nothing to show is not an answer; treat it as still
  // waiting rather than presenting an empty box.
  if (newest.status === "answered" && answer) {
    return {
      kind: "answered",
      prompt,
      answer,
      editId: newest.answerEditId ?? null,
    };
  }

  return { kind: "waiting", prompt };
}

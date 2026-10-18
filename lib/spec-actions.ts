/**
 * What a Spec's action should do to the workspace.
 *
 * Actions arrive as data from a model, so they are validated and turned into a
 * plan before anything touches the app. Two reasons this is a pure function:
 * the dangerous inputs are exactly the ones worth testing (a `javascript:` URL, a
 * missing document id), and the component that executes a plan then has no
 * decisions left in it.
 */

export type SpecActionPlan =
  | { kind: "open_document"; documentId: string }
  | { kind: "focus_range"; documentId: string; startLine: number; endLine: number }
  | { kind: "apply_edit"; editId: string }
  | { kind: "clipboard"; text: string }
  | { kind: "url"; url: string };

/** Only these may be opened from a Spec — `javascript:` and `data:` may not. */
const SAFE_URL = /^https?:\/\//i;

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t : null;
}

export function specActionPlan(
  name: unknown,
  params: unknown
): SpecActionPlan | null {
  const action = nonEmptyString(name);
  if (!action) return null;
  const p = (params ?? {}) as Record<string, unknown>;

  switch (action) {
    case "open_document": {
      const documentId = nonEmptyString(p.documentId);
      return documentId ? { kind: "open_document", documentId } : null;
    }

    case "jump_to_line": {
      const documentId = nonEmptyString(p.documentId);
      const line = Number(p.line);
      if (!documentId || !Number.isFinite(line) || line < 1) return null;
      const to = Math.floor(line);
      return { kind: "focus_range", documentId, startLine: to, endLine: to };
    }

    case "apply_pending_edit": {
      const editId = nonEmptyString(p.editId);
      return editId ? { kind: "apply_edit", editId } : null;
    }

    case "copy_to_clipboard": {
      // Any string, including "" — copying nothing is a no-op, not a hazard.
      return typeof p.text === "string" ? { kind: "clipboard", text: p.text } : null;
    }

    case "open_url": {
      const url = nonEmptyString(p.url);
      if (!url || !SAFE_URL.test(url)) return null;
      return { kind: "url", url };
    }

    default:
      return null;
  }
}

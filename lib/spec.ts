/**
 * Spec-aware helpers.
 *
 * An agent's answer may be plain text or a json-render Spec. Deciding which is
 * one question, asked from two places (the renderer and the ask dock), so it lives
 * here rather than being re-implemented per caller.
 */

export interface ParsedSpec {
  root: string;
  elements: Record<string, unknown>;
}

/**
 * Parse a Spec out of an answer, or null when it is not one.
 *
 * Deliberately strict: a prose answer that merely starts with "{" must not be
 * mistaken for a Spec, because the renderer would then show a parse error where
 * the author wrote a sentence. Both keys are required for the same reason — a
 * `root` with no `elements` is a broken Spec, and rendering it produces noise
 * instead of falling back to the text.
 */
export function parseSpec(value: unknown): ParsedSpec | null {
  let obj: unknown = value;

  if (typeof value === "string") {
    const t = value.trim();
    if (!t.startsWith("{")) return null;
    try {
      obj = JSON.parse(t);
    } catch {
      return null;
    }
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const candidate = obj as { root?: unknown; elements?: unknown };
  if (typeof candidate.root !== "string" || !candidate.root) return null;
  if (
    !candidate.elements ||
    typeof candidate.elements !== "object" ||
    Array.isArray(candidate.elements)
  ) {
    return null;
  }
  // The root must actually exist in the element map, or <Renderer> finds nothing
  // to draw and the surface goes blank with no explanation.
  if (!(candidate.root in (candidate.elements as Record<string, unknown>))) {
    return null;
  }

  return {
    root: candidate.root,
    elements: candidate.elements as Record<string, unknown>,
  };
}

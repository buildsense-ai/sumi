/**
 * Line-based edit blocks — the application step, as a pure function.
 *
 * The same operation exists inside the ws-server, where it mutates a live Yjs
 * text. It is duplicated here because that path only works while a client holds
 * the room open: with nobody connected there is no in-memory doc, and writing
 * through the room silently does nothing. Applying to the canonical blob needs
 * the same arithmetic without the Yjs dependency, and keeping it pure makes the
 * boundary cases (last line, out-of-range anchors, overlapping blocks)
 * testable.
 *
 * Blocks are 1-based and inclusive at both ends, matching `EditBlock`.
 */

export interface LineBlock {
  startLine: number;
  endLine: number;
  updated: string;
}

export interface DriftReport {
  startLine: number;
  endLine: number;
  /** What the proposal recorded for that range. */
  expected: string;
  /** What the document actually holds there now. */
  found: string;
}

/**
 * Blocks whose recorded `original` no longer matches the document.
 *
 * The room path has CRDT anchors to re-resolve positions against; the storage
 * path has none, so a block carries only the line numbers and the text it was
 * written against. If the document moved since — lines inserted or removed above
 * the target — applying by those numbers rewrites whatever now occupies them.
 * The reviewer approved a specific passage and something else gets replaced,
 * which is indistinguishable from an edit landing in the wrong place or silently
 * not taking effect.
 *
 * Callers should refuse when this reports anything, rather than write blind.
 */
export function detectDrift(
  content: string,
  blocks: Array<LineBlock & { original?: string }>
): DriftReport[] {
  const lines = content.split("\n");
  const reports: DriftReport[] = [];

  for (const block of blocks) {
    // No `original` recorded is not evidence of drift — it is a caller that never
    // captured one. Out-of-range ranges are the apply step's to report.
    if (typeof block.original !== "string") continue;
    const startIdx = block.startLine - 1;
    const endIdx = block.endLine - 1;
    if (startIdx < 0 || endIdx < startIdx || endIdx >= lines.length) continue;

    const found = lines.slice(startIdx, endIdx + 1).join("\n");
    if (found !== block.original) {
      reports.push({
        startLine: block.startLine,
        endLine: block.endLine,
        expected: block.original,
        found,
      });
    }
  }

  return reports;
}

export interface ApplyResult {
  /** The document after every applicable block. */
  content: string;
  /** How many blocks landed. */
  applied: number;
  /** Blocks that could not be placed, with why — surfaced, never swallowed. */
  skipped: Array<{ block: LineBlock; reason: string }>;
}

/**
 * Apply blocks to `content`, bottom-up so earlier line numbers stay valid.
 *
 * A block whose range does not exist is reported and skipped rather than
 * clamped: clamping silently rewrites the wrong lines, and a reviewer who
 * approved "lines 12-14" would get an edit landed somewhere else.
 */
export function applyBlocksToContent(
  content: string,
  blocks: LineBlock[]
): ApplyResult {
  const skipped: ApplyResult["skipped"] = [];
  let applied = 0;

  // Descending by start line: a change at the bottom cannot shift the line
  // numbers a later (higher) block refers to.
  const ordered = [...blocks].sort((a, b) => b.startLine - a.startLine);

  let text = content;
  for (const block of ordered) {
    const lines = text.split("\n");
    const startIdx = block.startLine - 1;
    const endIdx = block.endLine - 1;

    if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx)) {
      skipped.push({ block, reason: "non-integer line range" });
      continue;
    }
    if (startIdx < 0 || endIdx < startIdx) {
      skipped.push({ block, reason: `invalid range ${block.startLine}-${block.endLine}` });
      continue;
    }
    if (endIdx >= lines.length) {
      skipped.push({
        block,
        reason: `line ${block.endLine} beyond document (${lines.length} lines)`,
      });
      continue;
    }

    let fromOffset = 0;
    for (let i = 0; i < startIdx; i++) fromOffset += lines[i].length + 1;
    let toOffset = fromOffset;
    for (let i = startIdx; i <= endIdx; i++) {
      toOffset += lines[i].length;
      if (i < lines.length - 1) toOffset += 1;
    }

    // Replacing the last line must not append a newline — that would grow the
    // document by a blank line on every such edit.
    const replacingLastLine = endIdx === lines.length - 1;
    let insert = block.updated;
    if (!replacingLastLine && !insert.endsWith("\n")) insert += "\n";

    text = text.slice(0, fromOffset) + insert + text.slice(toOffset);
    applied += 1;
  }

  return { content: text, applied, skipped };
}

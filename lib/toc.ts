/**
 * Table-of-contents model.
 *
 * Turns a document's headings plus the cursor position into everything the TOC
 * panel needs: which entries to show, which one is current, and how far through
 * the document the reader is. Pure and dependency-free, so the rules are testable
 * rather than being spread through JSX.
 */

import type { Heading } from "./outline";

export interface TocEntry extends Heading {
  /** Position in the unfiltered heading list — stable across filtering. */
  index: number;
}

export interface TocModel {
  /** Entries to render, in document order. */
  entries: TocEntry[];
  /** Heading count before filtering. */
  total: number;
  /** Deepest level present (0 when there are no headings). */
  levels: number;
  /** Index into `entries` of the current heading, -1 when none applies. */
  activeIndex: number;
  /** Line of the current heading, or null. */
  activeLine: number | null;
  /** How far through the document the cursor sits, 0..1. */
  progress: number;
}

/**
 * Heading containing `line` — the last one at or above it.
 *
 * Local rather than imported from `outline.ts` so the model can be computed from a
 * plain list in tests without pulling the markdown parser in.
 */
function headingAt(headings: readonly Heading[], line: number): Heading | null {
  let current: Heading | null = null;
  for (const h of headings) {
    if (h.line <= line) current = h;
    else break;
  }
  return current;
}

export function buildToc(
  headings: readonly Heading[],
  opts: {
    /** Case-insensitive substring match on heading text. */
    query?: string;
    /** 1-based cursor line. */
    cursorLine?: number | null;
    /** Document length, for the progress bar. */
    totalLines?: number;
  } = {}
): TocModel {
  const query = (opts.query ?? "").trim().toLowerCase();

  const all: TocEntry[] = headings.map((h, index) => ({ ...h, index }));

  const entries = query
    ? all.filter((h) => h.text.toLowerCase().includes(query))
    : all;

  const levels = all.reduce((max, h) => Math.max(max, h.level), 0);

  const cursorLine = opts.cursorLine ?? null;
  const current = cursorLine === null ? null : headingAt(all, cursorLine);

  // The active entry is matched by index, not by text: two headings may share a
  // title and the wrong one lighting up is a small lie about where you are.
  const activeIndex =
    current === null
      ? -1
      : entries.findIndex((e) => e.line === current.line && e.level === current.level);

  const totalLines = opts.totalLines ?? 0;
  const progress =
    cursorLine !== null && totalLines > 1
      ? Math.min(1, Math.max(0, (cursorLine - 1) / (totalLines - 1)))
      : 0;

  return {
    entries,
    total: all.length,
    levels,
    activeIndex,
    activeLine: current?.line ?? null,
    progress,
  };
}

/**
 * A json-render Spec for the outline, so an agent can hand the document's
 * structure back as UI instead of describing it in prose.
 *
 * Kept next to `buildToc` because it renders the same list; a Spec built from a
 * different traversal would drift from what the panel shows.
 */
export function tocSpec(
  headings: readonly Heading[],
  opts: { title?: string; documentId?: string; activeLine?: number | null } = {}
): { root: string; elements: Record<string, unknown> } {
  return {
    root: "toc",
    elements: {
      toc: {
        type: "TableOfContents",
        props: {
          title: opts.title ?? "目录",
          documentId: opts.documentId,
          activeLine: opts.activeLine ?? undefined,
          items: headings.map((h) => ({
            level: h.level,
            text: h.text || "（空标题）",
            line: h.line,
          })),
        },
      },
    },
  };
}

/**
 * TOC model.
 *
 * The outline panel's filter, active-section tracking and progress all come out of
 * `buildToc`, so the rules live here instead of in JSX. The interesting cases are
 * the ones where a naive implementation lies: two headings with the same text, a
 * cursor above the first heading, and filtering that hides the section you are in.
 */

import { describe, it, expect } from "vitest";
import { extractHeadings } from "../lib/outline";
import { buildToc, tocSpec } from "../lib/toc";

const DOC = [
  "# 引言", // 1
  "正文", // 2
  "## 背景", // 3
  "正文", // 4
  "## 背景", // 5 — duplicate title on purpose
  "正文", // 6
  "# 结论", // 7
].join("\n");

const headings = extractHeadings(DOC);

describe("buildToc — entries", () => {
  it("lists every heading in document order", () => {
    const toc = buildToc(headings);
    expect(toc.total).toBe(4);
    expect(toc.entries.map((e) => e.text)).toEqual([
      "引言",
      "背景",
      "背景",
      "结论",
    ]);
  });

  it("keeps the original index so filtering cannot shift identity", () => {
    const toc = buildToc(headings, { query: "结论" });
    expect(toc.entries).toHaveLength(1);
    // The surviving entry still knows it was the 4th heading, which is what keeps
    // the active marker attached to the right one.
    expect(toc.entries[0].index).toBe(3);
  });

  it("reports the deepest level present", () => {
    expect(buildToc(headings).levels).toBe(2);
    expect(buildToc([]).levels).toBe(0);
  });

  it("filters case-insensitively on a substring", () => {
    const mixed = extractHeadings("# Intro\n## INTRO two\n# Other");
    expect(buildToc(mixed, { query: "intro" }).entries).toHaveLength(2);
  });

  it("returns an empty list when nothing matches, without losing the total", () => {
    const toc = buildToc(headings, { query: "不存在的标题" });
    expect(toc.entries).toEqual([]);
    expect(toc.total).toBe(4);
  });

  it("treats a blank query as no filter", () => {
    expect(buildToc(headings, { query: "   " }).entries).toHaveLength(4);
  });
});

describe("buildToc — active heading", () => {
  it("marks nothing when there is no cursor", () => {
    const toc = buildToc(headings);
    expect(toc.activeIndex).toBe(-1);
    expect(toc.activeLine).toBeNull();
  });

  it("marks nothing above the first heading", () => {
    const doc = "\n\n# 后面才有标题";
    const h = extractHeadings(doc);
    expect(buildToc(h, { cursorLine: 1 }).activeIndex).toBe(-1);
  });

  it("marks the section the cursor sits under", () => {
    // Line 4 is the body of the first 背景 (line 3).
    const toc = buildToc(headings, { cursorLine: 4 });
    expect(toc.activeLine).toBe(3);
    expect(toc.entries[toc.activeIndex].text).toBe("背景");
    expect(toc.entries[toc.activeIndex].line).toBe(3);
  });

  it("picks the later heading when titles are identical", () => {
    // Matching by text would light up the first 背景 at line 3 while the reader is
    // actually in the one at line 5.
    const toc = buildToc(headings, { cursorLine: 6 });
    expect(toc.entries[toc.activeIndex].line).toBe(5);
  });

  it("stays on the heading line itself", () => {
    expect(buildToc(headings, { cursorLine: 7 }).activeLine).toBe(7);
  });

  it("reports no active entry when the filter hides the current section", () => {
    const toc = buildToc(headings, { cursorLine: 4, query: "结论" });
    expect(toc.entries).toHaveLength(1);
    expect(toc.activeIndex).toBe(-1);
    // The line is still known — the panel can say where you are even while the
    // list is filtered.
    expect(toc.activeLine).toBe(3);
  });
});

describe("buildToc — progress", () => {
  it("is 0 before the cursor is known", () => {
    expect(buildToc(headings, { totalLines: 20 }).progress).toBe(0);
  });

  it("runs from the first line to the last", () => {
    expect(buildToc(headings, { cursorLine: 1, totalLines: 11 }).progress).toBe(0);
    expect(buildToc(headings, { cursorLine: 11, totalLines: 11 }).progress).toBe(1);
  });

  it("is proportional in between", () => {
    expect(buildToc(headings, { cursorLine: 6, totalLines: 11 }).progress).toBeCloseTo(0.5);
  });

  it("clamps rather than overflowing the bar", () => {
    // A stale cursor line from a longer document must not push the bar past 100%.
    expect(buildToc(headings, { cursorLine: 99, totalLines: 11 }).progress).toBe(1);
  });

  it("is 0 for a one-line document", () => {
    expect(buildToc(headings, { cursorLine: 1, totalLines: 1 }).progress).toBe(0);
  });
});

describe("tocSpec", () => {
  it("wraps the same headings as a TableOfContents spec", () => {
    const spec = tocSpec(headings, { documentId: "prj_a-notes.md" });
    const el = spec.elements.toc as {
      type: string;
      props: { items: Array<{ level: number; text: string; line: number }>; documentId: string };
    };
    expect(el.type).toBe("TableOfContents");
    expect(el.props.documentId).toBe("prj_a-notes.md");
    expect(el.props.items).toHaveLength(4);
    expect(el.props.items[0]).toMatchObject({ level: 1, text: "引言", line: 1 });
  });

  it("names empty headings so the list has no blank rows", () => {
    const spec = tocSpec(extractHeadings("# \n## 有字"));
    const el = spec.elements.toc as { props: { items: Array<{ text: string }> } };
    expect(el.props.items[0].text).toBe("（空标题）");
  });

  it("roots at an element that exists", () => {
    const spec = tocSpec(headings);
    expect(spec.elements[spec.root]).toBeDefined();
  });
});

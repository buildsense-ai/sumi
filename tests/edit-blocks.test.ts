/**
 * Applying line blocks to document content.
 *
 * Why this is a pure function rather than a call into the Yjs room: the room is
 * only live while a client holds it open. With nobody connected, writing through
 * the room reports success and changes nothing — an edit "applied" that never
 * landed. Applying to the canonical blob needs the same line arithmetic without
 * a Yjs document, and keeping it pure is what makes the boundary cases testable.
 */

import { describe, it, expect } from "vitest";
import { applyBlocksToContent } from "../src/edit-blocks";

const DOC = ["line one", "line two", "line three", "line four"].join("\n");

describe("applyBlocksToContent — placement", () => {
  it("replaces a middle line", () => {
    const r = applyBlocksToContent(DOC, [
      { startLine: 2, endLine: 2, updated: "CHANGED" },
    ]);
    expect(r.applied).toBe(1);
    expect(r.skipped).toEqual([]);
    expect(r.content.split("\n")).toEqual([
      "line one",
      "CHANGED",
      "line three",
      "line four",
    ]);
  });

  it("replaces a range", () => {
    const r = applyBlocksToContent(DOC, [
      { startLine: 2, endLine: 3, updated: "REPLACED" },
    ]);
    expect(r.content.split("\n")).toEqual(["line one", "REPLACED", "line four"]);
  });

  it("does not grow the document when the last line is replaced", () => {
    // Appending a newline here would add a blank line on every such edit.
    const r = applyBlocksToContent(DOC, [
      { startLine: 4, endLine: 4, updated: "LAST" },
    ]);
    expect(r.content.split("\n")).toHaveLength(4);
    expect(r.content.endsWith("LAST")).toBe(true);
  });

  it("adds a newline when the replaced range is not the last line", () => {
    const r = applyBlocksToContent(DOC, [
      { startLine: 1, endLine: 1, updated: "FIRST" },
    ]);
    expect(r.content.split("\n")[1]).toBe("line two");
  });

  it("handles the first line", () => {
    const r = applyBlocksToContent(DOC, [
      { startLine: 1, endLine: 1, updated: "TOP" },
    ]);
    expect(r.content.startsWith("TOP\n")).toBe(true);
  });

  it("handles an empty document as one empty line", () => {
    const r = applyBlocksToContent("", [{ startLine: 1, endLine: 1, updated: "x" }]);
    expect(r.applied).toBe(1);
    expect(r.content).toBe("x");
  });

  it("keeps a single-line document single-line", () => {
    const r = applyBlocksToContent("only", [
      { startLine: 1, endLine: 1, updated: "changed" },
    ]);
    expect(r.content).toBe("changed");
  });
});

describe("applyBlocksToContent — order", () => {
  it("applies bottom-up so earlier line numbers stay valid", () => {
    // Top-down would shift line 3 to line 1 after the first edit.
    const r = applyBlocksToContent(DOC, [
      { startLine: 1, endLine: 1, updated: "A" },
      { startLine: 3, endLine: 3, updated: "C" },
    ]);
    expect(r.applied).toBe(2);
    expect(r.content.split("\n")).toEqual(["A", "line two", "C", "line four"]);
  });

  it("is insensitive to the order blocks arrive in", () => {
    const forwards = applyBlocksToContent(DOC, [
      { startLine: 1, endLine: 1, updated: "A" },
      { startLine: 3, endLine: 3, updated: "C" },
    ]);
    const backwards = applyBlocksToContent(DOC, [
      { startLine: 3, endLine: 3, updated: "C" },
      { startLine: 1, endLine: 1, updated: "A" },
    ]);
    expect(forwards.content).toBe(backwards.content);
  });

  it("applies two adjacent blocks from the bottom", () => {
    const r = applyBlocksToContent(DOC, [
      { startLine: 1, endLine: 2, updated: "TOP" },
      { startLine: 3, endLine: 4, updated: "BOTTOM" },
    ]);
    expect(r.content.split("\n")).toEqual(["TOP", "BOTTOM"]);
  });
});

describe("applyBlocksToContent — refusals", () => {
  it("skips a range past the end instead of clamping", () => {
    // Clamping would silently rewrite the wrong lines, and the reviewer
    // approved a different range.
    const r = applyBlocksToContent(DOC, [
      { startLine: 2, endLine: 99, updated: "NOPE" },
    ]);
    expect(r.applied).toBe(0);
    expect(r.content).toBe(DOC);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toContain("beyond document");
  });

  it("skips an inverted range", () => {
    const r = applyBlocksToContent(DOC, [
      { startLine: 3, endLine: 1, updated: "NOPE" },
    ]);
    expect(r.applied).toBe(0);
    expect(r.skipped[0].reason).toContain("invalid range");
  });

  it("skips a zero or negative start line", () => {
    // Line numbers are 1-based; 0 is not "the beginning", it is out of range.
    const r = applyBlocksToContent(DOC, [
      { startLine: 0, endLine: 1, updated: "NOPE" },
    ]);
    expect(r.applied).toBe(0);
    expect(r.skipped).toHaveLength(1);
  });

  it("keeps the good blocks when one is bad", () => {
    const r = applyBlocksToContent(DOC, [
      { startLine: 2, endLine: 2, updated: "GOOD" },
      { startLine: 50, endLine: 60, updated: "BAD" },
    ]);
    expect(r.applied).toBe(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.content.split("\n")[1]).toBe("GOOD");
  });

  it("reports a non-integer line number", () => {
    const r = applyBlocksToContent(DOC, [
      { startLine: 1.5, endLine: 2, updated: "NOPE" },
    ]);
    expect(r.applied).toBe(0);
    expect(r.skipped[0].reason).toContain("non-integer");
  });

  it("does nothing for an empty block list", () => {
    const r = applyBlocksToContent(DOC, []);
    expect(r.applied).toBe(0);
    expect(r.content).toBe(DOC);
  });
});

describe("applyBlocksToContent — content fidelity", () => {
  it("preserves surrounding whitespace and blank lines", () => {
    const doc = "a\n\nb\n\nc";
    const r = applyBlocksToContent(doc, [
      { startLine: 3, endLine: 3, updated: "B" },
    ]);
    expect(r.content).toBe("a\n\nB\n\nc");
  });

  it("inserts multi-line replacement text verbatim", () => {
    const r = applyBlocksToContent(DOC, [
      { startLine: 2, endLine: 2, updated: "# Title\n\nbody" },
    ]);
    expect(r.content).toBe("line one\n# Title\n\nbody\nline three\nline four");
  });

  it("does not interpret replacement text as a pattern", () => {
    // A `$&` here would be expanded by String.replace; slicing must not.
    const r = applyBlocksToContent(DOC, [
      { startLine: 1, endLine: 1, updated: "$& $1 \\n" },
    ]);
    expect(r.content.startsWith("$& $1 \\n\n")).toBe(true);
  });

  it("leaves CRLF content alone apart from the edited line", () => {
    const doc = "a\r\nb\r\nc";
    const r = applyBlocksToContent(doc, [
      { startLine: 3, endLine: 3, updated: "c2" },
    ]);
    expect(r.content).toBe("a\r\nb\r\nc2");
  });
});

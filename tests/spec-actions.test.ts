/**
 * Spec parsing and action planning.
 *
 * Both guard the boundary where a model's output becomes app behaviour. A Spec that
 * is only *nearly* right must fall back to showing the text rather than rendering a
 * broken card, and an action must not be able to reach anything the catalog did not
 * declare — `open_url` in particular.
 */

import { describe, it, expect } from "vitest";
import { parseSpec } from "../lib/spec";
import { specActionPlan } from "../lib/spec-actions";

const GOOD = {
  root: "c1",
  elements: {
    c1: { type: "Card", props: { title: "x" } },
  },
};

describe("parseSpec", () => {
  it("accepts a well-formed object", () => {
    expect(parseSpec(GOOD)).toMatchObject({ root: "c1" });
  });

  it("accepts the same spec as a JSON string", () => {
    expect(parseSpec(JSON.stringify(GOOD))).toMatchObject({ root: "c1" });
  });

  it("rejects prose that merely starts with a brace", () => {
    // Falling through to the text path is what keeps a sentence readable instead
    // of replacing it with a parse error.
    expect(parseSpec("{这只是中文说明，不是 spec}")).toBeNull();
  });

  it("rejects malformed JSON", () => {
    expect(parseSpec('{"root": "c1", ')).toBeNull();
  });

  it("requires both root and elements", () => {
    expect(parseSpec({ root: "c1" })).toBeNull();
    expect(parseSpec({ elements: {} })).toBeNull();
  });

  it("requires the root to exist in elements", () => {
    // Otherwise <Renderer> has nothing to draw and the surface goes blank.
    expect(parseSpec({ root: "missing", elements: { other: {} } })).toBeNull();
  });

  it("rejects non-objects and arrays", () => {
    expect(parseSpec(null)).toBeNull();
    expect(parseSpec(42)).toBeNull();
    expect(parseSpec([GOOD])).toBeNull();
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseSpec(`\n  ${JSON.stringify(GOOD)}  \n`)).toMatchObject({ root: "c1" });
  });
});

describe("specActionPlan — document actions", () => {
  it("plans opening a document", () => {
    expect(
      specActionPlan("open_document", { documentId: "prj_a-notes.md" })
    ).toEqual({ kind: "open_document", documentId: "prj_a-notes.md" });
  });

  it("refuses an open with no id", () => {
    expect(specActionPlan("open_document", {})).toBeNull();
    expect(specActionPlan("open_document", { documentId: "   " })).toBeNull();
  });

  it("turns jump_to_line into a one-line range", () => {
    expect(
      specActionPlan("jump_to_line", { documentId: "prj_a-notes.md", line: 12 })
    ).toEqual({
      kind: "focus_range",
      documentId: "prj_a-notes.md",
      startLine: 12,
      endLine: 12,
    });
  });

  it("refuses a jump with no line, or line 0", () => {
    // Line numbers are 1-based; 0 is out of range, not "the top".
    expect(specActionPlan("jump_to_line", { documentId: "d" })).toBeNull();
    expect(specActionPlan("jump_to_line", { documentId: "d", line: 0 })).toBeNull();
    expect(specActionPlan("jump_to_line", { documentId: "d", line: "x" })).toBeNull();
  });

  it("floors a fractional line instead of passing it through", () => {
    expect(specActionPlan("jump_to_line", { documentId: "d", line: 7.9 })).toMatchObject({
      startLine: 7,
    });
  });

  it("plans applying a pending edit", () => {
    expect(specActionPlan("apply_pending_edit", { editId: "edit_1" })).toEqual({
      kind: "apply_edit",
      editId: "edit_1",
    });
    expect(specActionPlan("apply_pending_edit", {})).toBeNull();
  });
});

describe("specActionPlan — clipboard and links", () => {
  it("allows copying, including an empty string", () => {
    expect(specActionPlan("copy_to_clipboard", { text: "hi" })).toEqual({
      kind: "clipboard",
      text: "hi",
    });
    // A no-op, not a hazard.
    expect(specActionPlan("copy_to_clipboard", { text: "" })).toEqual({
      kind: "clipboard",
      text: "",
    });
  });

  it("refuses a non-string copy payload", () => {
    expect(specActionPlan("copy_to_clipboard", { text: 42 })).toBeNull();
    expect(specActionPlan("copy_to_clipboard", {})).toBeNull();
  });

  it("opens http and https links", () => {
    expect(specActionPlan("open_url", { url: "https://example.com/a" })).toEqual({
      kind: "url",
      url: "https://example.com/a",
    });
    expect(specActionPlan("open_url", { url: "http://example.com" })).toMatchObject({
      kind: "url",
    });
  });

  it("refuses a javascript: URL", () => {
    // A Spec is model output; `window.open` on this would run script in the app's
    // own context.
    expect(specActionPlan("open_url", { url: "javascript:alert(1)" })).toBeNull();
  });

  it("refuses data: and relative URLs", () => {
    expect(specActionPlan("open_url", { url: "data:text/html,<script>1</script>" })).toBeNull();
    expect(specActionPlan("open_url", { url: "/api/documents/content" })).toBeNull();
  });
});

describe("specActionPlan — unknown input", () => {
  it("refuses an action the catalog never declared", () => {
    expect(specActionPlan("run_shell", { cmd: "rm -rf /" })).toBeNull();
  });

  it("refuses a missing or empty action name", () => {
    expect(specActionPlan(undefined, {})).toBeNull();
    expect(specActionPlan("", {})).toBeNull();
  });

  it("tolerates missing params", () => {
    expect(specActionPlan("open_document", undefined)).toBeNull();
  });
});

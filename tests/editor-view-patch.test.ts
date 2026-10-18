/**
 * The `set_editor_view` patch.
 *
 * The source / split / preview toggle lives in component state, which a store
 * update cannot reach. The patch therefore records a one-shot request in the
 * store and the shell applies it — so the store side has two things worth
 * pinning: the payload is validated, and asking twice actually asks twice.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { validateUiPatch } from "../src/a2ui/validate";
import { useUiStore } from "../stores/ui-store";

beforeEach(() => {
  useUiStore.setState({ editorViewCommand: null });
});

describe("validateUiPatch", () => {
  it("accepts each of the three modes", () => {
    for (const view of ["source", "split", "preview"] as const) {
      const patch = validateUiPatch({ type: "set_editor_view", view });
      expect(patch).not.toBeNull();
      expect(patch).toMatchObject({ type: "set_editor_view", view });
    }
  });

  it("refuses an unknown mode", () => {
    // A typo must not reach the shell as "switch to undefined".
    expect(validateUiPatch({ type: "set_editor_view", view: "pdf" })).toBeNull();
    expect(validateUiPatch({ type: "set_editor_view" })).toBeNull();
    expect(validateUiPatch({ type: "set_editor_view", view: 1 })).toBeNull();
  });

  it("still refuses a kind that was never registered", () => {
    expect(validateUiPatch({ type: "definitely_not_a_patch" })).toBeNull();
  });
});

describe("applyUiPatch('set_editor_view')", () => {
  it("records a request with the view and an id", () => {
    useUiStore
      .getState()
      .applyUiPatch({ type: "set_editor_view", view: "preview" });

    const cmd = useUiStore.getState().editorViewCommand;
    expect(cmd?.view).toBe("preview");
    expect(cmd?.id).toBeTruthy();
  });

  it("issues a new id when the same view is requested again", () => {
    // Without a fresh id the second request is indistinguishable from the first
    // and would be dropped as a no-op state change.
    useUiStore.getState().applyUiPatch({ type: "set_editor_view", view: "split" });
    const first = useUiStore.getState().editorViewCommand?.id;

    useUiStore.getState().applyUiPatch({ type: "set_editor_view", view: "split" });
    const second = useUiStore.getState().editorViewCommand?.id;

    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("acknowledges by clearing", () => {
    useUiStore.getState().applyUiPatch({ type: "set_editor_view", view: "preview" });
    expect(useUiStore.getState().editorViewCommand).not.toBeNull();

    useUiStore.getState().consumeEditorView();
    expect(useUiStore.getState().editorViewCommand).toBeNull();
  });

  it("does not disturb the panel or document state", () => {
    // The editor view is a presentation concern; it must not move the user
    // anywhere else while switching modes.
    const before = useUiStore.getState();
    useUiStore.getState().applyUiPatch({ type: "set_editor_view", view: "preview" });
    const after = useUiStore.getState();

    expect(after.activeMainBlock).toBe(before.activeMainBlock);
    expect(after.currentDocumentId).toBe(before.currentDocumentId);
    expect(after.panelVisibility).toEqual(before.panelVisibility);
  });

  it("leaves an unrelated patch alone", () => {
    useUiStore.getState().applyUiPatch({ type: "set_editor_view", view: "preview" });
    useUiStore.getState().applyUiPatch({ type: "noop" });
    expect(useUiStore.getState().editorViewCommand?.view).toBe("preview");
  });
});

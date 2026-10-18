/**
 * The UI patch surface — which chrome an agent can actually drive.
 *
 * The recurring defect here is not a missing patch kind but a patch kind whose
 * target lives in component-local state: the store updates, the screen does not,
 * and from the outside the assistant "cannot change the UI". These cases pair each
 * patch with the state the UI now reads from, so a future refactor that moves it
 * back into local state fails here instead of in a user's session.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { validateUiPatch } from "../src/a2ui/validate";
import { useUiStore } from "../stores/ui-store";

function reset() {
  useUiStore.setState({
    sidebarTab: "outline",
    projectView: "list",
    panelVisibility: { sidebar: false, ai: false, inspector: false },
    layout: { sidebarSide: "right", splitRatio: 0.5 },
    panelWidth: { sidebar: 22, ai: 34, inspector: 26 },
    editorViewCommand: null,
    focusRangeCommand: null,
    promptCommand: null,
    pendingPromptCommands: [],
  });
}

beforeEach(reset);

describe("validateUiPatch — new kinds", () => {
  it("accepts each sidebar tab", () => {
    for (const tab of ["outline", "members", "history"] as const) {
      expect(validateUiPatch({ type: "set_sidebar_tab", tab })).toMatchObject({ tab });
    }
  });

  it("accepts a visibility hint and rejects an unknown tab", () => {
    expect(
      validateUiPatch({ type: "set_sidebar_tab", tab: "members", visible: false })
    ).toMatchObject({ visible: false });
    expect(validateUiPatch({ type: "set_sidebar_tab", tab: "chat" })).toBeNull();
    expect(validateUiPatch({ type: "set_sidebar_tab" })).toBeNull();
  });

  it("accepts both project views and rejects anything else", () => {
    expect(validateUiPatch({ type: "set_project_view", view: "table" })).toMatchObject({
      view: "table",
    });
    expect(validateUiPatch({ type: "set_project_view", view: "grid" })).toBeNull();
  });
});

describe("applyUiPatch — sidebar tab", () => {
  it("switches the tab the UI reads", () => {
    useUiStore.getState().applyUiPatch({ type: "set_sidebar_tab", tab: "members" });
    expect(useUiStore.getState().sidebarTab).toBe("members");
  });

  it("opens the sidebar by default", () => {
    // Selecting a tab nobody can see is a no-op from the user's side.
    expect(useUiStore.getState().panelVisibility.sidebar).toBe(false);
    useUiStore.getState().applyUiPatch({ type: "set_sidebar_tab", tab: "history" });
    expect(useUiStore.getState().panelVisibility.sidebar).toBe(true);
  });

  it("honours an explicit visible:false", () => {
    useUiStore.setState({ panelVisibility: { sidebar: true, ai: false, inspector: false } });
    useUiStore
      .getState()
      .applyUiPatch({ type: "set_sidebar_tab", tab: "outline", visible: false });
    expect(useUiStore.getState().panelVisibility.sidebar).toBe(false);
    // The tab still changed: hiding is a separate instruction from selecting.
    expect(useUiStore.getState().sidebarTab).toBe("outline");
  });

  it("raises attention on the sidebar", () => {
    useUiStore.getState().applyUiPatch({ type: "set_sidebar_tab", tab: "members" });
    expect(useUiStore.getState().attentionSignal?.target).toBe("sidebar");
  });

  it("leaves the other panels alone", () => {
    useUiStore.setState({ panelVisibility: { sidebar: false, ai: true, inspector: true } });
    useUiStore.getState().applyUiPatch({ type: "set_sidebar_tab", tab: "members" });
    const v = useUiStore.getState().panelVisibility;
    expect(v.ai).toBe(true);
    expect(v.inspector).toBe(true);
  });
});

describe("applyUiPatch — project view", () => {
  it("switches the list / table presentation", () => {
    useUiStore.getState().applyUiPatch({ type: "set_project_view", view: "table" });
    expect(useUiStore.getState().projectView).toBe("table");
    useUiStore.getState().applyUiPatch({ type: "set_project_view", view: "list" });
    expect(useUiStore.getState().projectView).toBe("list");
  });

  it("does not open a panel or move the document", () => {
    const before = useUiStore.getState();
    useUiStore.getState().applyUiPatch({ type: "set_project_view", view: "table" });
    const after = useUiStore.getState();
    expect(after.panelVisibility).toEqual(before.panelVisibility);
    expect(after.currentDocumentId).toBe(before.currentDocumentId);
  });
});

describe("applyUiPatch — the whole chrome is reachable", () => {
  it("can compose a full workspace arrangement from patches alone", () => {
    // The point of the surface: each of these used to be either missing or wired to
    // state the patch could not touch.
    const { applyUiPatch } = useUiStore.getState();

    applyUiPatch({ type: "open_document", documentId: "prj_a-notes.md" });
    applyUiPatch({ type: "set_editor_view", view: "preview" });
    applyUiPatch({ type: "set_sidebar_tab", tab: "outline" });
    applyUiPatch({ type: "set_panel_size", panel: "sidebar", widthPercent: 30 });
    applyUiPatch({ type: "set_project_view", view: "table" });

    const s = useUiStore.getState();
    expect(s.currentDocumentId).toBe("prj_a-notes.md");
    expect(s.editorViewCommand?.view).toBe("preview");
    expect(s.sidebarTab).toBe("outline");
    expect(s.panelVisibility.sidebar).toBe(true);
    expect(s.panelWidth.sidebar).toBe(30);
    expect(s.projectView).toBe("table");
  });

  it("clamps an out-of-range panel width instead of applying it", () => {
    const { applyUiPatch } = useUiStore.getState();
    applyUiPatch({ type: "set_panel_size", panel: "sidebar", widthPercent: 200 });
    expect(useUiStore.getState().panelWidth.sidebar).toBe(90);
    applyUiPatch({ type: "set_panel_size", panel: "sidebar", widthPercent: 1 });
    expect(useUiStore.getState().panelWidth.sidebar).toBe(10);
  });
});

describe("applyUiPatch — theme", () => {
  it("sets the accent without disturbing density", () => {
    // Merged rather than replaced: a theme call that only names the accent must not
    // silently reset the other axis.
    useUiStore.getState().applyUiPatch({ type: "set_theme", accent: "violet" });
    const t = useUiStore.getState().theme;
    expect(t.accent).toBe("violet");
    expect(t.density).toBe("comfortable");
  });

  it("sets the density without disturbing the accent", () => {
    useUiStore.getState().applyUiPatch({ type: "set_theme", accent: "emerald" });
    useUiStore.getState().applyUiPatch({ type: "set_theme", density: "compact" });
    const t = useUiStore.getState().theme;
    expect(t.accent).toBe("emerald");
    expect(t.density).toBe("compact");
  });

  it("accepts a no-op theme patch", () => {
    const before = useUiStore.getState().theme;
    useUiStore.getState().applyUiPatch({ type: "set_theme" });
    expect(useUiStore.getState().theme).toEqual(before);
  });

  it("validates both closed vocabularies", () => {
    expect(validateUiPatch({ type: "set_theme", accent: "violet" })).toMatchObject({
      accent: "violet",
    });
    expect(validateUiPatch({ type: "set_theme", density: "compact" })).toMatchObject({
      density: "compact",
    });
    expect(validateUiPatch({ type: "set_theme", accent: "neon" })).toBeNull();
    expect(validateUiPatch({ type: "set_theme", density: "airy" })).toBeNull();
  });

  it("does not touch layout state", () => {
    // Theme is presentation only — it must not move the user or open a panel.
    const before = useUiStore.getState();
    useUiStore.getState().applyUiPatch({ type: "set_theme", accent: "rose" });
    const after = useUiStore.getState();
    expect(after.panelVisibility).toEqual(before.panelVisibility);
    expect(after.currentDocumentId).toBe(before.currentDocumentId);
    expect(after.sidebarTab).toBe(before.sidebarTab);
  });
});

describe("applyUiPatch — layout", () => {
  it("moves the sidebar to either edge", () => {
    useUiStore.getState().applyUiPatch({ type: "set_layout", sidebarSide: "left" });
    expect(useUiStore.getState().layout.sidebarSide).toBe("left");
    useUiStore.getState().applyUiPatch({ type: "set_layout", sidebarSide: "right" });
    expect(useUiStore.getState().layout.sidebarSide).toBe("right");
  });

  it("merges, so an empty patch leaves the skeleton alone", () => {
    useUiStore.getState().applyUiPatch({ type: "set_layout", sidebarSide: "left" });
    useUiStore.getState().applyUiPatch({ type: "set_layout" });
    expect(useUiStore.getState().layout.sidebarSide).toBe("left");
  });

  it("rejects an edge that is not a side", () => {
    expect(validateUiPatch({ type: "set_layout", sidebarSide: "top" })).toBeNull();
    expect(validateUiPatch({ type: "set_layout" })).not.toBeNull();
  });

  it("is independent of visibility and width", () => {
    // Three different questions: where it sits, whether it exists, how wide it is.
    // Conflating them is how a "layout" patch ends up silently resizing the panel.
    useUiStore.setState({
      panelVisibility: { sidebar: true, ai: false, inspector: false },
      panelWidth: { sidebar: 30, ai: 34, inspector: 26 },
    });
    useUiStore.getState().applyUiPatch({ type: "set_layout", sidebarSide: "left" });

    const s = useUiStore.getState();
    expect(s.layout.sidebarSide).toBe("left");
    expect(s.panelVisibility.sidebar).toBe(true);
    expect(s.panelWidth.sidebar).toBe(30);
  });
});

describe("applyUiPatch — split ratio", () => {
  it("re-proportions the split view", () => {
    useUiStore.getState().applyUiPatch({ type: "set_layout", splitRatio: 0.3 });
    expect(useUiStore.getState().layout.splitRatio).toBe(0.3);
  });

  it("clamps rather than hiding a pane", () => {
    // A vanishing pane reads as "the preview broke", not as an out-of-range number.
    useUiStore.getState().applyUiPatch({ type: "set_layout", splitRatio: 0.01 });
    expect(useUiStore.getState().layout.splitRatio).toBe(0.2);
    useUiStore.getState().applyUiPatch({ type: "set_layout", splitRatio: 4 });
    expect(useUiStore.getState().layout.splitRatio).toBe(0.8);
  });

  it("does not move the panel when only the ratio changes", () => {
    useUiStore.getState().applyUiPatch({ type: "set_layout", sidebarSide: "right" });
    useUiStore.getState().applyUiPatch({ type: "set_layout", splitRatio: 0.35 });
    expect(useUiStore.getState().layout.sidebarSide).toBe("right");
  });

  it("rejects a ratio that is not a number", () => {
    expect(validateUiPatch({ type: "set_layout", splitRatio: "half" })).toBeNull();
    expect(validateUiPatch({ type: "set_layout", splitRatio: -1 })).toBeNull();
  });
});

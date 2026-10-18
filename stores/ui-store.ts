"use client";

/**
 * Workspace UI store — applies UiPatch commands pushed by the SSE endpoint.
 *
 * Pattern lifted from the reference workspace-ui-store: each patch sets the
 * appropriate state slice AND fires a `blockAttentionSignal` so the shell
 * can flash which pane changed.
 */

import { create } from "zustand";
import type {
  UiPatch,
  WorkspaceMainBlock,
  PanelName,
} from "@/src/a2ui/schema";

export type AttentionTarget = "editor" | "sidebar" | "ai" | "inspector" | "graph" | "preview" | "management";

export interface AttentionSignal {
  id: string;
  target: AttentionTarget;
  reason: "ui_patch" | "cross_tab_insert" | "navigation";
}

export interface PromptCommand {
  id: string;
  prompt: string;
  autoSend: boolean;
}

export interface FocusRangeCommand {
  id: string;
  documentId: string;
  startLine: number;
  endLine: number;
}

interface UiStoreState {
  currentDocumentId: string | null;
  /** Open doc tabs — the user can flip between them without leaving editor. */
  openDocuments: string[];
  activeMainBlock: WorkspaceMainBlock;
  panelVisibility: Record<PanelName, boolean>;
  panelWidth: Record<PanelName, number>;
  attentionSignal: AttentionSignal | null;
  promptCommand: PromptCommand | null;
  pendingPromptCommands: PromptCommand[];
  focusRangeCommand: FocusRangeCommand | null;
  /**
   * Which sidebar tab is showing.
   *
   * Lives here rather than in the shell's local state so a patch can select it:
   * a tab the assistant cannot reach is a tab the assistant cannot show you.
   */
  sidebarTab: "outline" | "members" | "history";
  /** Project list presentation — the list / table toggle. */
  projectView: "list" | "table";
  /**
   * Accent and density.
   *
   * Applied to the shell as data attributes rather than baked into a build: the
   * primitives read their colours and radii from CSS tokens, so a patch can restyle
   * the workspace without a redeploy.
   */
  theme: {
    accent: "cyan" | "violet" | "emerald" | "amber" | "rose" | "slate";
    density: "compact" | "comfortable";
  };
  /**
   * Workspace skeleton — where panels sit, as opposed to whether they exist
   * (`panelVisibility`) or how wide they are (`panelWidth`).
   */
  layout: {
    /** Which edge the editor sidebar docks to. */
    sidebarSide: "left" | "right";
    /**
     * Share of the split view given to the editor, 0.2–0.8.
     *
     * Only meaningful in the split view. Bounded because a pane narrower than a
     * fifth is not usable, and an unbounded ratio would let a stray value hide one
     * of the two panes entirely — which reads as "the preview broke".
     */
    splitRatio: number;
  };
  /**
   * One-shot request to change the editor's view mode.
   *
   * The toggle is local component state today, so a patch cannot reach it by
   * setting a shared field; it asks instead, and the shell applies the request
   * and acknowledges it — same handshake as `focusRangeCommand`.
   */
  editorViewCommand: { id: string; view: "source" | "split" | "preview" } | null;
  /** Bumped when a doc version is restored — keys off `${projectId}-${fileId}`. */
  lastRestore: { documentId: string; fileId: string; versionId: string; token: number } | null;

  setCurrentDocumentId: (id: string | null) => void;
  closeDocument: (id: string) => void;
  setActiveMainBlock: (block: WorkspaceMainBlock) => void;
  setPanelVisibility: (panel: PanelName, visible: boolean) => void;
  setPanelWidth: (panel: PanelName, widthPercent: number) => void;
  setSidebarTab: (tab: "outline" | "members" | "history") => void;
  setProjectView: (view: "list" | "table") => void;
  setTheme: (next: Partial<UiStoreState["theme"]>) => void;
  setLayout: (next: Partial<UiStoreState["layout"]>) => void;
  triggerAttention: (target: AttentionTarget, reason?: AttentionSignal["reason"]) => void;
  consumeAttention: () => void;
  consumePromptCommand: () => void;
  consumeFocusRange: () => void;
  consumeEditorView: () => void;
  applyUiPatch: (patch: UiPatch) => void;
}

const signal = (target: AttentionTarget, reason: AttentionSignal["reason"] = "ui_patch"): AttentionSignal => ({
  id: `attention-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  target,
  reason,
});

export const useUiStore = create<UiStoreState>((set, get) => ({
  currentDocumentId: null,
  openDocuments: [],
  activeMainBlock: "editor",
  panelVisibility: { sidebar: true, ai: false, inspector: false },
  panelWidth: { sidebar: 22, ai: 34, inspector: 26 },
  attentionSignal: null,
  promptCommand: null,
  pendingPromptCommands: [],
  focusRangeCommand: null,
  sidebarTab: "outline",
  projectView: "list",
  theme: { accent: "cyan", density: "comfortable" },
  layout: { sidebarSide: "right", splitRatio: 0.5 },
  editorViewCommand: null,
  lastRestore: null,

  setCurrentDocumentId: (id) =>
    set((state) => {
      const openDocuments = id
        ? state.openDocuments.includes(id)
          ? state.openDocuments
          : [...state.openDocuments, id]
        : state.openDocuments;
      return {
        currentDocumentId: id,
        openDocuments,
        activeMainBlock:
          id && state.currentDocumentId !== id
            ? state.activeMainBlock === "management" ? "editor" : state.activeMainBlock
            : !id && state.activeMainBlock !== "editor" && state.activeMainBlock !== "management"
              ? "editor"
              : state.activeMainBlock,
      };
    }),

  /** Close one open doc tab. If it was current, activate the previous. */
  closeDocument: (id: string) => {
    const { openDocuments, currentDocumentId } = get();
    const remaining = openDocuments.filter((d) => d !== id);
    set({
      openDocuments: remaining,
      currentDocumentId:
        currentDocumentId === id
          ? remaining[remaining.length - 1] ?? null
          : currentDocumentId,
      activeMainBlock:
        currentDocumentId === id ? "editor" : get().activeMainBlock,
    });
  },

  setActiveMainBlock: (block) =>
    set((state) => ({
      activeMainBlock:
        !state.currentDocumentId && block !== "editor" && block !== "management"
          ? "editor"
          : block,
    })),

  setPanelVisibility: (panel, visible) =>
    set((state) => ({
      panelVisibility: { ...state.panelVisibility, [panel]: visible },
    })),

  setPanelWidth: (panel, widthPercent) =>
    set((state) => ({
      panelWidth: {
        ...state.panelWidth,
        [panel]: Math.max(10, Math.min(90, widthPercent)),
      },
    })),

  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setProjectView: (view) => set({ projectView: view }),
  setTheme: (next) =>
    set((state) => ({ theme: { ...state.theme, ...next } })),
  setLayout: (next) =>
    set((state) => ({ layout: { ...state.layout, ...next } })),

  triggerAttention: (target, reason) =>
    set({ attentionSignal: signal(target, reason) }),
  consumeAttention: () => set({ attentionSignal: null }),
  consumeFocusRange: () => set({ focusRangeCommand: null }),
  consumeEditorView: () => set({ editorViewCommand: null }),

  consumePromptCommand: () =>
    set((state) => {
      if (state.pendingPromptCommands.length === 0) {
        return { promptCommand: null };
      }
      const [next, ...rest] = state.pendingPromptCommands;
      return { promptCommand: next, pendingPromptCommands: rest };
    }),

  applyUiPatch: (patch) => {
    const queuePrompt = (prompt: string, autoSend = false) =>
      set((state) => {
        const cmd: PromptCommand = {
          id: `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          prompt,
          autoSend,
        };
        return {
          promptCommand: state.promptCommand ?? cmd,
          pendingPromptCommands: state.promptCommand
            ? [...state.pendingPromptCommands, cmd]
            : state.pendingPromptCommands,
          panelVisibility: { ...state.panelVisibility, ai: true },
          attentionSignal: signal("ai", "cross_tab_insert"),
        };
      });

    switch (patch.type) {
      case "open_document":
        set({
          activeMainBlock: "editor",
          currentDocumentId: patch.documentId,
          attentionSignal: signal("editor", "navigation"),
        });
        return;

      case "show_management":
        set({
          activeMainBlock: "management",
          currentDocumentId: null,
        });
        return;

      case "show_ai_chat":
        set((state) => ({
          panelVisibility: { ...state.panelVisibility, ai: true },
          attentionSignal: signal("ai"),
        }));
        return;

      case "set_main_block":
        set((state) => {
          const next: WorkspaceMainBlock =
            !state.currentDocumentId &&
            (patch.block === "graph" || patch.block === "preview")
              ? "editor"
              : patch.block;
          const target: AttentionTarget =
            next === "graph" ? "graph" : next === "preview" ? "preview" : "editor";
          return { activeMainBlock: next, attentionSignal: signal(target) };
        });
        return;

      case "set_panel_visibility":
        set((state) => ({
          panelVisibility: {
            ...state.panelVisibility,
            [patch.panel]: patch.visible,
          },
          attentionSignal: signal(patch.panel),
        }));
        return;

      case "set_panel_size":
        set((state) => ({
          panelWidth: {
            ...state.panelWidth,
            [patch.panel]: Math.max(10, Math.min(90, patch.widthPercent)),
          },
          attentionSignal: signal(patch.panel),
        }));
        return;

      case "queue_prompt":
        queuePrompt(patch.prompt, patch.autoSend ?? false);
        return;

      case "focus_document_range":
        set((state) => ({
          currentDocumentId: patch.documentId,
          activeMainBlock: "editor",
          focusRangeCommand: {
            id: `focus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            documentId: patch.documentId,
            startLine: patch.startLine,
            endLine: patch.endLine,
          },
          attentionSignal: signal("editor", "navigation"),
        }));
        return;

      case "set_editor_view":
        // A fresh id each time, so asking for the same mode twice still reaches
        // the shell as a new request rather than a no-op state change.
        set({
          editorViewCommand: {
            id: `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            view: patch.view,
          },
        });
        return;

      case "set_sidebar_tab":
        // Default to opening the sidebar: selecting a tab nobody can see would be
        // a no-op from the user's side, which is the confusing half of a command
        // that half-worked.
        set((state) => ({
          sidebarTab: patch.tab,
          panelVisibility: {
            ...state.panelVisibility,
            sidebar: patch.visible ?? true,
          },
          attentionSignal: signal("sidebar"),
        }));
        return;

      case "set_project_view":
        set({ projectView: patch.view });
        return;

      case "set_layout":
        // Merged like the theme: naming only the sidebar side must not reset the
        // split ratio, or a "move the panel" call would silently re-proportion the
        // editor. Clamped here as well as in the validator, because the store is
        // also reached by the drag handler.
        set((state) => ({
          layout: {
            sidebarSide: patch.sidebarSide ?? state.layout.sidebarSide,
            splitRatio:
              typeof patch.splitRatio === "number"
                ? Math.min(0.8, Math.max(0.2, patch.splitRatio))
                : state.layout.splitRatio,
          },
        }));
        return;

      case "set_theme":
        // Merged, not replaced: a patch that only changes the accent must leave the
        // density alone, or every theme call would silently reset the other axis.
        set((state) => ({
          theme: {
            accent: patch.accent ?? state.theme.accent,
            density: patch.density ?? state.theme.density,
          },
        }));
        return;

      case "doc_restored":
        set((state) => ({
          lastRestore: {
            documentId: `${patch.projectId}-${patch.fileId}`,
            fileId: patch.fileId,
            versionId: patch.versionId,
            token: Date.now(),
          },
          // Reload-safety: the restored content flows through the editor via
          // Yjs; bumping attention lets the shell flash the editor pane.
          attentionSignal:
            state.currentDocumentId === `${patch.projectId}-${patch.fileId}`
              ? signal("editor")
              : state.attentionSignal,
        }));
        return;

      case "noop":
      default:
        return;
    }
  },
}));

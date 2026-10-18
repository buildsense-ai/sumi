/**
 * A2UI schema — declarative UI patches emitted by agents / automation.
 *
 * Sumiu0027s A2UI layer. Two layers:
 *   - `UiPatch`       — a small discriminated union of *structural* commands
 *                       (focus a panel, open a document, resize a pane…)
 *   - `JsonRender`    — a payload meant to be rendered as a rich UI card
 *                       (project cards, progress, reports)
 *
 * The union below is intentionally minimal for Sumi — add kinds only when
 * you need them. Don't pre-build a huge enum "just in case".
 */

// ---------------------------------------------------------------------------
// Structural patches — thin commands that target the workspace shell
// ---------------------------------------------------------------------------

export type WorkspaceMainBlock =
  | "editor"
  | "preview"
  | "graph"
  | "management";

export type PanelName = "sidebar" | "ai" | "inspector";

export type UiPatch =
  | { type: "open_document"; documentId: string }
  | { type: "show_management" }
  | { type: "show_ai_chat" }
  | { type: "set_main_block"; block: WorkspaceMainBlock }
  | {
      type: "set_panel_visibility";
      panel: PanelName;
      visible: boolean;
    }
  | {
      type: "set_panel_size";
      panel: PanelName;
      /** percentage of container, 10–90 */
      widthPercent: number;
    }
  | { type: "queue_prompt"; prompt: string; autoSend?: boolean }
  | { type: "focus_document_range"; documentId: string; startLine: number; endLine: number }
  | {
      /** Which sidebar tab is showing (outline / members / history). */
      type: "set_sidebar_tab";
      tab: "outline" | "members" | "history";
      /** Open the sidebar too; defaults to true so the tab is actually visible. */
      visible?: boolean;
    }
  | {
      /** Project list presentation — the list / table toggle. */
      type: "set_project_view";
      view: "list" | "table";
    }
  | {
      /**
       * Workspace skeleton.
       *
       * Distinct from `set_panel_visibility` (whether a panel exists) and
       * `set_panel_size` (how big it is): this is *where* it sits. Moving the
       * sidebar to the left is a different arrangement, not a different width.
       */
      type: "set_layout";
      sidebarSide?: "left" | "right";
      /** Share of the split view for the editor, 0.2–0.8. */
      splitRatio?: number;
    }
  | {
      /**
       * Accent colour and spacing density.
       *
       * Part of the reachable surface on purpose: every primitive reads these from
       * CSS tokens, so changing the look is a value change. Anything that styled
       * itself with literal colours would ignore this.
       */
      type: "set_theme";
      accent?: "cyan" | "violet" | "emerald" | "amber" | "rose" | "slate";
      density?: "compact" | "comfortable";
    }
  | {
      /**
       * Editor view mode for the open document.
       *
       * Distinct from `set_main_block: "preview"`: that swaps the workspace pane,
       * this is the source / split / preview toggle inside the editor.
       */
      type: "set_editor_view";
      view: "source" | "split" | "preview";
    }
  | {
      /** A pending edit proposal was added/removed for a doc in this project.
       *  Consumers hydrate `useEditStore.pendingEdits` from the payload. */
      type: "pending_edit_changed";
      projectId: string;
      /** fileId (path inside project). */
      fileId: string;
      /** Full pending edit payload, or null when removed. */
      edit: unknown | null;
    }
  | {
      /** Intent lifecycle events — intent_created / claimed / answered / closed.
       *  `intent` is the full row; for `closed` only the id may be present. */
      type: "intent_created" | "intent_claimed" | "intent_answered" | "intent_closed";
      projectId: string;
      fileId: string;
      intent?: unknown;
      intentId?: string;
    }
  | {
      /** Shadow doc 生命周期 —— created/updated/promoted/discarded。
       *  `shadow` 是完整行；promoted 时另带 promotion 产生的 pending_edits。 */
      type:
        | "shadow_doc_created"
        | "shadow_doc_updated"
        | "shadow_doc_promoted"
        | "shadow_doc_discarded";
      projectId: string;
      fileId: string;
      shadow?: unknown;
      shadowId?: string;
      edits?: unknown[];
    }
  | {
      /** A doc version was restored — clients should let the restored content
       *  flow through normal save paths but skip re-snapshotting it as a new
       *  auto-version, and refresh the version-history list. */
      type: "doc_restored";
      projectId: string;
      fileId: string;
      versionId: string;
    }
  | { type: "noop" };

// ---------------------------------------------------------------------------
// Rich render payloads — the "agent generated a card" branch
// ---------------------------------------------------------------------------

export interface RenderAction {
  type:
    | "open_document"
    | "queue_prompt"
    | "open_url"
    | "run_command";
  label: string;
  /** open_document */
  documentId?: string;
  /** queue_prompt */
  prompt?: string;
  autoSend?: boolean;
  /** open_url */
  url?: string;
  /** run_command */
  command?: string;
  variant?: "default" | "secondary" | "outline" | "destructive";
  confirmTitle?: string;
  confirmDescription?: string;
}

export interface DocumentCard {
  id: string;
  name: string;
  description?: string | null;
  updatedAt?: string;
  mainFile?: string;
  actions?: RenderAction[];
}

export type JsonRenderPayload =
  | {
      kind: "document_cards";
      title?: string;
      subtitle?: string;
      documents: DocumentCard[];
      emptyMessage?: string;
    }
  | {
      kind: "progress";
      runId: string;
      status: "queued" | "running" | "completed" | "error";
      progress: number; // 0..1
      stage?: string;
      message?: string;
    }
  | {
      kind: "report";
      runId: string;
      title: string;
      summary: string;
      bodyMarkdown: string;
      error?: string;
    }
  | {
      kind: "status";
      requestId: string;
      status: "running" | "success" | "error";
      action?: { type: "open_full_preview" };
    };

// ---------------------------------------------------------------------------
// Node schema — top-level A2UI tree. Keep it tiny.
// ---------------------------------------------------------------------------

export type WorkspaceNode =
  | { component_name: "omni_chat"; props: Record<string, never> }
  | { component_name: "editor_core"; props: { documentId: string } };

"use client";

/**
 * Workspace shell — three-layer composition:
 *   canvas (main content)
 *   dim    (engagement overlay when the omni dock has focus)
 *   omni   (floating command surface, bottom-center)
 *
 * Apple-inspired: flat canvas, hairline separators, single accent,
 * blur only on the floating surface.
 */

import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api-path";
import { useRouter, useSearchParams } from "next/navigation";
import { EditorView } from "@codemirror/view";
import { useSession, getAuthHeaders } from "@/lib/use-session";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";
import { broadcastPageState } from "@/lib/provider-registry";
import { useUiEvents } from "@/lib/use-ui-events";
import CollaborativeEditor from "@/components/editor/collaborative-editor";
import { EditorToolbar } from "@/components/editor/editor-toolbar";
import OutlineSidebar from "@/components/editor/outline-sidebar";
import VersionHistory from "@/components/editor/version-history";
import { AskAgentDialog } from "@/components/ask-agent-dialog";
import { AgentAskDock } from "@/components/agent-ask-dock";
import EditCommandBar from "@/components/editor/edit-command-bar";
import { useEditStore } from "@/stores/edit-store";
import DocumentListPane from "@/components/document-list-pane";
import MarkdownPreview from "@/components/markdown-preview";
import { Toaster } from "@/components/ui/toast";
import { Button, Tabs } from "@/components/ui/primitives";
import { useIntentStore } from "@/stores/intent-store";
import { SettingsDialog, useEditorSettings } from "@/components/settings-dialog";
import { useDocPersistence } from "@/lib/use-doc-persistence";

export default function WorkspaceShell() {
  const searchParams = useSearchParams();
  const documentId = searchParams.get("doc");
  const inviteProjectId = searchParams.get("invite");

  const currentDocumentId = useUiStore((s) => s.currentDocumentId);
  const activeMainBlock = useUiStore((s) => s.activeMainBlock);
  const attentionSignal = useUiStore((s) => s.attentionSignal);
  const consumeAttention = useUiStore((s) => s.consumeAttention);
  const panelVisibility = useUiStore((s) => s.panelVisibility);
  const panelWidth = useUiStore((s) => s.panelWidth);
  // Accent + density, applied as data attributes on the shell root so every
  // primitive picks them up from the same CSS tokens.
  const theme = useUiStore((s) => s.theme);
  const setCurrentDocumentId = useUiStore((s) => s.setCurrentDocumentId);
  const setPanelVisibility = useUiStore((s) => s.setPanelVisibility);

  // Live push: subscribe to UI patches from the SSE endpoint.
  useUiEvents({ projectId: null });

  // Hydrate store from URL
  useEffect(() => {
    setCurrentDocumentId(documentId);
  }, [documentId, setCurrentDocumentId]);

  // Flash the attention target briefly, then clear
  useEffect(() => {
    if (!attentionSignal) return;
    const t = setTimeout(() => consumeAttention(), 1500);
    return () => clearTimeout(t);
  }, [attentionSignal, consumeAttention]);

  const { actor, loading } = useSession();

  // Invite link — ?invite=prj_x means "auto-join this project as viewer".
  // Any authenticated user can redeem; the invite route adds them
  // and the workspace reloads to show the new membership.
  useEffect(() => {
    if (!inviteProjectId || !actor) return;
    const join = async () => {
      try {
        await fetch(apiPath("/api/invite/redeem"), {
          method: "POST",
          headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: inviteProjectId }),
        });
      } catch {
        /* already a member or invite failed — still try to open */
      }
      // Clean the URL + reload to pick up the new membership
      const url = new URL(window.location.href);
      url.searchParams.delete("invite");
      window.history.replaceState(null, "", url.toString());
      window.location.reload();
    };
    void join();
  }, [inviteProjectId, actor]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && currentDocumentId) {
        setCurrentDocumentId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentDocumentId, setCurrentDocumentId]);

  // Track foreground/background — agents want to know if the user
  // is actually looking at the screen right now.
  const [foreground, setForeground] = useState(
    () => typeof document !== "undefined" ? !document.hidden : true
  );
  useEffect(() => {
    const onVis = () => setForeground(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Broadcast page state to all active Yjs providers so other clients
  // (humans + agents) can see where we are + what we can do.
  useEffect(() => {
    broadcastPageState({
      currentDocumentId,
      activeMainBlock,
      aiOpen: panelVisibility.ai,
      sidebarOpen: panelVisibility.sidebar,
      inspectorOpen: panelVisibility.inspector,
      role: (actor as { projectRole?: string } | null)?.projectRole,
      activePendingEdits: useEditStore.getState().pendingEdits.map(e => e.id),
      selection: undefined, // wire up when CM selection tracking lands
      cursorLine: undefined,
      foreground,
    });
  }, [currentDocumentId, activeMainBlock, panelVisibility, actor, foreground]);

  const aiOpen = panelVisibility.ai;
  const attentionTarget = attentionSignal?.target;

  const [aiProjectId, aiFileId] = currentDocumentId
    ? splitDocId(currentDocumentId)
    : [null, null];

  return (
    <div
      className="relative h-screen w-full overflow-hidden bg-background text-foreground"
      // Accent and density are read by every primitive through CSS tokens, so a
      // `set_theme` patch restyles the workspace without a rebuild.
      data-accent={theme.accent}
      data-density={theme.density}
    >
      {/* Canvas layer — main content.
          The ask dock floats over this rather than docking beside it: it is an
          interruption, not a workspace, so the document keeps its full width. */}
      <div className="absolute inset-0">
        {loading ? (
          <LoadingPane />
        ) : !actor ? (
          <SignInPane />
        ) : currentDocumentId ? (
          <EditorPane
            documentId={currentDocumentId}
            attention={attentionTarget === "editor"}
            actor={actor}
          />
        ) : (
          <DocumentListPane />
        )}
      </div>

      {/* Ask dock — floating button, expanding to an input box. No thread list:
          the answer to the newest ask is the only thing it shows. */}
      {actor && (
        <AgentAskDock
          open={aiOpen}
          onOpenChange={(next) => setPanelVisibility("ai", next)}
          projectId={aiProjectId}
          fileId={aiFileId}
        />
      )}

      <Toaster />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor pane
// ---------------------------------------------------------------------------

type EditorViewMode = "source" | "preview" | "split";

// NEXT_PUBLIC_TAP_ENABLED —— TAP ghost-text 的功能开关（默认关闭，opt-in）
const TAP_AVAILABLE = process.env.NEXT_PUBLIC_TAP_ENABLED === "true";

function EditorPane({
  documentId,
  attention,
  actor,
}: {
  documentId: string;
  attention: boolean;
  actor: { id: string; name: string; kind: "user" | "agent" };
}) {
  const setCurrentDocumentId = useUiStore((s) => s.setCurrentDocumentId);
  const openDocuments = useUiStore((s) => s.openDocuments);
  const closeDocument = useUiStore((s) => s.closeDocument);
  const currentDocumentId = useUiStore((s) => s.currentDocumentId);
  const router = useRouter();
  const [projectId, fileId] = splitDocId(documentId);
  const [collaborators, setCollaborators] = useState<Array<{ name: string; color: string; id?: string }>>([]);
  const [connStatus, setConnStatus] = useState({ isConnected: false, isSynced: false });
  const [viewMode, setViewMode] = useState<EditorViewMode>("source");
  const editorViewCommand = useUiStore((s) => s.editorViewCommand);
  const consumeEditorView = useUiStore((s) => s.consumeEditorView);

  // The toggle is local component state, which a store update cannot reach, so the
  // store carries a one-shot request instead: apply it here, then acknowledge by
  // clearing it. Without the acknowledgement the request would be re-applied on
  // every render and the user could never switch away from the requested mode.
  useEffect(() => {
    if (!editorViewCommand) return;
    setViewMode(editorViewCommand.view);
    consumeEditorView();
  }, [editorViewCommand, consumeEditorView]);
  const [tapEnabled, setTapEnabled] = useState(false);
  const [currentContent, setCurrentContent] = useState("");
  const [cursorLine, setCursorLine] = useState<number | null>(null);
  // The sidebar's visibility lives in the ui-store, not in local state.
  //
  // It used to be a local `useState`, which meant two things disagreed: page state
  // broadcast `panelVisibility.sidebar` (so every other client and agent was told a
  // constant), and a `set_panel_visibility` patch moved the store — which nothing
  // rendered from — while the sidebar the user could see stayed put. That is the
  // same shape as the view-mode toggle: state a patch cannot reach reads as "the
  // assistant's UI commands don't work".
  const sidebarOpen = useUiStore((s) => s.panelVisibility.sidebar);
  const setPanelVisibility = useUiStore((s) => s.setPanelVisibility);
  // Tab selection lives in the store, for the same reason the visibility does:
  // it is chrome the assistant should be able to drive, and state a patch cannot
  // reach is state the assistant appears unable to touch.
  const sidebarTab = useUiStore((s) => s.sidebarTab);
  const setSidebarTab = useUiStore((s) => s.setSidebarTab);
  const [askOpen, setAskOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings] = useEditorSettings();

  // Push settings into CSS custom properties — font size flows to CM
  // via `--sumi-editor-font-size`; theme toggle flips `.dark` class.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.style.setProperty(
      "--sumi-editor-font-size",
      `${settings.fontSize}px`
    );
    if (settings.theme !== "system") {
      document.documentElement.classList.toggle("dark", settings.theme === "dark");
    }
  }, [settings.fontSize, settings.theme]);

  const [askSelection, setAskSelection] = useState<{
    text: string;
    startLine: number;
    endLine: number;
  } | null>(null);
  const [agents, setAgents] = useState<
    Array<{ subjectId: string; name: string | null }>
  >([]);
  const editorViewRef = useRef<EditorView | null>(null);
  // State mirror of the ref — the toolbar needs a reactive value to
  // enable/disable buttons once the CM view mounts.
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const applyUiPatch = useUiStore((s) => s.applyUiPatch);
  const { initialContent, loading, scheduleSave, lastSavedAt, error, conflicted } =
    useDocPersistence(projectId, fileId);

  const handleEditorReady = (v: EditorView | null) => {
    editorViewRef.current = v;
    setEditorView(v);
  };

  const handleContentChange = (content: string) => {
    setCurrentContent(content);
    scheduleSave(content);
  };

  // Right sidebar (大纲/成员) — persisted per project.
  //
  // The stored preference is applied *into the store*, so a restored session and a
  // patched one travel the same path. No stored value means closed, which is what
  // the local state used to default to.
  useEffect(() => {
    try {
      const v = localStorage.getItem(`sumi:sidebar:${projectId}`);
      if (v === "outline" || v === "members" || v === "history") {
        setPanelVisibility("sidebar", true);
        setSidebarTab(v);
      } else if (v === "closed") {
        setPanelVisibility("sidebar", false);
      } else {
        setPanelVisibility("sidebar", false);
      }
    } catch {
      /* private mode */
    }
  }, [projectId, setPanelVisibility]);

  const toggleSidebar = (tab?: "outline" | "members" | "history") => {
    const next = tab
      ? !(sidebarOpen && sidebarTab === tab)
      : !sidebarOpen;
    const nextTab = tab ?? sidebarTab;
    setPanelVisibility("sidebar", next);
    if (tab) setSidebarTab(tab);
    try {
      localStorage.setItem(
        `sumi:sidebar:${projectId}`,
        next ? nextTab : "closed"
      );
    } catch {
      /* private mode */
    }
  };

  // Load all members (users + agents) for the members panel + presence.
  const [members, setMembers] = useState<
    Array<{ subjectId: string; role: string; status?: string | null; name?: string | null }>
  >([]);
  const [memberPresence, setMemberPresence] = useState<
    Map<string, { foreground: boolean; fileId?: string }>
  >(new Map());

  // CatsCo contacts — for the "add member" picker
  const [contacts, setContacts] = useState<
    Array<{ subjectId: string; displayName: string; username: string; kind: "user" | "agent" }>
  >([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [addMemberMode, setAddMemberMode] = useState<"picker" | "manual">("picker");
  const [newMemberId, setNewMemberId] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<"viewer" | "editor">("editor");

  useEffect(() => {
    let cancelled = false;
    fetch(apiPath(`/api/projects/${projectId}/members`), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((d) => {
        if (cancelled) return;
        setMembers(d.members || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Fetch contacts once when the members tab is opened
  useEffect(() => {
    if (sidebarTab !== "members" || !sidebarOpen) return;
    setContactsLoading(true);
    fetch(apiPath("/api/friends"), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { users: [], agents: [] }))
      .then((d) => {
        setContacts([...(d.users || []), ...(d.agents || [])]);
      })
      .catch(() => {})
      .finally(() => setContactsLoading(false));
  }, [sidebarTab, sidebarOpen]);

  const addMember = async (subjectId: string, role: "viewer" | "editor") => {
    try {
      const res = await fetch(apiPath(`/api/projects/${projectId}/members`), {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ subjectId, role }),
      });
      if (!res.ok) return;
      // Refresh members
      const r = await fetch(apiPath(`/api/projects/${projectId}/members`), {
        headers: getAuthHeaders(),
      });
      const d = await r.json();
      setMembers(d.members || []);
      // Send the invite — P2P CatsCo message for both users and agents
      fetch(apiPath("/api/friends"), {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          subjectId,
          kind: subjectId.startsWith("a") ? "agent" : "user",
          projectId,
          projectName: undefined, // picked up from the project record server-side
        }),
      }).catch(() => {}); // best-effort
    } catch {
      /* add failed */
    }
  };

  const addMemberManual = async () => {
    const id = newMemberId.trim();
    if (!id) return;
    await addMember(id, newMemberRole);
    setNewMemberId("");
  };

  // Poll page-state for member presence — refreshes every 10s
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    const fetchPresence = async () => {
      try {
        const res = await fetch(apiPath(`/api/page-state/${projectId}`), {
          headers: getAuthHeaders(),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!alive) return;
        const m = new Map<string, { foreground: boolean; fileId?: string }>();
        for (const member of data.members || []) {
          const id = (member.user?.id || "").toString();
          if (id) {
            m.set(id, {
              foreground: !!member.pageState?.foreground,
              fileId: member.fileId,
            });
          }
        }
        setMemberPresence(m);
      } catch {
        /* best-effort */
      }
    };
    void fetchPresence();
    const iv = setInterval(fetchPresence, 10_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [projectId]);

  const handleAskAgent = (
    sel: { text: string; startLine: number; endLine: number } | null
  ) => {
    setAskSelection(sel);
    if (sel) {
      // Selection anchored — quick-input dialog keeps the line context.
      setAskOpen(true);
    } else {
      // No selection — the AI panel is the conversation surface.
      applyUiPatch({ type: "set_panel_visibility", panel: "ai", visible: true });
    }
  };

  // Cmd+K — grab current selection, push it into the AI dock as a prompt.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        const view = editorViewRef.current;
        if (!view) return;
        const sel = view.state.selection.main;
        const selected = view.state.sliceDoc(sel.from, sel.to);
        if (!selected.trim()) return;
        e.preventDefault();
        const prompt = `在文档 ${fileId} 中，请处理这段内容：\n\n\`\`\`\n${selected}\n\`\`\`\n\n`;
        applyUiPatch({
          type: "queue_prompt",
          prompt,
          autoSend: false,
        });
        applyUiPatch({ type: "set_panel_visibility", panel: "ai", visible: true });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [fileId, applyUiPatch]);

  // Pending-edit navigation: switch doc when the target edit lives in a
  // different file (doc id is `${projectId}-${fileId}`), then scroll to the
  // edit's startLine. Same-file jumps scroll the live view directly.
  useEffect(() => {
    const store = useEditStore.getState();
    store.setNavigateToFileCallback((filePath, line) => {
      const targetFileId = filePath || fileId;
      const sameFile =
        targetFileId === fileId ||
        targetFileId.endsWith(fileId) ||
        fileId.endsWith(targetFileId);

      if (!sameFile) {
        // The queued pendingScrollLine is consumed by the new editor mount
        // once its Yjs sync completes.
        router.push(`/?doc=${projectId}-${encodeURIComponent(targetFileId)}`);
        return;
      }

      // Same file — scroll now.
      const pending = useEditStore.getState().consumePendingScrollLine();
      const targetLine = line ?? pending;
      const view = editorViewRef.current;
      if (targetLine && view) {
        try {
          const clamped = Math.max(
            1,
            Math.min(targetLine, view.state.doc.lines)
          );
          const pos = view.state.doc.line(clamped).from;
          view.dispatch({
            selection: { anchor: pos },
            effects: EditorView.scrollIntoView(pos, { y: "center" }),
          });
        } catch {
          // doc may be mid-update — ignore
        }
      }
    });
    return () => store.setNavigateToFileCallback(null);
  }, [projectId, fileId, router]);

  // The sidebar is built once and placed on whichever edge the layout names.
  // Placing it by rendering it in one of two positions would duplicate this prop
  // list, and the copies would drift.
  const sidebarSide = useUiStore((s) => s.layout.sidebarSide);
  const splitRatio = useUiStore((s) => s.layout.splitRatio);
  const setLayout = useUiStore((s) => s.setLayout);
  const splitRowRef = useRef<HTMLDivElement | null>(null);

  /**
   * Drag the divider between editor and preview.
   *
   * The ratio is measured against the space the two panes actually share, not the
   * container: with the sidebar docked, the container is wider, and dividing by it
   * would make the same drag move the divider less on one side than the other.
   *
   * Listener cleanup is on `window` rather than the handle because a fast drag
   * leaves the handle behind, and a pointerup delivered elsewhere would otherwise
   * leave the handler attached forever.
   */
  const startSplitDrag = (event: React.MouseEvent) => {
    const row = splitRowRef.current;
    if (!row) return;
    event.preventDefault();

    const aside = row.querySelector("aside");
    const rowWidth = row.getBoundingClientRect().width;
    const shared = rowWidth - (aside ? aside.getBoundingClientRect().width : 0);
    if (shared <= 0) return;

    const startX = event.clientX;
    const startRatio = splitRatio;

    const move = (e: MouseEvent) => {
      setLayout({ splitRatio: startRatio + (e.clientX - startX) / shared });
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };
  const sidePanel = sidebarOpen ? (
    <SidePanel
      tab={sidebarTab}
      setTab={setSidebarTab}
      onClose={() => toggleSidebar()}
      side={sidebarSide}
      view={editorViewRef.current}
      content={currentContent || initialContent || ""}
      cursorLine={cursorLine}
      collaborators={collaborators}
      members={members}
      memberPresence={memberPresence}
      contacts={contacts}
      contactsLoading={contactsLoading}
      addMemberMode={addMemberMode}
      setAddMemberMode={setAddMemberMode}
      newMemberId={newMemberId}
      setNewMemberId={setNewMemberId}
      newMemberRole={newMemberRole}
      setNewMemberRole={setNewMemberRole}
      onAddMember={addMember}
      onAddMemberManual={addMemberManual}
      projectId={projectId}
      fileId={fileId}
    />
  ) : null;

  return (
    <div
      className={cn(
        "flex h-full flex-col transition-shadow duration-200",
        attention && "ring-1 ring-primary/40"
      )}
    >
      {/* Title bar — hairline separator, minimal chrome */}
      <header className="flex h-11 items-center gap-3 border-b border-border/60 px-4">
        {/* Back to file list — Esc also works */}
        <button
          onClick={() => setCurrentDocumentId(null)}
          title="回到文档列表 (Esc)"
          className="rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          ←
        </button>

        {/* Open doc tabs */}
        <div className="flex items-center gap-0.5 overflow-x-auto">
          {openDocuments.map((docId) => {
            const [, docFileId] = splitDocId(docId);
            const isActive = docId === currentDocumentId;
            const docTitle = docFileId?.split("/").pop() || docFileId || docId;
            return (
              <div
                key={docId}
                className={cn(
                  "group flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors",
                  isActive
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                <button
                  onClick={() => setCurrentDocumentId(docId)}
                  className="max-w-[120px] truncate"
                >
                  {docTitle}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeDocument(docId);
                  }}
                  title="关闭"
                  className="rounded-sm opacity-0 transition-opacity hover:bg-foreground/10 group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        {/* Breadcrumb */}
        <div className="text-[13px] font-medium text-muted-foreground">
          {fileId.split("/").pop() || fileId}
        </div>
        {/* View mode toggle */}
        <div className="flex items-center gap-0.5 rounded-md border border-border/60 p-0.5">
          {(["source", "split", "preview"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={cn(
                "rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
                viewMode === m
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {m === "source" ? "源码" : m === "split" ? "双栏" : "预览"}
            </button>
          ))}
        </div>
        {/* Save indicator */}
        <div className="text-[10px] text-muted-foreground/60">
          {conflicted ? (
            <span className="text-amber-500">冲突 — 已回退重试</span>
          ) : error ? (
            <span className="text-destructive">{error}</span>
          ) : lastSavedAt ? (
            `已保存 ${new Date(lastSavedAt).toLocaleTimeString()}`
          ) : null}
        </div>
        {/* Live collaborators — colored dots + tooltip name */}
        <div className="ml-auto flex items-center gap-2">
          {/* 大纲/成员 sidebar toggle */}
          <button
            onClick={() => toggleSidebar()}
            title="大纲 / 成员"
            className={cn(
              "rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition-colors",
              sidebarOpen
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border/60 text-muted-foreground/70 hover:text-foreground"
            )}
          >
            大纲
          </button>
          {/* Settings */}
          <button
            onClick={() => setSettingsOpen(true)}
            title="编辑器设置"
            className="rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            ⚙
          </button>
          {collaborators.length > 1 && (
            <div className="flex items-center -space-x-1.5">
              {collaborators.slice(0, 5).map((c, i) => (
                <div
                  key={c.id || i}
                  className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white ring-2 ring-background"
                  style={{ background: c.color }}
                  title={c.name}
                >
                  {c.name.slice(0, 1).toUpperCase()}
                </div>
              ))}
            </div>
          )}
          <div className="text-[11px] text-muted-foreground/70">
            {actor.name}
          </div>
        </div>
      </header>
      {/* Formatting toolbar — sits between the file header and the editor,
          hidden in pure preview mode where there's no CodeMirror surface. */}
      {viewMode !== "preview" && (
        <EditorToolbar
          editorView={editorView}
          projectId={projectId}
          fileId={fileId}
          isConnected={connStatus.isConnected}
          isSynced={connStatus.isSynced}
          collaboratorCount={collaborators.length}
          tapAvailable={TAP_AVAILABLE}
          tapEnabled={tapEnabled}
          onTapToggle={() => setTapEnabled((v) => !v)}
          onAskAgent={() => handleAskAgent(null)}
        />
      )}
      <div className="relative flex-1 overflow-hidden">
        {/* Cursor-style pending-edit command bar (overlays editor) */}
        <EditCommandBar />
        {loading ? (
          <LoadingPane />
        ) : viewMode === "preview" ? (
          <MarkdownPreview
            content={currentContent || initialContent || ""}
            className="h-full overflow-auto"
          />
        ) : viewMode === "split" ? (
          <div className="flex h-full" ref={splitRowRef}>
            {sidebarSide === "left" && sidePanel}
            <div
              className="min-w-0 overflow-hidden"
              style={{ flex: `0 0 ${splitRatio * 100}%` }}
            >
              <CollaborativeEditor
                projectId={projectId}
                fileId={fileId}
                mode="markdown"
                userId={actor.id}
                userName={actor.name}
                initialContent={initialContent ?? ""}
                prefillOnConnect
                tapEnabled={tapEnabled}
                onContentChange={handleContentChange}
                onCollaboratorsChange={setCollaborators}
                onCursorLineChange={setCursorLine}
                onEditorReady={handleEditorReady}
                onAskAgent={handleAskAgent}
                onConnectionStatusChange={setConnStatus}
              />
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="拖动调整编辑与预览的宽度"
              onMouseDown={startSplitDrag}
              onDoubleClick={() => setLayout({ splitRatio: 0.5 })}
              title="拖动调整分栏 · 双击回到各半"
              className="w-1 shrink-0 cursor-col-resize bg-border/50 transition-colors hover:bg-primary/40"
            />
            <div className="min-w-0 flex-1 overflow-auto bg-background">
              <MarkdownPreview content={currentContent || initialContent || ""} />
            </div>
            {sidebarSide === "right" && sidePanel}
          </div>
        ) : (
          <div className="flex h-full">
            {sidebarSide === "left" && sidePanel}
            <div className="min-w-0 flex-1 overflow-hidden">
              <CollaborativeEditor
                projectId={projectId}
                fileId={fileId}
                mode="markdown"
                userId={actor.id}
                userName={actor.name}
                initialContent={initialContent ?? ""}
                prefillOnConnect
                tapEnabled={tapEnabled}
                onContentChange={handleContentChange}
                onCollaboratorsChange={setCollaborators}
                onCursorLineChange={setCursorLine}
                onEditorReady={handleEditorReady}
                onAskAgent={handleAskAgent}
                onConnectionStatusChange={setConnStatus}
              />
            </div>
            {sidebarSide === "right" && sidePanel}
          </div>
        )}
      </div>

      {/* Status bar — bottom edge: cursor, word count, pending count, conn status */}
      <footer className="flex h-7 items-center gap-4 border-t border-border/60 bg-background px-4 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-1">
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              connStatus.isSynced ? "bg-emerald-500" : connStatus.isConnected ? "bg-amber-500" : "bg-red-500"
            )}
          />
          {connStatus.isSynced ? "已同步" : connStatus.isConnected ? "连接中" : "离线"}
        </div>
        {cursorLine && <div>Ln {cursorLine}</div>}
        {currentContent && (
          <div>{currentContent.split(/\s+/).filter(Boolean).length} 字</div>
        )}
        {(() => {
          const pending = useEditStore.getState().pendingEdits.filter(
            (e) => e.status === "pending"
          ).length;
          return pending > 0 ? (
            <div className="flex items-center gap-1 text-amber-600">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
              {pending} pending
            </div>
          ) : null;
        })()}
        <div className="ml-auto flex items-center gap-3">
          {viewMode === "preview" && (
            <span className="text-muted-foreground/70">预览模式 — 只读</span>
          )}
          <span className="text-muted-foreground/50">{fileId}</span>
        </div>
      </footer>
      <AskAgentDialog
        open={askOpen}
        projectId={projectId}
        fileId={fileId}
        selection={askSelection}
        agents={agents}
        onClose={() => setAskOpen(false)}
        onCreated={(intent) => {
          if (intent) useIntentStore.getState().upsertIntent(intent);
        }}
      />

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right side panel — 大纲 / 成员
// ---------------------------------------------------------------------------

function SidePanel({
  tab,
  setTab,
  onClose,
  view,
  content,
  cursorLine,
  collaborators,
  members,
  memberPresence,
  contacts,
  contactsLoading,
  addMemberMode,
  setAddMemberMode,
  newMemberId,
  setNewMemberId,
  newMemberRole,
  setNewMemberRole,
  onAddMember,
  onAddMemberManual,
  projectId,
  fileId,
  side = "right",
}: {
  tab: "outline" | "members" | "history";
  /** Which edge the panel is docked to — decides the divider's side. */
  side?: "left" | "right";
  setTab: (t: "outline" | "members" | "history") => void;
  onClose: () => void;
  view: EditorView | null;
  content: string;
  cursorLine: number | null;
  collaborators: Array<{ name: string; color: string; id?: string }>;
  members: Array<{ subjectId: string; role: string; status?: string | null; name?: string | null }>;
  memberPresence: Map<string, { foreground: boolean; fileId?: string }>;
  contacts: Array<{ subjectId: string; displayName: string; username: string; kind: "user" | "agent" }>;
  contactsLoading: boolean;
  addMemberMode: "picker" | "manual";
  setAddMemberMode: (m: "picker" | "manual") => void;
  newMemberId: string;
  setNewMemberId: (v: string) => void;
  newMemberRole: "viewer" | "editor";
  setNewMemberRole: (r: "viewer" | "editor") => void;
  onAddMember: (subjectId: string, role: "viewer" | "editor") => void;
  onAddMemberManual: () => void;
  projectId: string;
  fileId: string;
}) {
  // The panel width is patch-drivable, so it has to be rendered from the store.
  // It previously lived only in the store (written by `set_panel_size`, read once
  // and dropped), while the element below was a fixed `w-60` — the patch reported
  // success and nothing on screen moved.
  //
  // No max-width: a cap silently swallowed the upper half of the range, so asking
  // for 60% and asking for 90% looked identical. The store already clamps to the
  // documented 10–90, and a narrow min-width is what keeps the panel usable.
  const sidebarWidth = useUiStore((s) => s.panelWidth.sidebar);

  return (
    <aside
      className={cn(
        "flex min-w-[200px] shrink-0 flex-col bg-background",
        // The divider belongs on the edge facing the editor. A left-docked panel
        // with a left border would draw a line against the window instead.
        side === "left" ? "border-r border-border/60" : "border-l border-border/60"
      )}
      style={{ width: `${sidebarWidth}%` }}
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <Tabs
          value={tab}
          onValueChange={setTab}
          items={[
            { value: "outline" as const, label: "大纲" },
            { value: "members" as const, label: "成员" },
            { value: "history" as const, label: "历史" },
          ]}
        />
        <Button variant="ghost" size="icon" onClick={onClose} title="关闭">
          ✕
        </Button>
      </div>
      {tab === "outline" ? (
        <OutlineSidebar
          view={view}
          content={content}
          cursorLine={cursorLine}
          className="flex-1"
        />
      ) : tab === "history" ? (
        <VersionHistory
          projectId={projectId}
          fileId={fileId}
          currentContent={content}
          className="flex-1"
        />
      ) : (
        <ul className="flex-1 overflow-auto py-2">
          {members.length === 0 ? (
            <li className="p-4 text-[12px] text-muted-foreground">
              暂无成员
            </li>
          ) : (
            members.map((m) => {
              const presence = memberPresence.get(m.subjectId);
              const online = presence !== undefined;
              const fg = presence?.foreground;
              const onThisDoc = presence?.fileId === fileId;
              const isAgent = m.subjectId.startsWith("a");
              return (
                <li
                  key={m.subjectId}
                  className="flex items-center gap-2 px-3 py-1.5"
                >
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white",
                      isAgent ? "bg-violet-500" : "bg-primary",
                      m.status === "disabled" && "opacity-40"
                    )}
                  >
                    {(m.name || m.subjectId).slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-[12px] text-foreground">
                      {m.name || m.subjectId}
                      {isAgent && (
                        <span className="rounded-full bg-violet-500/10 px-1 py-0.5 text-[9px] font-medium text-violet-600">
                          agent
                        </span>
                      )}
                      {m.status === "disabled" && (
                        <span className="rounded-full bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                          停用
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {online
                        ? fg
                          ? onThisDoc
                            ? "👁 前台"
                            : `👁 ${presence?.fileId || "前台"}`
                          : "💤 后台"
                        : "离线"}
                      {m.role === "owner" && " · owner"}
                    </div>
                  </div>
                </li>
              );
            })
          )}
        </ul>
      )}

      {/* Invite link — copy it, send to friend/agent */}
      <div className="border-t border-border/40 px-3 py-2">
        {/* Add-member picker */}
        <div className="mb-2 flex items-center gap-1 rounded-md border border-border/60 p-0.5">
          <button
            onClick={() => setAddMemberMode("picker")}
            className={cn(
              "rounded px-2 py-0.5 text-[9px] font-medium",
              addMemberMode === "picker"
                ? "bg-accent text-foreground"
                : "text-muted-foreground"
            )}
          >
            好友/Bot
          </button>
          <button
            onClick={() => setAddMemberMode("manual")}
            className={cn(
              "rounded px-2 py-0.5 text-[9px] font-medium",
              addMemberMode === "manual"
                ? "bg-accent text-foreground"
                : "text-muted-foreground"
            )}
          >
            手动
          </button>
        </div>

        {addMemberMode === "picker" ? (
          contactsLoading ? (
            <div className="text-[10px] text-muted-foreground py-2">载入联系人…</div>
          ) : contacts.length === 0 ? (
            <div className="rounded border border-dashed border-border/60 p-2 text-[10px] text-muted-foreground">
              CatsCo 里先加好友或建 bot
            </div>
          ) : (
            <div className="max-h-40 overflow-auto rounded-md border border-border/60">
              {contacts
                .filter((c) => !members.some((m) => m.subjectId === c.subjectId))
                .map((c) => (
                  <button
                    key={c.subjectId}
                    onClick={() => onAddMember(c.subjectId, "editor")}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent/50"
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold text-white",
                        c.kind === "agent" ? "bg-violet-500" : "bg-primary"
                      )}
                    >
                      {c.displayName.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] font-medium">
                        {c.displayName}
                      </div>
                      <div className="truncate text-[9px] text-muted-foreground">
                        @{c.username}
                      </div>
                    </div>
                    <span className="text-[9px] text-muted-foreground">+ 加入</span>
                  </button>
                ))}
            </div>
          )
        ) : (
          <div className="flex items-center gap-1.5">
            <input
              value={newMemberId}
              onChange={(e) => setNewMemberId(e.target.value)}
              placeholder="u123 或 a456"
              className="flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] outline-none focus:ring-1 focus:ring-primary"
            />
            <select
              value={newMemberRole}
              onChange={(e) => setNewMemberRole(e.target.value as "viewer" | "editor")}
              className="rounded-md border border-border bg-background px-1.5 py-1 text-[11px] outline-none"
            >
              <option value="editor">editor</option>
              <option value="viewer">viewer</option>
            </select>
            <button
              onClick={onAddMemberManual}
              disabled={!newMemberId.trim()}
              className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
            >
              添加
            </button>
          </div>
        )}

        {/* Invite link */}
        <button
          onClick={() => {
            const url = `${window.location.origin}/?invite=${projectId}`;
            void navigator.clipboard.writeText(url);
          }}
          className="mt-2 w-full rounded-md border border-border/60 px-2 py-1 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          title="复制邀请链接"
        >
          ＋ 复制邀请链接
        </button>
        <div className="mt-1 text-[9px] text-muted-foreground/50">
          好友点链接 → 自动加入项目 · agent 收到 setup prompt
        </div>
      </div>
    </aside>
  );
}

function LoadingPane() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-[13px] text-muted-foreground">载入中…</div>
    </div>
  );
}

function SignInPane() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(apiPath("/api/auth/me"), {
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      if (!res.ok) {
        setError("无效的 CatsCo token");
        return;
      }
      // Persist for subsequent loads — Bearer in header is fine for API calls,
      // but the WS provider reads ?token= from the URL; stash in sessionStorage.
      sessionStorage.setItem("sumi.token", token.trim());
      window.location.reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-3 rounded-2xl border border-border/60 p-6 shadow-sm"
      >
        <div className="text-[15px] font-medium">登录 Sumi</div>
        <div className="text-[12px] text-muted-foreground">
          粘贴你的 CatsCo Bearer token（JWT）
        </div>
        <textarea
          required
          rows={4}
          placeholder="eyJhbGciOiJIUzI1NiIs…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-[12px] outline-none focus:ring-1 focus:ring-primary"
        />
        {error && (
          <div className="text-[12px] text-destructive">{error}</div>
        )}
        <button
          type="submit"
          disabled={busy || !token.trim()}
          className="w-full rounded-lg bg-primary py-2 text-[13px] font-medium text-primary-foreground transition-opacity disabled:opacity-50"
        >
          {busy ? "…" : "登录"}
        </button>
        <div className="text-center text-[11px] text-muted-foreground/70">
          Agent 接入：连接 WS 时加 <code>?api_key=cc_…</code>
        </div>
      </form>
    </div>
  );
}

function splitDocId(docId: string): [string, string] {
  const idx = docId.indexOf("-");
  if (idx === -1) return ["default", docId];
  return [docId.slice(0, idx), docId.slice(idx + 1)];
}


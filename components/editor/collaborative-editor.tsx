"use client";

/**
 * Collaborative markdown/html editor.
 *
 * Minimal surface:
 *   - yCollab + WebsocketProvider for CRDT sync
 *   - awareness for remote carets + "vibeWriting" AI lock signal
 *   - prefillOnConnect — seed local Yjs before joining the room
 *   - onCollaboratorsChange — surface remote presence
 *   - restoreToken — force-reset the doc to initialContent when bumped
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightSpecialChars,
  drawSelection,
  highlightActiveLine,
  dropCursor,
  lineNumbers,
  highlightActiveLineGutter,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  indentOnInput,
  bracketMatching,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";

import {
  getUserColorById,
  generateUserColor,
  generateUserName,
  resolveWsUrl,
} from "@/lib/utils";
import { createMarkdownExtensions, createHtmlExtensions } from "./markdown-extensions";
import {
  getInlineDiffExtensions,
  setCurrentFile,
  setPendingEditsEffect,
  setYjsRefs as setDiffYjsRefs,
} from "./inline-diff-extension";
import {
  getLockExtensions,
  setOwnLocks,
  setRemoteLocks,
  setLockFile,
  setLockUser,
  setLockYjsRefs,
  type RemoteLockInfo,
} from "./pending-edit-lock-extension";
import { tapExtension } from "./tap-completion";
import { wrapSelectionWith } from "./format-helpers";
import { useEditStore } from "@/stores/edit-store";
import { registerProvider } from "@/lib/provider-registry";

export type EditorMode = "markdown" | "html";

export interface CollaboratorInfo {
  name: string;
  color: string;
  id?: string;
  image?: string;
}

export interface CollaborativeEditorProps {
  projectId: string;
  fileId: string;
  fileName?: string;
  initialContent?: string;
  /** When bumped, force-reset the Yjs doc to `initialContent` (version restore). */
  restoreToken?: number;
  onContentChange?: (content: string) => void;
  onCollaboratorsChange?: (collaborators: CollaboratorInfo[]) => void;
  /** e.g. "ws://localhost:12345" — room name is derived internally. */
  wsUrl?: string;
  mode?: EditorMode;
  /** Prefill local Yjs with initialContent before sync — avoids a flash of empty. */
  prefillOnConnect?: boolean;
  userId?: string;
  userName?: string;
  userImage?: string;
  onEditorReady?: (view: EditorView | null) => void;
  onCursorLineChange?: (line: number) => void;
  /** Cmd+Shift+I — ask an agent about the current selection / doc. */
  onAskAgent?: (selection: {
    text: string;
    startLine: number;
    endLine: number;
  } | null) => void;
  /** TAP ghost-text 补全开关（env gate 之外的用户侧开关）。 */
  tapEnabled?: boolean;
  onConnectionStatusChange?: (status: {
    isConnected: boolean;
    isSynced: boolean;
  }) => void;
}

export default function CollaborativeEditor({
  projectId,
  fileId,
  fileName,
  initialContent,
  restoreToken,
  onContentChange,
  onCollaboratorsChange,
  wsUrl,
  mode = "markdown",
  prefillOnConnect = false,
  userId,
  userName,
  userImage,
  onEditorReady,
  onCursorLineChange,
  onAskAgent,
  onConnectionStatusChange,
  tapEnabled = false,
}: CollaborativeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const tapCompartmentRef = useRef<Compartment | null>(null);

  const [, setCollaborators] = useState<CollaboratorInfo[]>([]);
  const [, setIsSynced] = useState(false);

  // Keep latest callbacks in refs so the CM effect doesn't re-run
  const onContentChangeRef = useRef(onContentChange);
  const onCollaboratorsChangeRef = useRef(onCollaboratorsChange);
  const onCursorLineChangeRef = useRef(onCursorLineChange);
  const onAskAgentRef = useRef(onAskAgent);
  const onConnectionStatusChangeRef = useRef(onConnectionStatusChange);
  const onEditorReadyRef = useRef(onEditorReady);
  const initialContentRef = useRef(initialContent);
  const tapEnabledRef = useRef(tapEnabled);

  useEffect(() => {
    onContentChangeRef.current = onContentChange;
    onCollaboratorsChangeRef.current = onCollaboratorsChange;
    onCursorLineChangeRef.current = onCursorLineChange;
    onAskAgentRef.current = onAskAgent;
    onConnectionStatusChangeRef.current = onConnectionStatusChange;
    onEditorReadyRef.current = onEditorReady;
    initialContentRef.current = initialContent;
    tapEnabledRef.current = tapEnabled;
  });

  // Explicit prop wins; otherwise the deployment's configured URL. Behind the
  // artifact gateway that URL must carry the app prefix, because the gateway
  // routes by that path segment — a bare host:port reaches nothing.
  const effectiveWsUrl = wsUrl || resolveWsUrl();

  // --- Restore token: wipe and re-seed --------------------------------------
  useEffect(() => {
    if (restoreToken === undefined || restoreToken === 0) return;
    const ydoc = ydocRef.current;
    if (!ydoc) return;
    const ytext = ydoc.getText("content");
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, initialContentRef.current || "");
    });
  }, [restoreToken]);

  // --- Main editor effect -----------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;

    setIsSynced(false);

    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;
    const ytext = ydoc.getText("content");

    // No pre-sync prefill.
    //
    // This used to insert `initialContent` locally before joining the room, to
    // avoid a blank flash. But the server also seeds a fresh room from the same
    // content, and two independent inserts at the same position are concurrent
    // operations — Yjs keeps both. Every connect therefore duplicated the document
    // (5 chars in, 10 chars out; the real one grew to tens of megabytes), and the
    // autosave wrote the doubled text back, so it doubled again on the next open.
    //
    // Seeding on the server makes the prefill unnecessary as well as harmful: the
    // room already has the content, so sync delivers it and there is no blank
    // flash to cover. The post-sync insert below still handles a genuinely empty
    // room (a brand-new document), where there is nothing to collide with.

    const roomName = `${projectId}-${fileId}`;
    // Browser session token is stored in sessionStorage by the sign-in screen;
    // agents pass ?api_key=<cc_…> directly on the WS URL.
    const token =
      typeof window !== "undefined"
        ? sessionStorage.getItem("sumi.token")
        : null;
    const provider = new WebsocketProvider(effectiveWsUrl, roomName, ydoc, {
      params: token ? { token } : {},
    });
    providerRef.current = provider;
    const unregister = registerProvider(roomName, provider);

    // Offline persistence — IndexedDB mirror of the Yjs doc. Even if the WS
    // is unreachable, edits land in local storage and sync up on reconnect.
    let idbPersistence: IndexeddbPersistence | null = null;
    if (typeof window !== "undefined" && window.indexedDB) {
      // Versioned key. The local mirror is merged into the doc on open, so a copy
      // written while the doc was inflated would re-inflate it on the next visit —
      // bumping the key abandons those copies instead of resurrecting them.
      idbPersistence = new IndexeddbPersistence(`sumi-doc-v2-${roomName}`, ydoc);
    }

    const userColor = userId ? getUserColorById(userId) : generateUserColor();
    const displayName = userName || generateUserName();
    provider.awareness.setLocalStateField("user", {
      name: displayName,
      color: userColor,
      colorLight: userColor + "33",
      id: userId,
      image: userImage,
    });

    let contentInitialized = false;
    const handleSync = (synced: boolean) => {
      if (synced && !contentInitialized) {
        contentInitialized = true;
        const initialValue = initialContentRef.current;
        if (ytext.length === 0 && initialValue) {
          ytext.insert(0, initialValue);
        }
        setIsSynced(true);
        onConnectionStatusChangeRef.current?.({
          isConnected: true,
          isSynced: true,
        });
        // A pending-edit navigation may have queued a scroll target before
        // this doc finished syncing — consume it once content is ready.
        const pendingLine = useEditStore.getState().consumePendingScrollLine();
        if (pendingLine !== null && viewRef.current) {
          scrollToLine(viewRef.current, pendingLine);
        }
      }
    };
    provider.on("sync", handleSync);
    if (provider.synced) handleSync(true);

    provider.on("status", ({ status }: { status: string }) => {
      onConnectionStatusChangeRef.current?.({
        isConnected: status === "connected",
        isSynced: provider.synced,
      });
    });

    const updateCollaborators = () => {
      const states = provider.awareness.getStates();
      const users: CollaboratorInfo[] = [];
      states.forEach((state) => {
        if (state.user) {
          users.push({
            name: state.user.name,
            color: state.user.color,
            id: state.user.id,
            image: state.user.image,
          });
        }
      });
      setCollaborators(users);
      onCollaboratorsChangeRef.current?.(users);
    };
    provider.awareness.on("change", updateCollaborators);
    updateCollaborators();

    // --- CodeMirror ------------------------------------------------------------
    const languageCompartment = new Compartment();
    const tapCompartment = new Compartment();
    tapCompartmentRef.current = tapCompartment;
    const languageExtensions =
      mode === "html" ? createHtmlExtensions() : createMarkdownExtensions();

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),

        // Trigger completion on markdown-ish triggers
        EditorView.updateListener.of(() => {}),

        rectangularSelectionPlaceholder(),
        crosshairPlaceholder(),

        highlightActiveLine(),
        EditorView.lineWrapping,

        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          ...lintKeymap,
          indentWithTab,
        ]),

        // Apple-grade markdown formatting shortcuts
        keymap.of([
          { key: "Mod-b", run: wrapSelectionWith("**"), preventDefault: true },
          { key: "Mod-i", run: wrapSelectionWith("*"), preventDefault: true },
          { key: "Mod-u", run: wrapSelectionWith("<u>", "</u>"), preventDefault: true },
          { key: "Mod-Shift-x", run: wrapSelectionWith("~~"), preventDefault: true },
          { key: "Mod-e", run: wrapSelectionWith("`"), preventDefault: true },
          {
            key: "Mod-Shift-i",
            run: (view) => {
              if (!onAskAgentRef.current) return false;
              const sel = view.state.selection.main;
              if (sel.empty) {
                onAskAgentRef.current(null);
              } else {
                const text = view.state.doc.sliceString(sel.from, sel.to);
                const startLine = view.state.doc.lineAt(sel.from).number;
                const endLine = view.state.doc.lineAt(sel.to).number;
                onAskAgentRef.current({ text, startLine, endLine });
              }
              return true;
            },
            preventDefault: true,
          },
        ]),

        languageCompartment.of(languageExtensions),
        // TAP ghost-text 补全 —— compartment 化，开关切换不重建编辑器
        tapCompartment.of(
          tapExtension(tapEnabledRef.current, { projectId, fileId })
        ),

        // Yjs collab — the core
        yCollab(ytext, provider.awareness),

        // Agent pending-edit decorations
        ...getInlineDiffExtensions(),
        ...getLockExtensions(),

        EditorView.updateListener.of((update) => {
          if (update.docChanged && onContentChangeRef.current) {
            onContentChangeRef.current(update.state.doc.toString());
          }
          if (update.selectionSet && onCursorLineChangeRef.current) {
            const pos = update.state.selection.main.head;
            onCursorLineChangeRef.current(
              update.state.doc.lineAt(pos).number
            );
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    onEditorReadyRef.current?.(view);

    // ---- Locks + pending edits wiring -----------------------------------
    const locksMap = ydoc.getMap<RemoteLockInfo>("pendingLocks");
    const effectiveUserId = userId || `anonymous_${Math.random().toString(36).slice(2, 8)}`;

    setLockUser(view, effectiveUserId);
    setLockFile(view, fileId);
    setLockYjsRefs(view, ydoc, ytext);

    setCurrentFile(view, fileId);
    setDiffYjsRefs(view, ydoc, ytext);

    useEditStore.getState().setCurrentUserInfo(
      effectiveUserId,
      displayName,
      userColor
    );
    useEditStore.getState().setYjsRefs(ydoc, ytext, fileId);

    // Re-resolve RelPos → live line numbers whenever the Yjs doc drifts.
    // Defer via rAF so we never dispatch a CM update inside a Yjs observe.
    const handleYjsChange = () => {
      requestAnimationFrame(() => {
        useEditStore.getState().updateLineNumbersFromRelPos();
        // Force the inline-diff decorations to recompute positions.
        view.dispatch({
          effects: setPendingEditsEffect.of(
            useEditStore.getState().pendingEdits
          ),
        });
      });
    };
    ytext.observe(handleYjsChange);

    // pendingLocks Y.Map —— 自己的 pending-edit locks 推进共享 map，
    // 远端客户端据此渲染灰色锁定行 + 编辑者角标。
    useEditStore.getState().setSyncLocksCallback((locks) => {
      const keysToDelete: string[] = [];
      locksMap.forEach((lock, key) => {
        if (lock.userId === effectiveUserId) keysToDelete.push(key);
      });
      ydoc.transact(() => {
        keysToDelete.forEach((k) => locksMap.delete(k));
        locks.forEach((l) => locksMap.set(l.id, l));
      });
    });

    // pendingEdits 变化 → 更新本地装饰 + 同步进 Y.Map（先清旧 own-locks）
    const pushOwnLocks = () => {
      const locks = useEditStore.getState().getEditLocks(fileId, effectiveUserId);
      setOwnLocks(view, locks);
      useEditStore.getState().syncLocksCallback?.(locks);
    };
    const unsubscribeEdits = useEditStore.subscribe(pushOwnLocks);
    pushOwnLocks();

    const handleLocksChange = () => {
      const remote: RemoteLockInfo[] = [];
      locksMap.forEach((lock) => {
        if (lock.userId === effectiveUserId) return;
        const a = lock.fileId || "";
        const b = fileId;
        if (a === b || a.endsWith(b) || b.endsWith(a)) remote.push(lock);
      });
      setRemoteLocks(view, remote);
    };
    locksMap.observe(handleLocksChange);
    handleLocksChange();

    return () => {
      onEditorReadyRef.current?.(null);
      ytext.unobserve(handleYjsChange);
      unsubscribeEdits();
      locksMap.unobserve(handleLocksChange);
      useEditStore.getState().setSyncLocksCallback(null);
      // 卸下自己的 locks，避免残留幽灵锁定行
      ydoc.transact(() => {
        const stale: string[] = [];
        locksMap.forEach((lock, key) => {
          if (lock.userId === effectiveUserId) stale.push(key);
        });
        stale.forEach((k) => locksMap.delete(k));
      });
      view.destroy();
      unregister();
      provider.awareness.off("change", updateCollaborators);
      provider.destroy();
      idbPersistence?.destroy();
      ydoc.destroy();
      viewRef.current = null;
      providerRef.current = null;
      ydocRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fileId, effectiveWsUrl, mode, prefillOnConnect]);

  // --- TAP 开关：compartment reconfigure，不触碰 ydoc/provider -------------
  useEffect(() => {
    const view = viewRef.current;
    const compartment = tapCompartmentRef.current;
    if (!view || !compartment) return;
    view.dispatch({
      effects: compartment.reconfigure(
        tapExtension(tapEnabled, { projectId, fileId })
      ),
    });
  }, [tapEnabled, projectId, fileId]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-auto"
      data-testid="collaborative-editor"
    />
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap the current selection (or insert empty pair) — see format-helpers.ts. */
const wrap = wrapSelectionWith;

// Small placeholders to keep imports tidy (CM requires these as extensions).
function rectangularSelectionPlaceholder() {
  return EditorView.editable.of(true);
}
function crosshairPlaceholder() {
  return [];
}

/** Scroll a 1-based line into view and place the cursor there. */
function scrollToLine(view: EditorView, line: number) {
  try {
    const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
    const pos = view.state.doc.line(clamped).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  } catch {
    // doc may be mid-sync — ignore
  }
}

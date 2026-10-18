"use client";

/**
 * Pending-edit store — agent-proposed changes awaiting human review.
 *
 * Inspired by a distilled architecture's edit-store. Single responsibility:
 *   - hold pendingEdits (per project, per file)
 *   - resolve current line numbers via Yjs RelPos at apply time
 *   - expose EditLocks for the editor to decorate/block
 *   - sync own locks into the Yjs `pendingLocks` map so other clients see them
 *
 * Apply flow:
 *   applyEdit → PATCH /api/edits/apply → ws-server POST /doc/:p/:f → Yjs broadcast
 */

import { create } from "zustand";
import { apiPath } from "@/lib/api-path";
import * as Y from "yjs";
import type { EditBlock, RelativePositionJSON } from "@/src/server/edit-position-tracker";
import { getAuthHeaders } from "@/lib/use-session";

export interface PendingEdit {
  id: string;
  projectId: string;
  filePath: string;
  blocks: EditBlock[];
  description?: string;
  status: "pending" | "applying" | "applied" | "rejected";
  createdAt: number;
  /** Actor that proposed this edit (agent or user). */
  authorId?: string;
  authorName?: string;
}

export interface EditLock {
  id: string;
  fileId: string;
  startLine: number;
  endLine: number;
  startRelPos?: RelativePositionJSON;
  endRelPos?: RelativePositionJSON;
  /** Owner of the pending edit that produced this lock. */
  userId: string;
  userName: string;
  userColor: string;
}

export type NavigateToFileCallback = (
  filePath: string,
  line?: number
) => void;
export type ApplyEditCallback = (
  filePath: string,
  blocks: EditBlock[]
) => boolean;

interface EditStoreState {
  pendingEdits: PendingEdit[];
  /** Cursor-style command-bar navigation state. */
  currentEditIndex: number;
  isCommandBarVisible: boolean;

  currentYDoc: Y.Doc | null;
  currentYText: Y.Text | null;
  currentFileId: string | null;
  currentUserId: string | null;
  currentUserName: string | null;
  currentUserColor: string | null;

  /** Callbacks wired by the shell / editor. */
  navigateToFileCallback: NavigateToFileCallback | null;
  applyCallback: ApplyEditCallback | null;
  /** Line the editor should scroll to once its doc is synced. */
  pendingScrollLine: number | null;

  /** Called by the editor to share Yjs refs + identity. */
  setYjsRefs: (ydoc: Y.Doc | null, ytext: Y.Text | null, fileId: string | null) => void;
  setCurrentUserInfo: (userId: string, name: string, color: string) => void;

  /** Replace the pending-edit list (server is source of truth). */
  setPendingEdits: (edits: PendingEdit[]) => void;
  /** Insert or replace a single edit. */
  upsertPendingEdit: (edit: PendingEdit) => void;
  removePendingEdit: (editId: string) => void;

  /** Locks owned by `userId` for `fileId` (RelPos-aware). */
  getEditLocks: (fileId: string, userId: string) => EditLock[];
  /** Callback wired by the editor to push locks into Y.Map. */
  syncLocksCallback: ((locks: EditLock[]) => void) | null;
  setSyncLocksCallback: (cb: ((locks: EditLock[]) => void) | null) => void;
  getPendingLocks: () => EditLock[];

  setNavigateToFileCallback: (cb: NavigateToFileCallback | null) => void;
  setApplyCallback: (cb: ApplyEditCallback | null) => void;
  /** Consume the queued scroll target (returns it once). */
  consumePendingScrollLine: () => number | null;

  /** Re-resolve block line numbers against live Yjs state (display). */
  updateLineNumbersFromRelPos: () => void;
  /** Jump to the file+line of the current edit. */
  navigateToCurrentEdit: () => void;

  /** Apply an edit through the internal API. */
  applyEdit: (editId: string) => Promise<void>;
  /** Reject = drop the pending edit without touching the doc. */
  rejectEdit: (editId: string) => void;
  applyAll: () => Promise<void>;
  rejectAll: () => void;

  setCurrentEditIndex: (index: number) => void;
  nextEdit: () => void;
  prevEdit: () => void;
  getCurrentEdit: () => PendingEdit | null;
  getPendingCount: () => number;
}

/** Resolve a RelPos to a 1-based line number. */
function getLineFromRelPos(
  ydoc: Y.Doc | null,
  ytext: Y.Text | null,
  relPosJSON: RelativePositionJSON | undefined
): number | null {
  if (!ydoc || !ytext || !relPosJSON) return null;
  try {
    const relPos = Y.createRelativePositionFromJSON(relPosJSON);
    const absPos = Y.createAbsolutePositionFromRelativePosition(relPos, ydoc);
    if (!absPos) return null;
    return ytext.toString().slice(0, absPos.index).split("\n").length;
  } catch {
    return null;
  }
}

/** Current line numbers for a block — RelPos when available, stored otherwise. */
export function getEffectiveLineNumbers(
  block: EditBlock,
  ydoc?: Y.Doc | null,
  ytext?: Y.Text | null
): { startLine: number; endLine: number } {
  if (ydoc && ytext && block.startRelPos && block.endRelPos) {
    const start = getLineFromRelPos(ydoc, ytext, block.startRelPos);
    const end = getLineFromRelPos(ydoc, ytext, block.endRelPos);
    if (start !== null && end !== null) return { startLine: start, endLine: end };
  }
  return { startLine: block.startLine, endLine: block.endLine };
}

function filePathMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const an = a.split("/").pop() || a;
  const bn = b.split("/").pop() || b;
  return an === bn || a.endsWith(bn) || b.endsWith(an);
}

export const useEditStore = create<EditStoreState>((set, get) => ({
  pendingEdits: [],
  currentEditIndex: 0,
  isCommandBarVisible: false,
  currentYDoc: null,
  currentYText: null,
  currentFileId: null,
  currentUserId: null,
  currentUserName: null,
  currentUserColor: null,
  syncLocksCallback: null,
  navigateToFileCallback: null,
  applyCallback: null,
  pendingScrollLine: null,

  setYjsRefs: (ydoc, ytext, fileId) =>
    set({ currentYDoc: ydoc, currentYText: ytext, currentFileId: fileId }),

  setCurrentUserInfo: (userId, name, color) =>
    set({ currentUserId: userId, currentUserName: name, currentUserColor: color }),

  setPendingEdits: (edits) =>
    set((state) => ({
      pendingEdits: edits,
      currentEditIndex: Math.min(
        state.currentEditIndex,
        Math.max(0, edits.length - 1)
      ),
      isCommandBarVisible:
        state.isCommandBarVisible || edits.some((e) => e.status === "pending"),
    })),

  upsertPendingEdit: (edit) =>
    set((state) => {
      const idx = state.pendingEdits.findIndex((e) => e.id === edit.id);
      const pendingEdits =
        idx === -1
          ? [...state.pendingEdits, edit]
          : state.pendingEdits.map((e, i) => (i === idx ? edit : e));
      return {
        pendingEdits,
        isCommandBarVisible:
          state.isCommandBarVisible ||
          pendingEdits.some((e) => e.status === "pending"),
      };
    }),

  removePendingEdit: (editId) =>
    set((state) => {
      const pendingEdits = state.pendingEdits.filter((e) => e.id !== editId);
      return {
        pendingEdits,
        currentEditIndex: Math.min(
          state.currentEditIndex,
          Math.max(0, pendingEdits.length - 1)
        ),
        isCommandBarVisible:
          state.isCommandBarVisible &&
          pendingEdits.some((e) => e.status === "pending"),
      };
    }),

  getEditLocks: (fileId, userId) => {
    const { pendingEdits, currentUserName, currentUserColor, currentYDoc, currentYText } = get();
    const locks: EditLock[] = [];
    for (const edit of pendingEdits) {
      if (edit.status !== "pending") continue;
      if (!filePathMatches(edit.filePath, fileId)) continue;
      const ownerId = edit.authorId || userId;
      if (ownerId !== userId) continue;
      for (const [i, block] of edit.blocks.entries()) {
        const { startLine, endLine } = getEffectiveLineNumbers(block, currentYDoc, currentYText);
        locks.push({
          id: `${edit.id}:${i}`,
          fileId,
          startLine,
          endLine,
          startRelPos: block.startRelPos,
          endRelPos: block.endRelPos,
          userId,
          userName: currentUserName || "You",
          userColor: currentUserColor || "#0A84FF",
        });
      }
    }
    return locks;
  },

  setSyncLocksCallback: (cb) => set({ syncLocksCallback: cb }),

  setNavigateToFileCallback: (cb) => set({ navigateToFileCallback: cb }),
  setApplyCallback: (cb) => set({ applyCallback: cb }),
  consumePendingScrollLine: () => {
    const line = get().pendingScrollLine;
    if (line !== null) set({ pendingScrollLine: null });
    return line;
  },

  updateLineNumbersFromRelPos: () => {
    const { pendingEdits, currentYDoc, currentYText, currentFileId } = get();
    if (!currentYDoc || !currentYText || !currentFileId) return;

    let hasChanges = false;
    const updatedEdits = pendingEdits.map((edit) => {
      if (edit.status !== "pending") return edit;
      if (!filePathMatches(edit.filePath, currentFileId)) return edit;
      const updatedBlocks = edit.blocks.map((block) => {
        if (!block.startRelPos || !block.endRelPos) return block;
        const { startLine, endLine } = getEffectiveLineNumbers(
          block,
          currentYDoc,
          currentYText
        );
        if (startLine !== block.startLine || endLine !== block.endLine) {
          hasChanges = true;
          return { ...block, startLine, endLine };
        }
        return block;
      });
      return { ...edit, blocks: updatedBlocks };
    });

    if (hasChanges) set({ pendingEdits: updatedEdits });
  },

  navigateToCurrentEdit: () => {
    const { pendingEdits, currentEditIndex, navigateToFileCallback } = get();
    const currentEdit = pendingEdits[currentEditIndex];
    if (!currentEdit) return;
    const block = currentEdit.blocks[0];
    if (block?.startLine) set({ pendingScrollLine: block.startLine });
    navigateToFileCallback?.(currentEdit.filePath, block?.startLine);
  },

  getPendingLocks: () => {
    const { pendingEdits, currentFileId, currentUserId } = get();
    if (!currentFileId || !currentUserId) return [];
    return get().getEditLocks(currentFileId, currentUserId);
  },

  applyEdit: async (editId) => {
    const { pendingEdits, currentYDoc, currentYText, currentFileId } = get();
    const edit = pendingEdits.find((e) => e.id === editId);
    if (!edit || edit.status !== "pending") return;

    set((state) => ({
      pendingEdits: state.pendingEdits.map((e) =>
        e.id === editId ? { ...e, status: "applying" as const } : e
      ),
    }));

    try {
      // Re-resolve line numbers with RelPos so we apply at the CURRENT position
      let blocksToSend = edit.blocks;
      if (
        currentFileId &&
        currentYDoc &&
        currentYText &&
        filePathMatches(edit.filePath, currentFileId)
      ) {
        blocksToSend = edit.blocks.map((block) => {
          const { startLine, endLine } = getEffectiveLineNumbers(block, currentYDoc, currentYText);
          return { ...block, startLine, endLine };
        });
      }

      const res = await fetch(apiPath("/api/edits/apply"), {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: edit.projectId,
          filePath: edit.filePath,
          blocks: blocksToSend,
          editId: edit.id,
        }),
      });

      if (!res.ok) {
        set((state) => ({
          pendingEdits: state.pendingEdits.map((e) =>
            e.id === editId ? { ...e, status: "pending" as const } : e
          ),
        }));
        return;
      }

      set((state) => ({
        pendingEdits: state.pendingEdits.filter((e) => e.id !== editId),
      }));

      const cb = get().syncLocksCallback;
      if (cb) cb(get().getPendingLocks());

      // No DELETE here. The apply route already records the row as `applied` and
      // broadcasts that, whereas the delete route means "rejected" — calling it
      // after a successful apply wrote the opposite of what happened, and those
      // `rejected` rows are what replayed events then turned back into fresh
      // proposals. The row's final state should describe the decision, so the
      // apply path is left to own it.

      get().nextEdit();
      if (
        !get().pendingEdits.some((e) => e.status === "pending")
      ) {
        set({ isCommandBarVisible: false });
      }
    } catch {
      set((state) => ({
        pendingEdits: state.pendingEdits.map((e) =>
          e.id === editId ? { ...e, status: "pending" as const } : e
        ),
      }));
    }
  },

  rejectEdit: (editId) => {
    set((state) => ({
      pendingEdits: state.pendingEdits.filter((e) => e.id !== editId),
    }));
    const cb = get().syncLocksCallback;
    if (cb) cb(get().getPendingLocks());
    // Mark as rejected server-side so the queue stays consistent.
    fetch(apiPath("/api/pending-edits"), {
      method: "DELETE",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ editId }),
    }).catch(() => undefined);

    get().nextEdit();
    if (!get().pendingEdits.some((e) => e.status === "pending")) {
      set({ isCommandBarVisible: false });
    }
  },

  applyAll: async () => {
    const pendingOnly = get().pendingEdits.filter(
      (e) => e.status === "pending"
    );
    for (const edit of pendingOnly) {
      await get().applyEdit(edit.id);
    }
  },

  rejectAll: () => {
    const pendingIds = get()
      .pendingEdits.filter((e) => e.status === "pending")
      .map((e) => e.id);

    set({ pendingEdits: [], currentEditIndex: 0, isCommandBarVisible: false });

    const cb = get().syncLocksCallback;
    if (cb) cb(get().getPendingLocks());

    // Single bulk call — N individual DELETEs are slow + race-prone.
    if (pendingIds.length > 0) {
      fetch(apiPath("/api/pending-edits/bulk-reject"), {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ ids: pendingIds }),
      }).catch(() => undefined);
    }
  },

  setCurrentEditIndex: (index) => {
    const { pendingEdits } = get();
    if (index >= 0 && index < pendingEdits.length) {
      set({ currentEditIndex: index });
    }
  },

  nextEdit: () => {
    const { pendingEdits, currentEditIndex } = get();
    if (!pendingEdits.some((e) => e.status === "pending")) return;
    for (let i = currentEditIndex + 1; i < pendingEdits.length; i++) {
      if (pendingEdits[i].status === "pending") {
        set({ currentEditIndex: i });
        return;
      }
    }
    for (let i = 0; i < currentEditIndex; i++) {
      if (pendingEdits[i].status === "pending") {
        set({ currentEditIndex: i });
        return;
      }
    }
  },

  prevEdit: () => {
    const { pendingEdits, currentEditIndex } = get();
    if (!pendingEdits.some((e) => e.status === "pending")) return;
    for (let i = currentEditIndex - 1; i >= 0; i--) {
      if (pendingEdits[i].status === "pending") {
        set({ currentEditIndex: i });
        return;
      }
    }
    for (let i = pendingEdits.length - 1; i > currentEditIndex; i--) {
      if (pendingEdits[i].status === "pending") {
        set({ currentEditIndex: i });
        return;
      }
    }
  },

  getCurrentEdit: () => {
    const { pendingEdits, currentEditIndex } = get();
    return pendingEdits[currentEditIndex] || null;
  },

  getPendingCount: () => {
    return get().pendingEdits.filter((e) => e.status === "pending").length;
  },
}));

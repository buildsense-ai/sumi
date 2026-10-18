"use client";

/**
 * Persist the Yjs doc to canonical storage after idle.
 *
 * The Yjs room is the live source of truth; this hook snapshots it to
 * `/api/documents/content` every AUTOSAVE_DEBOUNCE_MS of user-idle so
 * a fresh client can seed without replaying Redis updates.
 *
 * Concurrency: PUT carries `baseContentHash`. On 409 FILE_CONFLICT we
 * re-GET the canonical hash once and retry with `force` — the Yjs doc is
 * authoritative for us, so overwriting is correct (remote collaborators
 * see the change via /replace anyway).
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { apiPath } from "./api-path";
import { getAuthHeaders } from "@/lib/use-session";
import { loadSettings } from "@/components/settings-dialog";
import { useUiStore } from "@/stores/ui-store";

const SAVE_ENDPOINT = apiPath("/api/documents/content");

/**
 * Give up waiting for the blob and let the editor render anyway.
 *
 * The canonical-content read is an optimisation, not a prerequisite: the document
 * itself arrives over Yjs, and in preview mode the editor falls back to the live
 * text it already has. Without a bound, a read that never settles leaves the whole
 * pane on the loading placeholder forever, and the only symptom anyone sees is a
 * spinner — which is indistinguishable from the app being broken.
 */
const LOAD_TIMEOUT_MS = 10_000;

export interface PersistenceState {
  /** Loaded once from canonical storage — pass to `initialContent`. */
  initialContent: string | null;
  loading: boolean;
  /** Latest save error (cleared on next success). */
  error: string | null;
  /** Timestamp of last successful save. */
  lastSavedAt: number | null;
  /** Set when a save hit a conflict twice (should be rare). */
  conflicted: boolean;
}

export function useDocPersistence(
  projectId: string | null,
  fileId: string | null
): PersistenceState & {
  /** Call from `onContentChange`. Triggers a debounced save. */
  scheduleSave: (content: string) => void;
} {
  const [initialContent, setInitialContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingContent = useRef<string | null>(null);
  const contentHash = useRef<string | null>(null);
  /** Set when a doc_restored patch lands — the restored content flows through
   *  the editor via Yjs and triggers a save; that save must NOT re-snapshot
   *  (the server already wrote a restore-safety version). */
  const skipNextAutoVersion = useRef(false);

  // Live-restore signal — when another client restores a version, the Yjs
  // doc updates and scheduleSave fires; suppress the follow-up auto-version.
  const lastRestore = useUiStore((s) => s.lastRestore);
  useEffect(() => {
    if (!lastRestore) return;
    if (lastRestore.documentId === `${projectId}-${fileId}`) {
      skipNextAutoVersion.current = true;
    }
  }, [lastRestore, projectId, fileId]);

  /** Fire-and-forget auto-version POST — the server decides whether the
   *  snapshot actually lands (debounce rules live in the route). */
  const triggerAutoVersion = useCallback(
    (content: string) => {
      if (!projectId || !fileId) return;
      if (skipNextAutoVersion.current) {
        skipNextAutoVersion.current = false;
        return;
      }
      void fetch(apiPath(`/api/projects/${projectId}/versions`), {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ fileId, source: "auto", content }),
      }).catch(() => {
        // best-effort — version history must never break the save path
      });
    },
    [projectId, fileId]
  );

  // Load canonical content + hash once, with a bound (see LOAD_TIMEOUT_MS).
  useEffect(() => {
    if (!projectId || !fileId) {
      setInitialContent("");
      setLoading(false);
      return;
    }
    setLoading(true);

    let settled = false;
    const finish = (content: string, hash: string | null) => {
      if (settled) return;
      settled = true;
      setInitialContent(content);
      contentHash.current = hash;
      setLoading(false);
    };

    const timer = setTimeout(() => finish("", contentHash.current), LOAD_TIMEOUT_MS);
    const url = `${SAVE_ENDPOINT}?projectId=${encodeURIComponent(projectId)}&filePath=${encodeURIComponent(fileId)}`;

    fetch(url, { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { content: "", exists: false }))
      .then((d) => finish(d.exists ? d.content : "", d.contentHash ?? null))
      .catch(() => finish("", null))
      .finally(() => clearTimeout(timer));

    return () => clearTimeout(timer);
  }, [projectId, fileId]);

  const flush = useCallback(async () => {
    if (!projectId || !fileId || pendingContent.current === null) return;
    const content = pendingContent.current;
    pendingContent.current = null;

    const attempt = async (body: Record<string, unknown>) => {
      const res = await fetch(SAVE_ENDPOINT, {
        method: "PUT",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res;
    };

    try {
      let res = await attempt({
        projectId,
        filePath: fileId,
        content,
        baseContentHash: contentHash.current ?? undefined,
      });

      if (res.status === 409) {
        // Someone else saved in between — re-read the current hash and
        // overwrite once. Yjs is authoritative locally; the conflict is
        // only about which canonical blob to store.
        const fresh = await fetch(
          `${SAVE_ENDPOINT}?projectId=${encodeURIComponent(projectId)}&filePath=${encodeURIComponent(fileId)}`,
          { headers: getAuthHeaders() }
        );
        if (fresh.ok) {
          const d = await fresh.json();
          contentHash.current = d.contentHash ?? null;
          res = await attempt({
            projectId,
            filePath: fileId,
            content,
            baseContentHash: contentHash.current ?? undefined,
          });
        }
      }

      if (res.ok) {
        const d = await res.json().catch(() => ({}));
        contentHash.current = d.contentHash ?? contentHash.current;
        setLastSavedAt(Date.now());
        setError(null);
        setConflicted(false);
        triggerAutoVersion(content);
      } else if (res.status === 409) {
        setConflicted(true);
        setError("内容冲突 — 稍后重试");
      } else {
        setError(`save failed: ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId, fileId, triggerAutoVersion]);

  const scheduleSave = useCallback(
    (content: string) => {
      pendingContent.current = content;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // Live-read — settings dialog edits apply without reload.
      const debounce = loadSettings().autosaveDelayMs;
      saveTimer.current = setTimeout(flush, debounce);
    },
    [flush]
  );

  // Flush on unmount / page hide
  useEffect(() => {
    const onHide = () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        flush();
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      flush();
    };
  }, [flush]);

  return { initialContent, loading, error, lastSavedAt, conflicted, scheduleSave };
}

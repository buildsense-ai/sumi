"use client";

/**
 * Executes a Spec action against the workspace.
 *
 * The decision of what to do is in `lib/spec-actions.ts` (pure, tested); this is
 * only the effect. Keeping the two apart means the parts that can be wrong in
 * interesting ways — a `javascript:` URL, a missing document id — are covered by
 * tests, and every caller (the registry's `actions` map, a custom component's
 * click handler) goes through the same validated path.
 */

import { specActionPlan } from "@/lib/spec-actions";
import { useUiStore } from "@/stores/ui-store";
import { useEditStore } from "@/stores/edit-store";

export function runSpecAction(name: unknown, params: unknown): boolean {
  const plan = specActionPlan(name, params);
  if (!plan) return false;

  switch (plan.kind) {
    case "open_document":
      // Routed through applyUiPatch rather than setCurrentDocumentId so that a
      // document opened from a Spec lands exactly like one opened from a patch —
      // same attention signal, same open-tab bookkeeping.
      useUiStore.getState().applyUiPatch({
        type: "open_document",
        documentId: plan.documentId,
      });
      return true;

    case "focus_range":
      useUiStore.getState().applyUiPatch({
        type: "focus_document_range",
        documentId: plan.documentId,
        startLine: plan.startLine,
        endLine: plan.endLine,
      });
      return true;

    case "apply_edit":
      void useEditStore.getState().applyEdit(plan.editId);
      return true;

    case "clipboard":
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        void navigator.clipboard.writeText(plan.text).catch(() => undefined);
        return true;
      }
      return false;

    case "url":
      if (typeof window !== "undefined") {
        window.open(plan.url, "_blank", "noopener,noreferrer");
        return true;
      }
      return false;
  }
}

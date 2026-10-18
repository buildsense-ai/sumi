/**
 * A2UI validators — zod schemas mirroring schema.ts.
 * Returns null on any invalid payload so callers never throw on malformed input.
 */

import { z } from "zod";
import type { UiPatch, JsonRenderPayload } from "./schema";

const uiPatchSchema = z.union([
  z.object({ type: z.literal("open_document"), documentId: z.string().min(1) }),
  z.object({ type: z.literal("show_management") }),
  z.object({ type: z.literal("show_ai_chat") }),
  z.object({
    type: z.literal("set_main_block"),
    block: z.enum(["editor", "preview", "graph", "management"]),
  }),
  z.object({
    type: z.literal("set_panel_visibility"),
    panel: z.enum(["sidebar", "ai", "inspector"]),
    visible: z.boolean(),
  }),
  z.object({
    type: z.literal("set_panel_size"),
    panel: z.enum(["sidebar", "ai", "inspector"]),
    widthPercent: z.number().min(10).max(90),
  }),
  z.object({
    type: z.literal("queue_prompt"),
    prompt: z.string().min(1),
    autoSend: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("set_sidebar_tab"),
    tab: z.enum(["outline", "members", "history"]),
    visible: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("set_project_view"),
    view: z.enum(["list", "table"]),
  }),
  z.object({
    type: z.literal("set_layout"),
    sidebarSide: z.enum(["left", "right"]).optional(),
    // Clamped at the edges of the surface rather than trusted: a ratio outside this
    // range hides one pane, which looks like a broken view rather than a setting.
    splitRatio: z.number().min(0.2).max(0.8).optional(),
  }),
  z.object({
    type: z.literal("set_theme"),
    accent: z.enum(["cyan", "violet", "emerald", "amber", "rose", "slate"]).optional(),
    density: z.enum(["compact", "comfortable"]).optional(),
  }),
  z.object({
    type: z.literal("focus_document_range"),
    documentId: z.string().min(1),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
  }),
  z.object({
    type: z.literal("set_editor_view"),
    view: z.enum(["source", "split", "preview"]),
  }),
  z.object({
    type: z.literal("pending_edit_changed"),
    projectId: z.string().min(1),
    fileId: z.string().min(1),
    edit: z.unknown().nullable(),
  }),
  z.object({
    type: z.enum([
      "intent_created",
      "intent_claimed",
      "intent_answered",
      "intent_closed",
    ]),
    projectId: z.string().min(1),
    fileId: z.string().min(1),
    intent: z.unknown().optional(),
    intentId: z.string().optional(),
  }),
  z.object({
    type: z.literal("doc_restored"),
    projectId: z.string().min(1),
    fileId: z.string().min(1),
    versionId: z.string().min(1),
  }),
  z.object({ type: z.literal("noop") }),
]);

export function validateUiPatch(input: unknown): UiPatch | null {
  const r = uiPatchSchema.safeParse(input);
  return r.success ? (r.data as UiPatch) : null;
}

// ---------------------------------------------------------------------------

const actionSchema = z.object({
  type: z.enum(["open_document", "queue_prompt", "open_url", "run_command"]),
  label: z.string().min(1),
  documentId: z.string().optional(),
  prompt: z.string().optional(),
  autoSend: z.boolean().optional(),
  url: z.string().optional(),
  command: z.string().optional(),
  variant: z.enum(["default", "secondary", "outline", "destructive"]).optional(),
  confirmTitle: z.string().optional(),
  confirmDescription: z.string().optional(),
});

const documentCardSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
  mainFile: z.string().optional(),
  actions: z.array(actionSchema).optional(),
});

const jsonRenderSchema = z.union([
  z.object({
    kind: z.literal("document_cards"),
    title: z.string().optional(),
    subtitle: z.string().optional(),
    documents: z.array(documentCardSchema),
    emptyMessage: z.string().optional(),
  }),
  z.object({
    kind: z.literal("progress"),
    runId: z.string().min(1),
    status: z.enum(["queued", "running", "completed", "error"]),
    progress: z.number().min(0).max(1),
    stage: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal("report"),
    runId: z.string().min(1),
    title: z.string().min(1),
    summary: z.string(),
    bodyMarkdown: z.string(),
    error: z.string().optional(),
  }),
  z.object({
    kind: z.literal("status"),
    requestId: z.string().min(1),
    status: z.enum(["running", "success", "error"]),
    action: z.object({ type: z.literal("open_full_preview") }).optional(),
  }),
]);

export function validateJsonRender(input: unknown): JsonRenderPayload | null {
  const r = jsonRenderSchema.safeParse(input);
  return r.success ? (r.data as JsonRenderPayload) : null;
}

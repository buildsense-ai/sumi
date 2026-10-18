"use client";

/**
 * json-render (vercel-labs) — shadcn/ui variant.
 *
 * Agents emit a flat Spec JSON:
 *   {
 *     root: "c1",
 *     elements: {
 *       c1: { type: "Card", props: {...}, children: ["t1","b1"] },
 *       t1: { type: "Text", props: { text: "…" } },
 *       b1: { type: "Button", props: { label:"打开" } },
 *     }
 *   }
 *
 * We use the official shadcn component catalog + registry — 36 components out of
 * the box — plus a small set of domain components for this workspace (documents,
 * the outline, document counts). Those are what make generated UI feel native
 * rather than generic: an agent can hand back the document's own outline instead of
 * describing it in prose.
 */

import { schema } from "@json-render/react/schema";
import { defineCatalog } from "@json-render/core";
import { defineRegistry, Renderer, JSONUIProvider } from "@json-render/react";
import { shadcnComponents, shadcnComponentDefinitions } from "@json-render/shadcn";
import { z } from "zod";
import { parseSpec } from "@/lib/spec";
import { runSpecAction } from "./action-runner";
import { TableOfContentsView, DocumentStatsView } from "./domain-views";

// ---------------------------------------------------------------------------
// Catalog — our domain components plus shadcn's built-ins
// ---------------------------------------------------------------------------

const tocItem = z.object({
  level: z.number().int().min(1).max(6),
  text: z.string(),
  /** 1-based line, needed for a clickable entry. */
  line: z.number().int().min(1).optional(),
});

export const sumiCatalog = defineCatalog(schema, {
  components: {
    DocumentCard: {
      props: z.object({
        title: z.string(),
        filePath: z.string().optional(),
        /** `${projectId}-${fileId}`; required for the card to be actionable. */
        documentId: z.string().optional(),
        updatedAt: z.string().optional(),
        description: z.string().optional(),
      }),
      slots: [],
      description: "A project document card — opens it in the editor",
      example: {
        title: "intro.md",
        filePath: "docs/intro.md",
        documentId: "prj_x-docs/intro.md",
      },
    },
    TableOfContents: {
      props: z.object({
        title: z.string().optional(),
        items: z.array(tocItem),
        documentId: z.string().optional(),
        activeLine: z.number().int().min(1).optional(),
        progress: z.number().min(0).max(1).optional(),
      }),
      slots: [],
      description:
        "The document's heading outline — clickable when documentId is given",
      example: {
        title: "目录",
        documentId: "prj_x-notes.md",
        items: [{ level: 1, text: "引言", line: 1 }],
      },
    },
    DocumentStats: {
      props: z.object({
        lines: z.number().optional(),
        words: z.number().optional(),
        chars: z.number().optional(),
        headings: z.number().optional(),
        readingMinutes: z.number().optional(),
      }),
      slots: [],
      description: "Counts for the open document",
      example: { lines: 120, words: 900, headings: 6 },
    },
    ...shadcnComponentDefinitions,
  },

  actions: {
    open_document: {
      description: "Open a document in the editor",
      params: z.object({ documentId: z.string() }),
    },
    jump_to_line: {
      description: "Scroll the editor to a line and place the cursor there",
      params: z.object({
        documentId: z.string(),
        line: z.number().int().min(1),
      }),
    },
    apply_pending_edit: {
      description: "Apply a pending edit by id",
      params: z.object({ editId: z.string() }),
    },
    copy_to_clipboard: {
      description: "Copy text to clipboard",
      params: z.object({ text: z.string() }),
    },
    open_url: {
      description: "Open external URL in a new tab",
      params: z.object({ url: z.string() }),
    },
  },
});

// ---------------------------------------------------------------------------
// Registry — renderers and action implementations
// ---------------------------------------------------------------------------

export const { registry, handlers, executeAction } = defineRegistry(sumiCatalog, {
  components: {
    // Shadcn's own implementations — full Radix UI + Tailwind
    ...shadcnComponents,

    DocumentCard: ({ props }) => (
      <div className="group rounded-lg border border-border/60 bg-card px-3 py-2 transition-shadow hover:shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium">{props.title}</div>
            {props.description && (
              <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                {props.description}
              </div>
            )}
            {props.filePath && (
              <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                {props.filePath}
              </div>
            )}
          </div>
          {props.updatedAt && (
            <div className="shrink-0 text-[10px] text-muted-foreground/60">
              {props.updatedAt}
            </div>
          )}
        </div>
        {props.documentId ? (
          <button
            onClick={() =>
              runSpecAction("open_document", { documentId: props.documentId })
            }
            className="mt-2 rounded-md border border-border px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-accent"
          >
            打开
          </button>
        ) : null}
      </div>
    ),

    // Presentation lives in ./domain-views so this file stays about wiring.
    TableOfContents: ({ props }) => <TableOfContentsView props={props} />,
    DocumentStats: ({ props }) => <DocumentStatsView props={props} />,
  },

  // Every action resolves through the same validated path a component's click
  // uses, so a Spec cannot open a `javascript:` URL or act on a document it did
  // not name.
  //
  // These used to be console.log stubs: a generated button rendered fine and did
  // nothing when pressed, which reads as broken UI rather than as an inert card.
  actions: {
    open_document: async (params) => {
      runSpecAction("open_document", params);
    },
    jump_to_line: async (params) => {
      runSpecAction("jump_to_line", params);
    },
    apply_pending_edit: async (params) => {
      runSpecAction("apply_pending_edit", params);
    },
    copy_to_clipboard: async (params) => {
      runSpecAction("copy_to_clipboard", params);
    },
    open_url: async (params) => {
      runSpecAction("open_url", params);
    },
  },
});

// ---------------------------------------------------------------------------
// Entry point — drop-in renderer for any spec
// ---------------------------------------------------------------------------

export interface SumiSpecRendererProps {
  /** Spec JSON string or parsed Spec object. */
  spec: unknown;
  className?: string;
}

export function SumiSpecRenderer({ spec, className }: SumiSpecRendererProps) {
  const parsed = parseSpec(spec);
  if (!parsed) {
    // Callers reach here with something Spec-shaped, so name the missing part
    // instead of a generic parse failure.
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
        无法渲染这段 UI 指令 — 需要 root 与 elements
      </div>
    );
  }
  return (
    <div className={className}>
      {/* The provider is required, not optional: several shadcn components read
          visibility and action context, and rendering without it throws
          "useVisibility must be used within a VisibilityProvider". That throw
          happens inside the tree, so the whole card disappears — a Spec failure
          that looks like "the agent's UI didn't render". */}
      <JSONUIProvider registry={registry}>
        <Renderer
          spec={parsed as Parameters<typeof Renderer>[0]["spec"]}
          registry={registry}
        />
      </JSONUIProvider>
    </div>
  );
}

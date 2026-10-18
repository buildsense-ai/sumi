"use client";

/**
 * Table of contents — a json-render component, so an agent can hand the
 * document's structure back as UI instead of describing it in prose.
 *
 * Rendered with the same indentation and active-section treatment as the outline
 * panel, because two representations of the same list that look different are two
 * things to learn.
 *
 * Lives here rather than in json-render.tsx so the catalog file stays about wiring
 * and this stays about presentation.
 */

import { cn } from "@/lib/utils";
import { Badge, Progress } from "@/components/ui/primitives";
import { runSpecAction } from "./action-runner";

export interface TocItem {
  level: number;
  text: string;
  line?: number;
}

export function TableOfContentsView({
  props,
}: {
  props: {
    title?: string;
    items?: TocItem[];
    documentId?: string;
    activeLine?: number;
    /** 0..1 — shown as a progress bar when present. */
    progress?: number;
  };
}) {
  const items = props.items ?? [];
  // A line with no document to open is not clickable: jumping needs the id, and a
  // dead affordance is worse than a static list.
  const canJump = Boolean(props.documentId);

  return (
    <div className="rounded-lg border border-border/60 bg-card px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[12px] font-medium">{props.title || "目录"}</span>
        <Badge variant="outline">{items.length}</Badge>
      </div>

      {typeof props.progress === "number" && (
        <Progress value={props.progress} className="mb-2" label="阅读进度" />
      )}

      {items.length === 0 ? (
        <div className="py-1 text-[11px] text-muted-foreground">没有标题</div>
      ) : (
        <ol className="space-y-0.5">
          {items.map((item, i) => {
            const isActive =
              typeof props.activeLine === "number" && item.line === props.activeLine;
            return (
              <li key={`${item.line ?? i}-${i}`}>
                <button
                  disabled={!canJump || item.line === undefined}
                  onClick={() =>
                    runSpecAction("jump_to_line", {
                      documentId: props.documentId,
                      line: item.line,
                    })
                  }
                  className={cn(
                    "flex w-full items-baseline gap-1.5 rounded px-1 py-0.5 text-left text-[11.5px] transition-colors",
                    isActive
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    !canJump && "cursor-default hover:bg-transparent"
                  )}
                  style={{ paddingLeft: `${(item.level - 1) * 10 + 4}px` }}
                  title={item.line !== undefined ? `第 ${item.line} 行` : undefined}
                >
                  <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
                    H{item.level}
                  </span>
                  <span className="truncate">{item.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** Document metrics — the numbers a reader asks about, in one place. */
export function DocumentStatsView({
  props,
}: {
  props: {
    lines?: number;
    words?: number;
    chars?: number;
    headings?: number;
    readingMinutes?: number;
  };
}) {
  const cells: Array<[string, number | undefined]> = [
    ["行", props.lines],
    ["字", props.words],
    ["字符", props.chars],
    ["标题", props.headings],
    ["分钟", props.readingMinutes],
  ];
  const shown = cells.filter(([, v]) => typeof v === "number");

  return (
    <div className="flex flex-wrap gap-2 rounded-lg border border-border/60 bg-card px-3 py-2">
      {shown.length === 0 ? (
        <span className="text-[11px] text-muted-foreground">没有可显示的统计</span>
      ) : (
        shown.map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-1">
            <span className="text-[13px] font-medium tabular-nums">{value}</span>
            <span className="text-[10px] text-muted-foreground">{label}</span>
          </div>
        ))
      )}
    </div>
  );
}

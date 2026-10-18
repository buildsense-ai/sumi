"use client";

/**
 * Outline (TOC) panel — the document's heading structure.
 *
 * Rebuilt around `buildToc`, which is pure: the panel now shows a filter, the
 * active section, and reading progress, and none of those rules live in JSX. The
 * parent re-renders on every content change and cursor move, so parsing headings
 * happens per render — cheap at document size.
 *
 * Clicking a heading scrolls the editor and puts the cursor at the line start.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { cn } from "@/lib/utils";
import { extractHeadings } from "@/lib/outline";
import { buildToc } from "@/lib/toc";
import { Badge, Input, Progress } from "@/components/ui/primitives";

interface OutlineSidebarProps {
  /** Live editor view — null in preview mode or before mount. */
  view: EditorView | null;
  /** Current document text (from onContentChange). */
  content: string;
  /** 1-based cursor line, from onCursorLineChange. */
  cursorLine: number | null;
  className?: string;
}

export default function OutlineSidebar({
  view,
  content,
  cursorLine,
  className,
}: OutlineSidebarProps) {
  const [query, setQuery] = useState("");
  const activeRef = useRef<HTMLLIElement | null>(null);

  const headings = useMemo(() => extractHeadings(content), [content]);
  const totalLines = useMemo(() => content.split("\n").length, [content]);

  const toc = useMemo(
    () => buildToc(headings, { query, cursorLine, totalLines }),
    [headings, query, cursorLine, totalLines]
  );

  // Keep the current section in view as the user writes. Scrolling the list is
  // `nearest`, not `start`: jumping the panel on every keystroke is worse than a
  // highlight that occasionally sits just off the edge.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [toc.activeIndex, toc.activeLine]);

  const jumpTo = (line: number) => {
    if (!view) return;
    try {
      const target = Math.min(line, view.state.doc.lines);
      const pos = view.state.doc.line(target).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 8 }),
      });
      view.focus();
    } catch {
      // Doc mid-update — the next render will offer the same target.
    }
  };

  return (
    <nav className={cn("flex h-full flex-col overflow-hidden", className)}>
      <div className="shrink-0 space-y-2 border-b border-border/50 px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">大纲</span>
          <Badge variant="outline">{toc.total}</Badge>
          {query && (
            <Badge variant="accent">
              {toc.entries.length}/{toc.total}
            </Badge>
          )}
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="筛选标题…"
          aria-label="筛选标题"
        />
      </div>

      {toc.total === 0 ? (
        <div className="p-4 text-[12px] text-muted-foreground">
          这篇文档还没有标题。用 # 开头写一行就有了。
        </div>
      ) : toc.entries.length === 0 ? (
        <div className="p-4 text-[12px] text-muted-foreground">
          没有匹配「{query}」的标题。
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto py-1.5">
          {toc.entries.map((h) => {
            const isActive = h.index === toc.entries[toc.activeIndex]?.index;
            return (
              <li key={`${h.line}-${h.index}`} ref={isActive ? activeRef : undefined}>
                <button
                  onClick={() => jumpTo(h.line)}
                  className={cn(
                    "flex w-full items-baseline gap-1.5 py-1 pr-3 text-left text-[12px] transition-colors",
                    isActive
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                  style={{ paddingLeft: `${(h.level - 1) * 10 + 10}px` }}
                  title={`${h.text || "（空标题）"} · 第 ${h.line} 行`}
                  aria-current={isActive ? "location" : undefined}
                >
                  <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
                    H{h.level}
                  </span>
                  <span className="truncate">{h.text || "（空标题）"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="shrink-0 space-y-1.5 border-t border-border/50 px-2.5 py-2">
        <Progress value={toc.progress} label="阅读进度" />
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70">
          {toc.activeLine !== null ? (
            <span>第 {toc.activeLine} 行</span>
          ) : (
            <span>光标不在任何标题下</span>
          )}
          <span className="ml-auto">共 {totalLines} 行</span>
        </div>
      </div>
    </nav>
  );
}

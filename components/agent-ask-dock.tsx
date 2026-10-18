"use client";

/**
 * Ask dock — a floating way to ask an agent, not a chat panel.
 *
 * Collapsed it is a single button in the corner. Expanded it is an input box and
 * nothing else: no thread list, no scrollback, no history. Asking is what an
 * editor needs to do in a hurry, and a panel that has to be opened, scrolled and
 * read before you can type is worse at that than one box that is always in the
 * same place.
 *
 * It still shows the outcome of the most recent ask — one line, replaced each
 * time. `answered` intents carry their reply in `answerText`, so a surface that
 * displays nothing would leave text answers invisible; the result is a status
 * line, not a log. The document changes an agent proposes arrive separately, as
 * pending-edit diffs in the editor, which is where reviewing them belongs.
 *
 * Asking goes through the same route as before (POST /api/intents), so the intent
 * pipeline is unchanged: a resident responder claims the intent, reads the
 * document, and answers — with any document change proposed as a pending edit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api-path";
import { cn } from "@/lib/utils";
import { getAuthHeaders } from "@/lib/use-session";
import { useIntentStore } from "@/stores/intent-store";
import { useUiStore } from "@/stores/ui-store";
import { askDockState } from "@/lib/ask-dock";
import { parseSpec } from "@/lib/spec";
import { SumiSpecRenderer } from "@/components/a2ui/json-render";
import type { IntentRow } from "@/src/intents";
import { toast } from "@/components/ui/toast";

interface AgentOption {
  subjectId: string;
  name: string | null;
}

export function AgentAskDock({
  open,
  onOpenChange,
  projectId,
  fileId,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  projectId: string | null;
  fileId: string | null;
}) {
  const [prompt, setPrompt] = useState("");
  const [targetAgent, setTargetAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const intents = useIntentStore((s) => s.intents);
  const setIntents = useIntentStore((s) => s.setIntents);
  const upsertIntent = useIntentStore((s) => s.upsertIntent);
  const setScope = useIntentStore((s) => s.setScope);
  const promptCommand = useUiStore((s) => s.promptCommand);
  const consumePromptCommand = useUiStore((s) => s.consumePromptCommand);

  const disabled = !projectId || !fileId;

  // Intent patches are routed by scope; without this the store would drop
  // everything aimed at the document on screen.
  useEffect(() => {
    setScope({ projectId, fileId });
  }, [projectId, fileId, setScope]);

  // Focus the box when it opens, however it was opened (button, shortcut, patch).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(t);
  }, [open]);

  // Esc closes from anywhere in the card — the box is an interruption, so
  // dismissing it should not require aiming at a small target.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  // `queue_prompt` patches arrive as a one-shot request. Adopt it, then
  // acknowledge, or it would re-fill the box on every render.
  useEffect(() => {
    if (!promptCommand) return;
    setPrompt(promptCommand.prompt);
    if (!open) onOpenChange(true);
    consumePromptCommand();
  }, [promptCommand, open, onOpenChange, consumePromptCommand]);

  // Rehydrate on open so the status line survives a reload. Only the newest rows
  // matter, hence the limit.
  useEffect(() => {
    if (!open || !projectId) return;
    let alive = true;
    const qs = new URLSearchParams({ projectId, limit: "20" });
    if (fileId) qs.set("fileId", fileId);
    fetch(apiPath(`/api/intents?${qs.toString()}`), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { intents: [] }))
      .then((d) => {
        if (alive) setIntents((d.intents ?? []) as IntentRow[]);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, projectId, fileId, setIntents]);

  // Who can be asked. Best-effort: the picker falls back to "所有 agent".
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch(apiPath("/api/friends"), { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((d) => {
        if (!alive) return;
        const list = ((d.agents ?? []) as Array<{
          subjectId: string;
          displayName?: string;
          username?: string;
        }>).map((a) => ({
          subjectId: a.subjectId,
          name: a.displayName || a.username || a.subjectId,
        }));
        setAgents(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open]);

  const dock = useMemo(
    () => askDockState(intents, { projectId, fileId }),
    [intents, projectId, fileId]
  );

  // Decide once whether the answer is UI. `askDockState` stays free of the Spec
  // format, and the renderer is only reached for answers that actually are one.
  const status = useMemo(
    () =>
      dock.kind === "answered"
        ? { ...dock, spec: parseSpec(dock.answer) }
        : dock,
    [dock]
  );

  const submit = useCallback(async () => {
    const text = prompt.trim();
    if (!text || busy || disabled) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { projectId, fileId, prompt: text };
      if (targetAgent) body.targetAgentId = targetAgent;
      const res = await fetch(apiPath("/api/intents"), {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast({
          title: "发送失败",
          description: data.error || `${res.status}`,
          variant: "destructive",
        });
        return;
      }
      const { intent } = (await res.json()) as { intent?: IntentRow };
      if (intent) upsertIntent(intent);
      setPrompt("");
    } catch (err) {
      toast({
        title: "发送失败",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }, [prompt, busy, disabled, projectId, fileId, targetAgent, upsertIntent]);

  // -------------------------------------------------------------------------
  // Collapsed — one button
  // -------------------------------------------------------------------------

  if (!open) {
    return (
      <button
        onClick={() => onOpenChange(true)}
        title="问 agent（⌘⇧I）"
        className={cn(
          "group fixed bottom-5 right-5 z-40 flex items-center gap-1.5 rounded-full",
          "border border-border/60 bg-background/80 px-3.5 py-2 text-[12px] font-medium",
          "material-glass shadow-sm backdrop-blur transition-all duration-200",
          "hover:border-primary/40 hover:text-primary"
        )}
      >
        <span aria-hidden className="text-primary">
          ✦
        </span>
        问 agent
      </button>
    );
  }

  // -------------------------------------------------------------------------
  // Expanded — the box
  // -------------------------------------------------------------------------

  return (
    <div className="fixed bottom-5 right-5 z-40 w-[min(92vw,430px)]">
      <div className="material-glass overflow-hidden rounded-xl border border-border/60 shadow-lg backdrop-blur">
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
          <span aria-hidden className="text-[11px] text-primary">
            ✦
          </span>
          <span className="text-[11px] font-medium text-muted-foreground">
            问 agent
          </span>
          <select
            value={targetAgent}
            onChange={(e) => setTargetAgent(e.target.value)}
            disabled={disabled}
            className="ml-1 rounded-md border border-border/60 bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground outline-none disabled:opacity-50"
          >
            <option value="">所有 agent</option>
            {agents.map((a) => (
              <option key={a.subjectId} value={a.subjectId}>
                {a.name || a.subjectId}
              </option>
            ))}
          </select>
          <button
            onClick={() => onOpenChange(false)}
            title="收起（Esc）"
            className="ml-auto rounded px-1.5 py-0.5 text-[12px] text-muted-foreground/70 hover:bg-accent hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="px-3 pb-1 pt-2.5">
          <textarea
            ref={inputRef}
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            disabled={disabled || busy}
            placeholder={
              disabled ? "打开一篇文档后可用" : "想问什么？改哪一段、加什么、查什么…"
            }
            className="w-full resize-none bg-transparent text-[13px] leading-6 outline-none placeholder:text-muted-foreground/50 disabled:opacity-50"
          />
        </div>

        <div className="flex items-center gap-2 px-3 pb-2.5">
          <span className="text-[10px] text-muted-foreground/50">
            {busy ? "发送中…" : "⌘↩ 发送 · Esc 收起"}
          </span>
          <button
            onClick={() => void submit()}
            disabled={disabled || busy || !prompt.trim()}
            className="ml-auto rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-opacity disabled:opacity-40"
          >
            发送
          </button>
        </div>

        {status.kind !== "idle" && (
          <div className="border-t border-border/50 bg-background/50 px-3 py-2">
            <div className="truncate text-[10px] text-muted-foreground/60">
              {status.prompt}
            </div>
            {status.kind === "waiting" ? (
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                已发送 · 等待回复
              </div>
            ) : status.spec ? (
              // An answer may be a json-render Spec rather than prose, in which
              // case it is UI, not text. Rendering the raw JSON here would show the
              // author the machine-readable form of their own answer.
              <div className="mt-1.5 max-h-72 overflow-auto">
                <SumiSpecRenderer spec={status.spec} />
              </div>
            ) : (
              <div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11.5px] leading-6 text-foreground/90">
                {status.answer}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

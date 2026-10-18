"use client";

/**
 * shadcn-shaped primitives for this app's chrome.
 *
 * Why these exist instead of the generated Radix set: the whole surface here is
 * built on the design tokens in globals.css (`bg-background`, `border-border/60`,
 * `text-muted-foreground`), and the interactions the app needs — buttons, inputs,
 * tabs, badges, progress, separators, scroll containers — need no behaviour Radix
 * supplies. The API deliberately matches shadcn's (same prop names, same variant
 * vocabulary, `cn` composition), so a generated component can replace any of these
 * later without touching a call site.
 *
 * Everything the assistant can drive is styled from tokens rather than literals:
 * a patch that changes the accent or the density has to be able to reach these
 * without a rebuild, and hard-coded colours would silently ignore it.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
type ButtonSize = "sm" | "md" | "icon";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  default:
    "bg-primary text-primary-foreground hover:bg-primary/90 disabled:hover:bg-primary",
  secondary: "bg-accent text-accent-foreground hover:bg-accent/70",
  outline:
    "border border-border/60 bg-background text-foreground hover:bg-accent/60",
  ghost: "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  destructive:
    "bg-destructive text-destructive-foreground hover:bg-destructive/90",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-6 rounded-md px-2 text-[11px]",
  md: "h-7 rounded-md px-2.5 text-[12px]",
  icon: "h-6 w-6 rounded-md p-0 text-[12px]",
};

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
  }
>(function Button(
  { className, variant = "outline", size = "sm", type = "button", ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-1 font-medium",
        "transition-colors outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
        "disabled:cursor-not-allowed disabled:opacity-40",
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className
      )}
      {...props}
    />
  );
});

// ---------------------------------------------------------------------------
// Input / Textarea
// ---------------------------------------------------------------------------

const FIELD_BASE =
  "w-full rounded-md border border-border/60 bg-background text-[12px] " +
  "outline-none transition-colors placeholder:text-muted-foreground/50 " +
  "focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/30 " +
  "disabled:opacity-50";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input ref={ref} className={cn(FIELD_BASE, "h-7 px-2", className)} {...props} />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, rows = 2, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(FIELD_BASE, "resize-none px-2 py-1.5 leading-6", className)}
      {...props}
    />
  );
});

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

type BadgeVariant = "default" | "secondary" | "outline" | "accent" | "success" | "warning";

const BADGE_VARIANTS: Record<BadgeVariant, string> = {
  default: "bg-primary/10 text-primary",
  secondary: "bg-muted text-muted-foreground",
  outline: "border border-border/60 text-muted-foreground",
  accent: "bg-accent text-accent-foreground",
  success: "bg-emerald-500/10 text-emerald-600",
  warning: "bg-amber-500/10 text-amber-600",
};

export function Badge({
  className,
  variant = "secondary",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
        BADGE_VARIANTS[variant],
        className
      )}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export function Progress({
  value,
  className,
  label,
}: {
  /** 0..1; clamped rather than allowed to overflow the track. */
  value: number;
  className?: string;
  label?: string;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className={cn("h-1 w-full overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className="h-full rounded-full bg-primary/70 transition-[width] duration-200"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Separator
// ---------------------------------------------------------------------------

export function Separator({
  orientation = "horizontal",
  className,
}: {
  orientation?: "horizontal" | "vertical";
  className?: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        "bg-border/60",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Tabs — a segmented control, which is what every tab strip in this app is
// ---------------------------------------------------------------------------

export interface TabItem<T extends string> {
  value: T;
  label: string;
  /** Optional count, rendered as a badge. */
  count?: number;
}

export function Tabs<T extends string>({
  items,
  value,
  onValueChange,
  className,
  size = "sm",
}: {
  items: Array<TabItem<T>>;
  value: T;
  onValueChange: (next: T) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-border/60 p-0.5",
        className
      )}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            aria-selected={selected}
            onClick={() => onValueChange(item.value)}
            className={cn(
              "inline-flex items-center gap-1 rounded font-medium transition-colors",
              size === "md" ? "px-2.5 py-1 text-[11px]" : "px-2 py-0.5 text-[10px]",
              selected
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {item.label}
            {typeof item.count === "number" && (
              <span className="tabular-nums opacity-60">{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScrollArea
// ---------------------------------------------------------------------------

export function ScrollArea({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("overflow-auto", className)} {...props} />;
}

// ---------------------------------------------------------------------------
// Card / EmptyState — the two containers the chrome keeps re-inventing
// ---------------------------------------------------------------------------

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-border/60 bg-card", className)}
      {...props}
    />
  );
}

export function EmptyState({
  title,
  hint,
  className,
}: {
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-dashed border-border/60 p-3 text-[11px] text-muted-foreground",
        className
      )}
    >
      <div>{title}</div>
      {hint && <div className="mt-1 text-[10px] opacity-70">{hint}</div>}
    </div>
  );
}

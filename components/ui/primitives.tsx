"use client";

/**
 * Small shadcn-shaped primitives.
 *
 * Token-based Tailwind rather than the Radix packages: this app's chrome is built
 * on the design tokens in globals.css (`bg-background`, `border-border/60`,
 * `text-muted-foreground`), and the panel work here needs no behaviour that Radix
 * supplies. The API shape matches shadcn so these can be swapped for the generated
 * versions later without touching call sites.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "w-full rounded-md border border-border/60 bg-background px-2 py-1 text-[12px]",
        "outline-none transition-colors placeholder:text-muted-foreground/50",
        "focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/30",
        "disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
});

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

type BadgeVariant = "default" | "secondary" | "outline" | "accent";

const BADGE_VARIANTS: Record<BadgeVariant, string> = {
  default: "bg-primary/10 text-primary",
  secondary: "bg-muted text-muted-foreground",
  outline: "border border-border/60 text-muted-foreground",
  accent: "bg-accent text-accent-foreground",
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
  /** 0..1; values outside the range are clamped rather than overflowing the bar. */
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
// ScrollArea — a scroll container with the app's thin scrollbar treatment
// ---------------------------------------------------------------------------

export function ScrollArea({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("overflow-auto", className)} {...props} />;
}

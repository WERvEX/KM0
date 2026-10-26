import type { Tier } from "@km0/shared";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px]",
  {
    variants: {
      tone: {
        neutral: "bg-sunken text-muted",
        accent: "bg-accent/15 text-accent",
        success: "bg-success/15 text-success",
        warning: "bg-warning/15 text-warning",
        danger: "bg-danger/10 text-danger",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps extends ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

/** A short label beside a name: a tier, native or not, a count of records. */
export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const TIER_TONE: Record<Tier, "success" | "accent" | "warning"> = { T1: "success", T2: "accent", T3: "warning" };

export function TierBadge({ tier, className }: { tier: Tier; className?: string }) {
  return (
    <Badge tone={TIER_TONE[tier]} className={cn("font-semibold", className)}>
      {tier}
    </Badge>
  );
}

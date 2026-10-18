import type { StageState } from "@km0/shared";
import { Check, Circle, CircleDashed, CircleDot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

const ICONS = { complete: Check, active: CircleDot, ready: CircleDashed, pending: Circle } as const;

export function StageStepper({ stages }: { stages: StageState[] }) {
  const { t } = useTranslation();
  if (stages.length < 2) return null;
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label={t("project.changePath")}>
      {stages.map((stage, index) => {
        const Icon = ICONS[stage.status];
        return (
          <li key={stage.stage} className="flex items-center gap-2">
            {index > 0 ? <span className="h-px w-6 bg-border" /> : null}
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs",
                stage.status === "active" || stage.status === "ready"
                  ? "border-accent bg-accent/10 font-medium text-fg"
                  : stage.status === "complete"
                    ? "border-border text-fg"
                    : "border-border text-muted",
              )}
              aria-current={stage.status === "active" || stage.status === "ready" ? "step" : undefined}
            >
              <Icon className="size-3.5" />
              {t(`project.stages.${stage.stage}`)}
              {stage.reviewKeys.length > 0 ? (
                <span className="rounded-full bg-warning/15 px-1.5 text-warning">{stage.reviewKeys.length}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

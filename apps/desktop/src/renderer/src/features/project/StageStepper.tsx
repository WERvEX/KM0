import type { ProjectDetail, StageStatus } from "@km0/shared";
import { Check, Circle, CircleDashed, CircleDot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

const ICONS = { complete: Check, active: CircleDot, ready: CircleDashed, pending: Circle } as const;

interface Step {
  id: string;
  label: string;
  status: StageStatus;
  reviews: number;
}

/** Where the project stands: the discussion stages of its path, then documents, routing and hand-off. */
export function StageStepper({ detail }: { detail: ProjectDetail }) {
  const { t } = useTranslation();
  const discussed = detail.discussionComplete;
  const documentsDone = detail.documents.every((doc) => doc.version !== null);
  const handedOff = detail.stage === "handoff";
  const after: Step[] = [
    ...(detail.documents.length > 0
      ? [
          {
            id: "documents",
            label: t("project.stages.documents"),
            status: (documentsDone ? "complete" : discussed ? "active" : "pending") as StageStatus,
            reviews: detail.documents.reduce((sum, doc) => sum + doc.staleSections, 0),
          },
        ]
      : []),
    {
      id: "routing",
      label: t("project.stages.routing"),
      status: handedOff ? "complete" : discussed && documentsDone ? "active" : "pending",
      reviews: 0,
    },
    { id: "handoff", label: t("project.stages.handoff"), status: handedOff ? "active" : "pending", reviews: 0 },
  ];
  const steps: Step[] = [
    ...detail.stages.map((stage) => ({
      id: stage.stage,
      label: t(`project.stages.${stage.stage}`),
      status: stage.status,
      reviews: stage.reviewKeys.length,
    })),
    ...after,
  ];

  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label={t("project.progress")}>
      {steps.map((step, index) => {
        const Icon = ICONS[step.status];
        const current = step.status === "active" || step.status === "ready";
        return (
          <li key={step.id} className="flex items-center gap-2">
            {index > 0 ? <span className="h-px w-4 bg-border" /> : null}
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs",
                current
                  ? "border-accent bg-accent/10 font-medium text-fg"
                  : step.status === "complete"
                    ? "border-border text-fg"
                    : "border-border text-muted",
              )}
              aria-current={current ? "step" : undefined}
            >
              <Icon className="size-3.5" />
              {step.label}
              {step.reviews > 0 ? (
                <span className="rounded-full bg-warning/15 px-1.5 text-warning">{step.reviews}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

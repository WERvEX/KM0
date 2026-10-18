import type { Decision, DiscussionStage, StageState } from "@km0/shared";
import { AlertTriangle, Pencil } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/field";
import { decisionLabel } from "./labels";

interface Props {
  stages: StageState[];
  decisions: Decision[];
  busy: boolean;
  onEdit: (key: string, text: string) => void;
  onReview: (stage: DiscussionStage) => void;
}

export function DecisionLedger({ stages, decisions, busy, onEdit, onReview }: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Decision | null>(null);
  const [text, setText] = useState("");

  const open = (decision: Decision) => {
    setEditing(decision);
    setText(decision.value.text);
  };

  return (
    <aside className="flex flex-col gap-5" aria-label={t("project.ledger.title")}>
      <h2 className="text-sm font-semibold">{t("project.ledger.title")}</h2>
      {decisions.length === 0 ? <p className="text-sm text-muted">{t("project.ledger.empty")}</p> : null}
      {stages.map((stage) => {
        const items = decisions.filter((decision) => decision.stage === stage.stage);
        if (items.length === 0) return null;
        return (
          <section key={stage.stage} className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium text-muted">{t(`project.stages.${stage.stage}`)}</h3>
              {stage.reviewKeys.length > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-warning"
                  disabled={busy}
                  onClick={() => onReview(stage.stage)}
                >
                  <AlertTriangle />
                  {t("project.ledger.review")}
                </Button>
              ) : null}
            </div>
            <ul className="flex flex-col gap-2">
              {items.map((decision) => (
                <li key={decision.key} className="group rounded-md border border-border bg-panel px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs text-muted">{decisionLabel(decision.key)}</span>
                    <button
                      type="button"
                      className="text-muted opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                      aria-label={`${t("project.ledger.edit")} ${decisionLabel(decision.key)}`}
                      disabled={busy}
                      onClick={() => open(decision)}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  </div>
                  <p className="mt-0.5 text-sm whitespace-pre-wrap">{decision.value.text}</p>
                  {decision.rationale ? <p className="mt-1 text-xs text-muted">{decision.rationale}</p> : null}
                  <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                    <span className="rounded bg-sunken px-1.5 py-0.5 text-muted">
                      {t(`project.ledger.source.${decision.source}`)}
                    </span>
                    {decision.needsReview ? (
                      <span className="rounded bg-warning/15 px-1.5 py-0.5 text-warning">
                        {t("project.ledger.needsReview")}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <Dialog
        open={editing !== null}
        onOpenChange={(value) => {
          if (!value) setEditing(null);
        }}
        title={editing ? `${t("project.ledger.editTitle")} · ${decisionLabel(editing.key)}` : ""}
        description={
          editing && editing.alternatives.length > 0
            ? t("project.ledger.alternatives", { value: editing.alternatives.join(" / ") })
            : undefined
        }
        footer={
          <>
            <Button onClick={() => setEditing(null)}>{t("project.ledger.cancel")}</Button>
            <Button
              variant="primary"
              disabled={!text.trim()}
              onClick={() => {
                if (editing) onEdit(editing.key, text.trim());
                setEditing(null);
              }}
            >
              {t("project.ledger.save")}
            </Button>
          </>
        }
      >
        <Textarea
          aria-label={t("project.ledger.editTitle")}
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </Dialog>
    </aside>
  );
}

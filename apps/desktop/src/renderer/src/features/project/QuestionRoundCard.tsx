import type { Answer, Question, QuestionRound } from "@km0/shared";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/field";
import { cn } from "@/lib/cn";

interface Draft {
  optionIds: string[];
  text: string;
  delegate: boolean;
}

const EMPTY: Draft = { optionIds: [], text: "", delegate: false };

function isAnswered(draft: Draft | undefined): boolean {
  return Boolean(draft && (draft.delegate || draft.optionIds.length > 0 || draft.text.trim()));
}

interface Props {
  round: QuestionRound;
  busy: boolean;
  onSubmit: (answers: Answer[]) => void;
  onAdoptAll: () => void;
}

export function QuestionRoundCard({ round, busy, onSubmit, onAdoptAll }: Props) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const unanswered = round.questions.filter((question) => !isAnswered(drafts[question.id])).length;

  const update = (question: Question, change: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [question.id]: { ...(current[question.id] ?? EMPTY), ...change } }));

  const fillRecommended = () =>
    setDrafts(
      Object.fromEntries(
        round.questions.map((question) => {
          const recommended = question.options.filter((option) => option.recommended).map((option) => option.id);
          return [question.id, { optionIds: recommended, text: "", delegate: recommended.length === 0 }];
        }),
      ),
    );

  const submit = () =>
    onSubmit(
      round.questions.map((question) => {
        const draft = drafts[question.id] ?? EMPTY;
        return {
          questionId: question.id,
          optionIds: draft.delegate ? [] : draft.optionIds,
          ...(draft.text.trim() && !draft.delegate ? { text: draft.text.trim() } : {}),
          delegate: draft.delegate,
        };
      }),
    );

  return (
    <section className="rounded-lg border border-border bg-panel">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="text-sm font-medium">
          {t(`project.stages.${round.stage}`)} ·{" "}
          {round.review ? t("project.reviewRound") : t("project.round", { n: round.roundNo })}
        </div>
        <Button size="sm" variant="ghost" onClick={fillRecommended} disabled={busy}>
          <Sparkles />
          {t("project.fillRecommended")}
        </Button>
      </header>
      {round.review ? <p className="px-5 pt-4 text-sm text-muted">{t("project.reviewHint")}</p> : null}
      <div className="flex flex-col divide-y divide-border">
        {round.questions.map((question, index) => (
          <QuestionCard
            key={question.id}
            index={index + 1}
            question={question}
            draft={drafts[question.id] ?? EMPTY}
            disabled={busy}
            onChange={(change) => update(question, change)}
          />
        ))}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
        <span className="text-xs text-muted">
          {unanswered > 0 ? t("project.unanswered", { count: unanswered }) : ""}
        </span>
        <div className="flex gap-2">
          {round.review ? null : (
            <Button onClick={onAdoptAll} disabled={busy}>
              {t("project.adoptAll")}
            </Button>
          )}
          <Button variant="primary" onClick={submit} disabled={busy || unanswered > 0}>
            {t("project.submit")}
          </Button>
        </div>
      </footer>
    </section>
  );
}

interface QuestionCardProps {
  index: number;
  question: Question;
  draft: Draft;
  disabled: boolean;
  onChange: (change: Partial<Draft>) => void;
}

function QuestionCard({ index, question, draft, disabled, onChange }: QuestionCardProps) {
  const { t } = useTranslation();
  const name = `q-${question.id}`;
  const locked = disabled || draft.delegate;

  const toggle = (optionId: string) => {
    if (question.type === "single") {
      onChange({ optionIds: [optionId], text: "" });
      return;
    }
    const selected = draft.optionIds.includes(optionId)
      ? draft.optionIds.filter((id) => id !== optionId)
      : [...draft.optionIds, optionId];
    onChange({ optionIds: selected });
  };

  return (
    <fieldset className="px-5 py-4" disabled={disabled}>
      <legend className="sr-only">{question.prompt}</legend>
      <div className="mb-3 flex gap-2 text-sm font-medium">
        <span className="text-muted">{index}.</span>
        <span>{question.prompt}</span>
      </div>
      {question.currentValue ? (
        <p className="mb-2 text-xs text-muted">{t("project.current", { value: question.currentValue.text })}</p>
      ) : null}

      {question.type === "text" ? (
        <Textarea
          aria-label={question.prompt}
          rows={3}
          value={draft.text}
          disabled={locked}
          onChange={(event) => onChange({ text: event.target.value })}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {question.options.map((option) => {
            const checked = draft.optionIds.includes(option.id);
            return (
              <label
                key={option.id}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors",
                  checked ? "border-accent bg-accent/5" : "border-border hover:bg-sunken",
                  locked && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type={question.type === "single" ? "radio" : "checkbox"}
                  name={name}
                  className="mt-1"
                  checked={checked}
                  disabled={locked}
                  onChange={() => toggle(option.id)}
                />
                <span className="flex flex-col">
                  <span className="flex items-center gap-2 text-sm">
                    {option.label}
                    {option.recommended ? (
                      <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent">
                        {t("project.recommended")}
                      </span>
                    ) : null}
                  </span>
                  {option.description ? <span className="text-xs text-muted">{option.description}</span> : null}
                </span>
              </label>
            );
          })}
          {question.allowCustom ? (
            <Input
              aria-label={`${question.prompt} · ${t("project.other")}`}
              placeholder={t("project.otherPlaceholder")}
              value={draft.text}
              disabled={locked}
              onChange={(event) =>
                onChange(
                  question.type === "single"
                    ? { text: event.target.value, optionIds: event.target.value ? [] : draft.optionIds }
                    : { text: event.target.value },
                )
              }
            />
          ) : null}
        </div>
      )}

      <label className="mt-3 flex w-fit items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={draft.delegate}
          onChange={(event) => onChange({ delegate: event.target.checked })}
        />
        {t("project.delegate")}
      </label>
    </fieldset>
  );
}

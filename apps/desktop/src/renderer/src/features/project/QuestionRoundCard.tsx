import type { Answer, Question, QuestionRound, Research } from "@km0/shared";
import { Link } from "@tanstack/react-router";
import { SearchCheck, SearchX, Sparkles } from "lucide-react";
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
  onSkipRest: () => void;
}

export function QuestionRoundCard({ round, busy, onSubmit, onSkipRest }: Props) {
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
          // Open-text questions have no recommendation; let the AI fill them.
          return [question.id, { optionIds: recommended, text: "", delegate: question.type === "text" }];
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
      {round.research ? <ResearchNote research={round.research} /> : null}
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
      <footer className="flex flex-col gap-2 border-t border-border px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted">
            {unanswered > 0 ? t("project.unanswered", { count: unanswered }) : ""}
          </span>
          <div className="flex gap-2">
            {round.review ? null : (
              <Button onClick={onSkipRest} disabled={busy}>
                {t("project.skipRest")}
              </Button>
            )}
            <Button variant="primary" onClick={submit} disabled={busy || unanswered > 0}>
              {t("project.submit")}
            </Button>
          </div>
        </div>
        {round.review ? null : <p className="text-right text-xs text-muted">{t("project.skipRestHint")}</p>}
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

      {question.type === "text" ? (
        <label className="mt-3 flex w-fit items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={draft.delegate}
            onChange={(event) => onChange({ delegate: event.target.checked })}
          />
          {t("project.delegate")}
        </label>
      ) : null}
    </fieldset>
  );
}

/** What the technology questions are based on: search results, or a note that nothing was checked. */
export function ResearchNote({ research }: { research: Research }) {
  const { t } = useTranslation();
  if (research.status !== "verified") {
    return (
      <div className="mx-5 mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-sunken px-3 py-2 text-xs text-muted">
        <SearchX className="size-4 shrink-0" />
        <span>{t(`project.research.${research.status}`)}</span>
        {research.status === "unverified" ? (
          <Link to="/settings" className="underline">
            {t("project.research.configure")}
          </Link>
        ) : null}
      </div>
    );
  }
  const count = research.findings.reduce((sum, finding) => sum + finding.results.length, 0);
  return (
    <details className="mx-5 mt-4 rounded-md bg-sunken px-3 py-2 text-xs">
      <summary className="flex cursor-pointer items-center gap-2 text-muted">
        <SearchCheck className="size-4 shrink-0 text-success" />
        <span>{t("project.research.verified", { service: research.service ?? "" })}</span>
        <span>· {t("project.research.sources", { count })}</span>
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        {research.findings.map((finding) => (
          <div key={finding.query}>
            <div className="font-medium">{t("project.research.query", { query: finding.query })}</div>
            {finding.error ? (
              <p className="text-danger">{t("project.research.error", { message: finding.error })}</p>
            ) : finding.results.length === 0 ? (
              <p className="text-muted">{t("project.research.noResults")}</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {finding.results.map((result) => (
                  <li key={result.url || result.title}>
                    {result.url ? (
                      <a href={result.url} target="_blank" rel="noreferrer" className="text-accent underline">
                        {result.title}
                      </a>
                    ) : (
                      <span>{result.title}</span>
                    )}
                    {result.snippet ? <span className="text-muted"> · {result.snippet}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

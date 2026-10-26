import {
  type CostRange,
  DOCUMENT_TEMPLATES,
  ESCALATE_AFTER,
  LEVEL_SETTINGS,
  type RoutedTask,
  type RouteOption,
  type RoutingPlan,
  STRATEGY_LEVELS,
  type StrategyLevel,
  type TaskOverride,
  TIERS,
} from "@km0/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Scissors,
  X,
} from "lucide-react";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, TierBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { call, errorMessage } from "@/lib/ipc";
import { HandoffPanel } from "../handoff/HandoffPanel";
import { decisionLabel } from "../project/labels";
import { projectKey } from "../project/useProject";
import { RunnerPanel } from "../runner/RunnerPanel";

export const routingKey = (projectId: number) => ["routing.get", projectId] as const;

const usd = (value: number) => (value < 0.01 ? "<$0.01" : `$${value.toFixed(value < 1 ? 3 : 2)}`);

export function formatCost(range: CostRange | null): string {
  if (!range) return "—";
  return `${usd(range.low)}–${usd(range.high)}`;
}

const formatUsd = (value: number | null) => (value === null ? "—" : value === 0 ? "$0" : usd(value));
const percent = (value: number) => `${Math.round(value * 100)}%`;

interface Props {
  projectId: number;
  /** Documents are still missing, so the work cannot be broken down yet. */
  blockedReason: string | null;
  /** Open questions the documents still list; the tasks follow their assumptions. */
  openQuestions?: number;
}

/** Tasks with the agent and model the strategy picked, their chances and cost; every choice can be overridden. */
export function RoutingPanel({ projectId, blockedReason, openQuestions = 0 }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const plan = useQuery({ queryKey: routingKey(projectId), queryFn: () => call("routing.get", { projectId }) });
  const [confirmReplan, setConfirmReplan] = useState(false);
  const onPlan = (next: RoutingPlan | null) => {
    queryClient.setQueryData(routingKey(projectId), next);
    void queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: ["project.list"] });
    // Recorded runs change what the models page shows.
    void queryClient.invalidateQueries({ queryKey: ["settings.models.list"] });
  };
  const replan = useMutation({ mutationFn: () => call("routing.plan", { projectId }), onSuccess: onPlan });
  const strategy = useMutation({
    mutationFn: (input: { level: StrategyLevel; budget: number | null }) =>
      call("routing.strategy", { projectId, ...input }),
    onSuccess: onPlan,
  });
  const override = useMutation({
    mutationFn: (input: { taskId: number; override: TaskOverride | null }) =>
      call("task.override", { projectId, ...input }),
    onSuccess: onPlan,
  });
  const record = useMutation({
    mutationFn: (input: { taskId: number; passed: boolean }) => call("task.record", { projectId, ...input }),
    onSuccess: onPlan,
  });
  const clearFailures = useMutation({
    mutationFn: (taskId: number) => call("task.clearFailures", { projectId, taskId }),
    onSuccess: onPlan,
  });
  const error = replan.error ?? strategy.error ?? override.error ?? record.error ?? clearFailures.error;

  if (plan.isLoading) return null;
  const data = plan.data;

  if (!data) {
    return (
      <div className="flex flex-col gap-3">
        {error ? <ErrorBox message={errorMessage(error)} /> : null}
        <div className="rounded-lg border border-border bg-panel p-5">
          <h2 className="font-medium">{t("routing.empty.title")}</h2>
          <p className="mt-1 text-sm text-muted">{blockedReason ?? t("routing.empty.body")}</p>
          {blockedReason === null && openQuestions > 0 ? (
            <p className="mt-2 flex items-center gap-2 text-sm text-warning">
              <AlertTriangle className="size-4 shrink-0" />
              {t("routing.openQuestions", { count: openQuestions })}
            </p>
          ) : null}
          <Button
            className="mt-4"
            variant="primary"
            disabled={replan.isPending || blockedReason !== null}
            onClick={() => replan.mutate()}
          >
            {replan.isPending ? <Loader2 className="animate-spin" /> : null}
            {replan.isPending ? t("routing.planning") : t("routing.empty.action")}
          </Button>
        </div>
      </div>
    );
  }

  const overridden = data.tasks.some((task) => task.override);
  return (
    <div className="flex flex-col gap-3">
      {error ? <ErrorBox message={errorMessage(error)} /> : null}
      {data.outdated ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" />
            {t("routing.outdated")}
          </span>
        </div>
      ) : null}

      <Summary
        plan={data}
        busy={strategy.isPending}
        onStrategy={(level, budget) => strategy.mutate({ level, budget })}
      />

      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          disabled={replan.isPending}
          onClick={() => (overridden ? setConfirmReplan(true) : replan.mutate())}
        >
          {replan.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {replan.isPending ? t("routing.planning") : t("routing.replan")}
        </Button>
      </div>

      <TaskTable
        plan={data}
        busy={override.isPending || record.isPending || clearFailures.isPending}
        onOverride={(taskId, value) => override.mutate({ taskId, override: value })}
        onRecord={(taskId, passed) => record.mutate({ taskId, passed })}
        onClearFailures={(taskId) => clearFailures.mutate(taskId)}
      />

      <HandoffPanel projectId={projectId} plan={data} />

      <RunnerPanel projectId={projectId} />

      <Dialog
        open={confirmReplan}
        onOpenChange={setConfirmReplan}
        title={t("routing.replanTitle")}
        description={t("routing.replanBody")}
        footer={
          <>
            <Button onClick={() => setConfirmReplan(false)}>{t("routing.cancel")}</Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmReplan(false);
                replan.mutate();
              }}
            >
              {t("routing.replan")}
            </Button>
          </>
        }
      />
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
      {t("routing.error", { message })}
    </div>
  );
}

/** A level as a choice, and what it asks of the first run. */
function useLevelText() {
  const { t } = useTranslation();
  return {
    label: (level: StrategyLevel) => t("routing.level.option", { level, name: t(`routing.level.names.${level}`) }),
    rule: (level: StrategyLevel) => {
      const { target, quantile } = LEVEL_SETTINGS[level];
      return t("routing.level.rule", {
        target: percent(target),
        basis:
          quantile >= 0.5 ? t("routing.level.onMean") : t("routing.level.onQuantile", { value: percent(quantile) }),
      });
    },
  };
}

function Summary({
  plan,
  busy,
  onStrategy,
}: {
  plan: RoutingPlan;
  busy: boolean;
  onStrategy: (level: StrategyLevel, budget: number | null) => void;
}) {
  const { t } = useTranslation();
  const level = useLevelText();
  const { totals, tierCounts, budgetAdvice } = plan;
  const [budget, setBudget] = useState(plan.budget === null ? "" : String(plan.budget));
  const parsed = budget.trim() === "" ? null : Number(budget);
  const budgetValid = parsed === null || (Number.isFinite(parsed) && parsed > 0);
  const seq = (taskId: number) => plan.tasks.find((task) => task.id === taskId)?.seq ?? taskId;

  return (
    <section aria-label={t("routing.summary")} className="rounded-lg border border-border bg-panel p-4 text-sm">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="strategy-level" className="text-xs font-medium text-muted">
            {t("routing.level.label")}
          </label>
          <Select
            id="strategy-level"
            className="h-8 w-40"
            value={plan.level}
            disabled={busy}
            onChange={(event) => onStrategy(Number(event.target.value) as StrategyLevel, plan.budget)}
          >
            {STRATEGY_LEVELS.map((value) => (
              <option key={value} value={value}>
                {level.label(value)}
              </option>
            ))}
          </Select>
        </div>
        <p className="pb-1.5 text-xs">{level.rule(plan.level)}</p>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (budgetValid) onStrategy(plan.level, parsed);
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="strategy-budget" className="text-xs font-medium text-muted">
              {t("routing.budget.label")}
            </label>
            <Input
              id="strategy-budget"
              className="h-8 w-28"
              inputMode="decimal"
              placeholder={t("routing.budget.none")}
              aria-invalid={!budgetValid}
              value={budget}
              disabled={busy}
              onChange={(event) => setBudget(event.target.value)}
            />
          </div>
          <Button size="sm" type="submit" disabled={busy || !budgetValid || parsed === plan.budget}>
            {t("routing.budget.apply")}
          </Button>
        </form>
      </div>
      <p className="mt-2 text-xs text-muted">{t("routing.level.hint")}</p>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border pt-3">
        <span>{t("routing.taskCount", { count: plan.tasks.length })}</span>
        <span className="flex items-center gap-2">
          {TIERS.map((tier) => (
            <span key={tier} className="flex items-center gap-1">
              <TierBadge tier={tier} /> {tierCounts[tier]}
            </span>
          ))}
        </span>
        {totals.expectedCost !== null ? (
          <span>{t("routing.expected", { value: formatUsd(totals.expectedCost) })}</span>
        ) : null}
        {totals.cost ? (
          <span className="text-muted">
            {t("routing.cost", { value: formatCost(totals.cost) })}
            {" · "}
            {t("routing.costStrongest", { value: formatCost(totals.costStrongest) })}
            {totals.saving !== null ? (
              <span className="ml-2 font-medium text-success">
                {t("routing.saving", { value: Math.round(totals.saving * 100) })}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      {totals.belowTarget > 0 ? (
        <p className="mt-2 flex items-center gap-2 text-xs text-warning">
          <AlertTriangle className="size-3.5 shrink-0" />
          {t("routing.belowTarget", { count: totals.belowTarget })}
        </p>
      ) : null}
      {budgetAdvice ? (
        <div role="status" className="mt-2 rounded-md border border-warning/40 bg-warning/5 p-2.5 text-xs">
          <p className="font-medium">
            {t("routing.budget.over", { value: formatUsd(budgetAdvice.over), budget: formatUsd(plan.budget) })}
          </p>
          {budgetAdvice.moves.length > 0 ? (
            <ul className="mt-1 list-disc pl-5">
              {budgetAdvice.moves.map((move) => (
                <li key={move.taskId}>
                  {t("routing.budget.move", {
                    seq: seq(move.taskId),
                    level: t(`routing.level.names.${move.level}`),
                    saving: formatUsd(move.saving),
                  })}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-muted">{t(budgetAdvice.fits ? "routing.budget.fits" : "routing.budget.noFit")}</p>
        </div>
      ) : null}
      {totals.unpriced > 0 ? (
        <p className="mt-2 text-xs text-muted">
          {t("routing.unpriced", { count: totals.unpriced })}{" "}
          <Link to="/settings" className="text-accent underline">
            {t("routing.setPrices")}
          </Link>
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted">{t("routing.estimateNote")}</p>
    </section>
  );
}

interface TaskActions {
  onOverride: (taskId: number, override: TaskOverride | null) => void;
  onRecord: (taskId: number, passed: boolean) => void;
  onClearFailures: (taskId: number) => void;
}

function TaskTable({ plan, busy, ...actions }: { plan: RoutingPlan; busy: boolean } & TaskActions) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-panel">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted">
          <tr>
            <th className="w-8 px-3 py-2">#</th>
            <th className="px-3 py-2">{t("routing.columns.task")}</th>
            <th className="px-3 py-2 whitespace-nowrap">{t("routing.columns.difficulty")}</th>
            <th className="px-3 py-2 whitespace-nowrap">{t("routing.columns.combination")}</th>
            <th className="px-3 py-2 text-right whitespace-nowrap">{t("routing.columns.pass")}</th>
            <th className="px-3 py-2 text-right whitespace-nowrap">{t("routing.columns.cost")}</th>
          </tr>
        </thead>
        <tbody>
          {plan.tasks.map((task) => (
            <Fragment key={task.id}>
              <tr className="border-b border-border last:border-0 hover:bg-sunken/60">
                <td className="px-3 py-2 align-top text-muted">{task.seq}</td>
                <td className="px-3 py-2 align-top">
                  <button
                    type="button"
                    className="flex items-start gap-1 text-left font-medium"
                    aria-expanded={open === task.id}
                    onClick={() => setOpen(open === task.id ? null : task.id)}
                  >
                    {open === task.id ? (
                      <ChevronDown className="mt-0.5 size-4 shrink-0" />
                    ) : (
                      <ChevronRight className="mt-0.5 size-4 shrink-0" />
                    )}
                    {task.title}
                  </button>
                  <div className="mt-1 ml-5 flex flex-wrap gap-1.5">
                    {task.dependsOn.length > 0 ? (
                      <span className="text-[11px] text-muted">
                        {t("routing.after", { value: task.dependsOn.join(", ") })}
                      </span>
                    ) : null}
                    {task.splitSuggested ? (
                      <Badge tone="warning">
                        <Scissors className="size-3" />
                        {t("routing.split")}
                      </Badge>
                    ) : null}
                    {task.levelSource !== "project" ? (
                      <Badge>
                        {t(`routing.levelSource.${task.levelSource}`, { name: t(`routing.level.names.${task.level}`) })}
                      </Badge>
                    ) : null}
                    {task.override ? <Badge>{t("routing.overridden")}</Badge> : null}
                    {task.failures.length > 0 ? (
                      <Badge tone="danger">{t("routing.failures", { count: task.failures.length })}</Badge>
                    ) : null}
                    {task.needsHuman ? (
                      <Badge tone="danger">
                        <AlertTriangle className="size-3" />
                        {t("routing.needsHuman")}
                      </Badge>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-2 align-top text-xs whitespace-nowrap">{t(`routing.bands.${task.band}`)}</td>
                <td className="px-3 py-2 align-top whitespace-nowrap">
                  {task.choice ? (
                    <>
                      <div className="flex items-center gap-1.5">
                        {task.choice.agentName}
                        {task.choice.native ? <Badge tone="success">{t("settings.agents.native")}</Badge> : null}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                        {task.choice.modelName}
                        <TierBadge tier={task.choice.tier} />
                        {task.escalatedFrom ? (
                          <span className="flex items-center gap-0.5 whitespace-nowrap">
                            <ArrowUp className="size-3" />
                            {t("routing.escalated", { from: task.escalatedFrom })}
                          </span>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <>
                      <div>{task.agent}</div>
                      <div className="text-xs text-warning">{t("routing.noModel")}</div>
                    </>
                  )}
                </td>
                <td className="px-3 py-2 text-right align-top whitespace-nowrap">
                  {task.choice ? (
                    <>
                      <div className={cn(task.meetsTarget ? "" : "text-warning")}>{percent(task.choice.pass.mean)}</div>
                      <div className="text-[11px] text-muted">
                        {percent(task.choice.pass.low)}–{percent(task.choice.pass.high)}
                      </div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2 text-right align-top whitespace-nowrap">
                  <div>{formatUsd(task.expectedCost)}</div>
                  <div className="text-[11px] text-muted">{t("routing.perRun", { value: formatCost(task.cost) })}</div>
                </td>
              </tr>
              {open === task.id ? (
                <tr className="border-b border-border bg-sunken/40 last:border-0">
                  <td />
                  <td colSpan={5} className="px-3 pt-1 pb-4">
                    <TaskDetail
                      task={task}
                      busy={busy}
                      onOverride={(value) => actions.onOverride(task.id, value)}
                      onRecord={(passed) => actions.onRecord(task.id, passed)}
                      onClearFailures={() => actions.onClearFailures(task.id)}
                    />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const optionKey = (option: Pick<RouteOption, "agent" | "modelRef">) => `${option.agent}|${option.modelRef}`;

function TaskDetail({
  task,
  busy,
  onOverride,
  onRecord,
  onClearFailures,
}: {
  task: RoutedTask;
  busy: boolean;
  onOverride: (override: TaskOverride | null) => void;
  onRecord: (passed: boolean) => void;
  onClearFailures: () => void;
}) {
  const { t, i18n } = useTranslation();
  const level = useLevelText();
  const language = i18n.language === "en" ? "en" : "zh-CN";
  const sectionTitle = (kind: keyof typeof DOCUMENT_TEMPLATES, id: string) =>
    DOCUMENT_TEMPLATES[kind].sections.find((section) => section.id === id)?.title[language] ?? id;
  const forced =
    task.override?.agent && task.override.modelRef !== undefined
      ? optionKey({ agent: task.override.agent, modelRef: task.override.modelRef })
      : "";
  // A combination is chosen as a pair; KM0 0.1's tier and typed model give way to it.
  const setCombination = (key: string) => {
    const { level } = task.override ?? {};
    const option = task.options.find((item) => optionKey(item) === key);
    const next: TaskOverride = { ...(level ? { level } : {}) };
    if (option) Object.assign(next, { agent: option.agent, modelRef: option.modelRef });
    onOverride(Object.keys(next).length > 0 ? next : null);
  };
  const setLevel = (value: string) => {
    const next: TaskOverride = { ...task.override };
    if (value) next.level = Number(value) as StrategyLevel;
    else delete next.level;
    onOverride(Object.keys(next).length > 0 ? next : null);
  };
  const failureCount = task.choice
    ? task.failures.filter((failure) => failure.modelRef === task.choice?.modelRef).length
    : 0;
  const [colon, comma] = language === "en" ? [": ", ", "] : ["：", "，"];

  return (
    <div className="grid gap-4 text-sm lg:grid-cols-2">
      <div className="flex flex-col gap-3">
        <p>{task.goal}</p>
        {task.acceptance.length > 0 ? (
          <Block title={t("routing.detail.acceptance")}>
            <ul className="list-disc pl-5">
              {task.acceptance.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Block>
        ) : null}
        {task.files.length > 0 ? (
          <Block title={t("routing.detail.files")}>
            <div className="flex flex-wrap gap-1.5">
              {task.files.map((file) => (
                <code key={file} className="rounded bg-sunken px-1.5 py-0.5 text-xs">
                  {file}
                </code>
              ))}
            </div>
          </Block>
        ) : null}
        {task.decisionKeys.length + task.sections.length > 0 ? (
          <Block title={t("routing.detail.basis")}>
            <span className="text-muted">
              {[
                ...task.decisionKeys.map(decisionLabel),
                ...task.sections.map((ref) => sectionTitle(ref.kind, ref.sectionId)),
              ].join("、")}
            </span>
          </Block>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <Block title={t("routing.detail.why")}>
          <ul className="list-disc pl-5 text-muted">
            {task.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
            <li>
              {t("routing.detail.band", {
                band: t(`routing.bands.${task.band}`),
                level: level.label(task.level),
                rule: level.rule(task.level),
              })}
            </li>
            {task.choice ? (
              <li>
                {task.choice.agentName} · {task.choice.modelName}
                {colon}
                {task.agentReason}
              </li>
            ) : (
              <li>{task.agentReason}</li>
            )}
            {task.evidence ? <li>{task.evidence}</li> : null}
            <li>
              {t("routing.detail.tokens", {
                input: `${Math.round(task.tokens.input.low / 1000)}k–${Math.round(task.tokens.input.high / 1000)}k`,
                output: `${Math.round(task.tokens.output.low / 1000)}k–${Math.round(task.tokens.output.high / 1000)}k`,
              })}
            </li>
          </ul>
        </Block>
        {task.passedOver.length > 0 ? (
          <Block title={t("routing.detail.passedOver")}>
            <ul className="list-disc pl-5 text-muted">
              {task.passedOver.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Block>
        ) : null}
        {task.choice ? (
          <Block title={t("routing.detail.chain")}>
            <p className="text-muted">
              {task.chain.length > 0
                ? task.chain
                    .map((step) =>
                      t("routing.detail.step", {
                        model: step.modelName,
                        agent: step.agentName,
                        pass: percent(step.pass.mean),
                      }),
                    )
                    .join(" → ")
                : t("routing.detail.chainEnd")}
            </p>
            {task.costStrongest ? (
              <p className="mt-1 text-xs text-muted">
                {t("routing.detail.strongest", { value: formatCost(task.costStrongest) })}
              </p>
            ) : null}
          </Block>
        ) : null}
        <Block title={t("routing.detail.override")}>
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
            <label htmlFor={`level-${task.id}`} className="text-xs text-muted">
              {t("routing.detail.level")}
            </label>
            <Select
              id={`level-${task.id}`}
              className="h-8"
              disabled={busy}
              value={task.override?.level ?? ""}
              onChange={(event) => setLevel(event.target.value)}
            >
              <option value="">{t("routing.detail.projectLevel")}</option>
              {STRATEGY_LEVELS.map((value) => (
                <option key={value} value={value}>
                  {t("routing.level.optionRule", { label: level.label(value), rule: level.rule(value) })}
                </option>
              ))}
            </Select>
            <label htmlFor={`combo-${task.id}`} className="text-xs text-muted">
              {t("routing.detail.combination")}
            </label>
            <Select
              id={`combo-${task.id}`}
              className="h-8"
              disabled={busy || task.options.length === 0}
              value={forced}
              onChange={(event) => setCombination(event.target.value)}
            >
              <option value="">{t("routing.detail.automatic")}</option>
              {task.options.map((option) => (
                <option key={optionKey(option)} value={optionKey(option)}>
                  {`${option.agentName} · ${option.modelName}${comma}${percent(option.pass.mean)}${comma}${formatUsd(option.expectedCost)}`}
                </option>
              ))}
            </Select>
          </div>
          {task.override ? (
            <Button size="sm" variant="ghost" className="mt-2" disabled={busy} onClick={() => onOverride(null)}>
              {t("routing.detail.reset")}
            </Button>
          ) : null}
        </Block>
        <Block title={t("routing.detail.runs")}>
          <p className="text-xs text-muted">{t("routing.detail.runsHint", { count: ESCALATE_AFTER })}</p>
          {task.failures.length > 0 ? (
            <p className="mt-1 text-xs">
              {t("routing.detail.failureLog", { count: task.failures.length, current: failureCount })}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || !task.choice} onClick={() => onRecord(true)}>
              <Check />
              {t("routing.detail.recordPass")}
            </Button>
            <Button size="sm" disabled={busy || !task.choice} onClick={() => onRecord(false)}>
              <X />
              {t("routing.detail.recordFailure")}
            </Button>
            {task.failures.length > 0 ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={onClearFailures}>
                {t("routing.detail.clearFailures")}
              </Button>
            ) : null}
          </div>
        </Block>
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted">{title}</div>
      {children}
    </div>
  );
}

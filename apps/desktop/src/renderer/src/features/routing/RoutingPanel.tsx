import {
  type AgentId,
  AgentId as AgentIds,
  type CostRange,
  DOCUMENT_TEMPLATES,
  type RoutedTask,
  type RoutingPlan,
  type TaskOverride,
  TIERS,
  type Tier,
} from "@km0/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RefreshCw, Scissors } from "lucide-react";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { call, errorMessage } from "@/lib/ipc";
import { useIpcQuery } from "@/lib/queries";
import { decisionLabel } from "../project/labels";
import { projectKey } from "../project/useProject";
import { agentName } from "../settings/AgentsTab";

export const routingKey = (projectId: number) => ["routing.get", projectId] as const;

export function formatCost(range: CostRange | null): string {
  if (!range) return "—";
  const one = (value: number) => (value < 0.01 ? "<$0.01" : `$${value.toFixed(value < 1 ? 3 : 2)}`);
  return `${one(range.low)}–${one(range.high)}`;
}

const TIER_STYLE: Record<Tier, string> = {
  T1: "bg-success/15 text-success",
  T2: "bg-accent/15 text-accent",
  T3: "bg-warning/15 text-warning",
};

function TierBadge({ tier }: { tier: Tier }) {
  return <span className={cn("rounded px-1.5 py-0.5 text-xs font-semibold", TIER_STYLE[tier])}>{tier}</span>;
}

interface Props {
  projectId: number;
  /** Documents are still missing, so the work cannot be broken down yet. */
  blockedReason: string | null;
}

/** Tasks with their tier, agent, model and estimated cost; every choice can be overridden. */
export function RoutingPanel({ projectId, blockedReason }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const plan = useQuery({ queryKey: routingKey(projectId), queryFn: () => call("routing.get", { projectId }) });
  const [confirmReplan, setConfirmReplan] = useState(false);
  const onPlan = (next: RoutingPlan) => {
    queryClient.setQueryData(routingKey(projectId), next);
    void queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
  };
  const replan = useMutation({ mutationFn: () => call("routing.plan", { projectId }), onSuccess: onPlan });
  const override = useMutation({
    mutationFn: (input: { taskId: number; override: TaskOverride | null }) =>
      call("task.override", { projectId, ...input }),
    onSuccess: onPlan,
  });
  const error = replan.error ?? override.error;

  if (plan.isLoading) return null;
  const data = plan.data;

  if (!data) {
    return (
      <div className="flex flex-col gap-3">
        {error ? <ErrorBox message={errorMessage(error)} /> : null}
        <div className="rounded-lg border border-border bg-panel p-5">
          <h2 className="font-medium">{t("routing.empty.title")}</h2>
          <p className="mt-1 text-sm text-muted">{blockedReason ?? t("routing.empty.body")}</p>
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

      <Summary plan={data} />

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
        busy={override.isPending}
        onOverride={(taskId, value) => override.mutate({ taskId, override: value })}
      />

      <p className="text-sm text-muted">{t("routing.nextStep")}</p>

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

function Summary({ plan }: { plan: RoutingPlan }) {
  const { t } = useTranslation();
  const { totals, tierCounts } = plan;
  return (
    <section aria-label={t("routing.summary")} className="rounded-lg border border-border bg-panel p-4 text-sm">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span>{t("routing.taskCount", { count: plan.tasks.length })}</span>
        <span className="flex items-center gap-2">
          {TIERS.map((tier) => (
            <span key={tier} className="flex items-center gap-1">
              <TierBadge tier={tier} /> {tierCounts[tier]}
            </span>
          ))}
        </span>
        {totals.cost ? (
          <span>
            {t("routing.cost", { value: formatCost(totals.cost) })}
            <span className="text-muted"> · {t("routing.costAllT3", { value: formatCost(totals.costAllT3) })}</span>
            {totals.saving !== null ? (
              <span className="ml-2 font-medium text-success">
                {t("routing.saving", { value: Math.round(totals.saving * 100) })}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
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

function TaskTable({
  plan,
  busy,
  onOverride,
}: {
  plan: RoutingPlan;
  busy: boolean;
  onOverride: (taskId: number, override: TaskOverride | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-panel">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted">
          <tr>
            <th className="w-8 px-3 py-2">#</th>
            <th className="px-3 py-2">{t("routing.columns.task")}</th>
            <th className="px-3 py-2">{t("routing.columns.tier")}</th>
            <th className="px-3 py-2">{t("routing.columns.agent")}</th>
            <th className="px-3 py-2 text-right">{t("routing.columns.cost")}</th>
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
                  <div className="mt-1 ml-5 flex flex-wrap gap-1.5 text-[11px]">
                    {task.dependsOn.length > 0 ? (
                      <span className="text-muted">{t("routing.after", { value: task.dependsOn.join(", ") })}</span>
                    ) : null}
                    {task.splitSuggested ? (
                      <span className="flex items-center gap-1 rounded bg-warning/15 px-1.5 text-warning">
                        <Scissors className="size-3" />
                        {t("routing.split")}
                      </span>
                    ) : null}
                    {task.override ? (
                      <span className="rounded bg-sunken px-1.5 text-muted">{t("routing.overridden")}</span>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-2 align-top">
                  <TierBadge tier={task.tier} />
                </td>
                <td className="px-3 py-2 align-top">
                  <div>{agentName(task.agent, t)}</div>
                  <div className={cn("text-xs", task.model ? "text-muted" : "text-warning")}>
                    {task.model ?? t("routing.noModel")}
                  </div>
                </td>
                <td className="px-3 py-2 text-right align-top whitespace-nowrap">{formatCost(task.cost)}</td>
              </tr>
              {open === task.id ? (
                <tr className="border-b border-border bg-sunken/40 last:border-0">
                  <td />
                  <td colSpan={4} className="px-3 pt-1 pb-4">
                    <TaskDetail task={task} busy={busy} onOverride={(value) => onOverride(task.id, value)} />
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

function TaskDetail({
  task,
  busy,
  onOverride,
}: {
  task: RoutedTask;
  busy: boolean;
  onOverride: (override: TaskOverride | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const agents = useIpcQuery("settings.agents.list");
  const language = i18n.language === "en" ? "en" : "zh-CN";
  const [model, setModel] = useState(task.override?.model ?? "");
  const catalog = agents.data?.find((agent) => agent.id === task.agent);
  const suggestions = TIERS.flatMap((tier) => (catalog?.models[tier] ? [catalog.models[tier].modelId] : []));
  const change = (patch: TaskOverride) => {
    const next = { ...task.override, ...patch };
    for (const key of Object.keys(next) as (keyof TaskOverride)[]) if (next[key] === undefined) delete next[key];
    onOverride(Object.keys(next).length > 0 ? next : null);
  };
  const sectionTitle = (kind: keyof typeof DOCUMENT_TEMPLATES, id: string) =>
    DOCUMENT_TEMPLATES[kind].sections.find((section) => section.id === id)?.title[language] ?? id;

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
              {agentName(task.agent, t)}：{task.agentReason}
            </li>
            <li>
              {t("routing.detail.tokens", {
                input: `${Math.round(task.tokens.input.low / 1000)}k–${Math.round(task.tokens.input.high / 1000)}k`,
                output: `${Math.round(task.tokens.output.low / 1000)}k–${Math.round(task.tokens.output.high / 1000)}k`,
              })}
            </li>
          </ul>
        </Block>
        <Block title={t("routing.detail.override")}>
          <div className="grid grid-cols-[5rem_1fr] items-center gap-2">
            <label htmlFor={`tier-${task.id}`} className="text-xs text-muted">
              {t("routing.columns.tier")}
            </label>
            <Select
              id={`tier-${task.id}`}
              className="h-8"
              disabled={busy}
              value={task.override?.tier ?? ""}
              onChange={(event) => change({ tier: (event.target.value || undefined) as Tier | undefined })}
            >
              <option value="">{t("routing.detail.byRules", { tier: task.ruleTier })}</option>
              {TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </Select>
            <label htmlFor={`agent-${task.id}`} className="text-xs text-muted">
              {t("routing.columns.agent")}
            </label>
            <Select
              id={`agent-${task.id}`}
              className="h-8"
              disabled={busy}
              value={task.override?.agent ?? ""}
              onChange={(event) => change({ agent: (event.target.value || undefined) as AgentId | undefined })}
            >
              <option value="">{t("routing.detail.automatic")}</option>
              {AgentIds.options.map((id) => (
                <option key={id} value={id}>
                  {agentName(id, t)}
                </option>
              ))}
            </Select>
            <label htmlFor={`model-${task.id}`} className="text-xs text-muted">
              {t("routing.detail.model")}
            </label>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                change({ model: model.trim() || undefined });
              }}
            >
              <Input
                id={`model-${task.id}`}
                className="h-8"
                list={`models-${task.id}`}
                placeholder={task.model ?? ""}
                value={model}
                disabled={busy}
                onChange={(event) => setModel(event.target.value)}
              />
              <datalist id={`models-${task.id}`}>
                {suggestions.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <Button size="sm" type="submit" disabled={busy}>
                {t("routing.detail.apply")}
              </Button>
            </form>
          </div>
          {task.override ? (
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              disabled={busy}
              onClick={() => {
                setModel("");
                onOverride(null);
              }}
            >
              {t("routing.detail.reset")}
            </Button>
          ) : null}
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

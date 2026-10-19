import type { RunnerRun, RunnerTaskResult } from "@km0/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, FolderOpen, Loader2, RotateCcw, Save, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call, errorMessage } from "@/lib/ipc";
import { routingKey } from "../routing/RoutingPanel";

export const runnerKey = (projectId: number) => ["runner.list", projectId] as const;

function Verdict({ result }: { result: RunnerTaskResult }) {
  const { t } = useTranslation();
  if (result.accepted === null) {
    return <span className="text-xs text-muted">{t("runner.unjudged")}</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium",
        result.accepted ? "bg-success/10 text-success" : "bg-danger/10 text-danger",
      )}
    >
      {result.accepted ? <Check className="size-3" /> : <X className="size-3" />}
      {result.accepted ? t("runner.accepted") : t("runner.rejected")}
      {result.verdict?.user_override !== null && result.verdict?.user_override !== undefined
        ? ` · ${t("runner.byYou")}`
        : ""}
    </span>
  );
}

function ResultRow({
  result,
  busy,
  onOverride,
}: {
  result: RunnerTaskResult;
  busy: boolean;
  onOverride: (accepted: boolean | null) => void;
}) {
  const { t } = useTranslation();
  const { report } = result;
  const test = report.test_result?.passed;
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {String(result.seq).padStart(2, "0")} · {result.title}
        </span>
        <Verdict result={result} />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        <span>
          {t("runner.tiers", {
            start: report.start_tier ?? "—",
            end: result.tier ?? "—",
          })}
          {report.explored ? ` · ${t("runner.explored")}` : ""}
        </span>
        <span>
          {test === true ? t("runner.testsPassed") : test === false ? t("runner.testsFailed") : t("runner.noTests")}
        </span>
        <span>${report.cost.toFixed(4)}</span>
        <span>
          {t("runner.diff", {
            files: result.diffStat.files,
            added: result.diffStat.added,
            removed: result.diffStat.removed,
          })}
        </span>
        {report.branch ? <code className="font-mono">{report.branch}</code> : null}
        {report.failure_category ? (
          <span className="text-warning">{t("runner.failure", { category: report.failure_category })}</span>
        ) : null}
      </div>
      {result.verdict ? <p className="text-xs text-muted">{result.verdict.reason}</p> : null}
      {result.verdict ? (
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || result.accepted === true}
            onClick={() => onOverride(true)}
          >
            <Check />
            {t("runner.accept")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || result.accepted === false}
            onClick={() => onOverride(false)}
          >
            <X />
            {t("runner.reject")}
          </Button>
          {result.verdict.user_override !== null ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onOverride(null)}>
              <RotateCcw />
              {t("runner.undoOverride")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function RunCard({ run, projectId }: { run: RunnerRun; projectId: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const refresh = (next: RunnerRun) => {
    queryClient.setQueryData<RunnerRun[]>(runnerKey(projectId), (runs) =>
      runs?.map((item) => (item.id === next.id ? next : item)),
    );
    // Rejections lift tasks in the routing table.
    void queryClient.invalidateQueries({ queryKey: routingKey(projectId) });
  };
  const judge = useMutation({
    mutationFn: () => call("runner.judge", { projectId, runRef: run.id }),
    onSuccess: refresh,
  });
  const override = useMutation({
    mutationFn: ({ resultId, accepted }: { resultId: number; accepted: boolean | null }) =>
      call("runner.override", { projectId, resultId, accepted }),
    onSuccess: refresh,
  });
  const writeBack = useMutation({
    mutationFn: () => call("runner.writeBack", { projectId, runRef: run.id }),
    onSuccess: refresh,
  });
  const unjudged = run.results.filter(
    (result) => result.verdict === null && result.report.failure_category !== "blocked",
  ).length;
  const error = judge.error ?? override.error ?? writeBack.error;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3">
        <div className="text-sm">
          <span className="font-medium font-mono">{run.runId}</span>
          <span className="ml-2 text-xs text-muted">
            {t("runner.summary", {
              count: run.results.length,
              accepted: run.results.filter((result) => result.accepted === true).length,
              cost: `$${run.cost.toFixed(4)}`,
            })}
          </span>
        </div>
        <Button
          size="sm"
          variant={unjudged > 0 ? "primary" : "secondary"}
          disabled={judge.isPending || unjudged === 0}
          onClick={() => judge.mutate()}
        >
          {judge.isPending ? <Loader2 className="animate-spin" /> : <Bot />}
          {judge.isPending ? t("runner.judging") : t("runner.judge", { count: unjudged })}
        </Button>
      </div>
      {run.writeBackPending ? (
        <div className="mx-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/5 p-2 text-xs">
          {t("runner.writeBackPending")}
          <Button size="sm" variant="secondary" disabled={writeBack.isPending} onClick={() => writeBack.mutate()}>
            <Save />
            {t("runner.writeBack")}
          </Button>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="mx-3 rounded-lg border border-danger/40 bg-danger/5 p-2 text-sm">
          {errorMessage(error)}
        </div>
      ) : null}
      <ul className="flex flex-col divide-y divide-border border-t border-border">
        {run.results.map((result) => (
          <ResultRow
            key={result.id}
            result={result}
            busy={override.isPending || judge.isPending}
            onOverride={(accepted) => override.mutate({ resultId: result.id, accepted })}
          />
        ))}
      </ul>
    </div>
  );
}

/** Imports KM0 Runner runs, judges each change against its acceptance criteria and shows the verdicts. */
export function RunnerPanel({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const runs = useQuery({ queryKey: runnerKey(projectId), queryFn: () => call("runner.list", { projectId }) });
  const importRun = useMutation({
    mutationFn: () => call("runner.import", { projectId }),
    onSuccess: (run) => {
      if (run) void queryClient.invalidateQueries({ queryKey: runnerKey(projectId) });
    },
  });

  return (
    <section
      aria-label={t("runner.title")}
      className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-medium">
            <Bot className="size-5" />
            {t("runner.title")}
          </h2>
          <p className="mt-1 text-sm text-muted">{t("runner.body")}</p>
        </div>
        <Button variant="secondary" disabled={importRun.isPending} onClick={() => importRun.mutate()}>
          {importRun.isPending ? <Loader2 className="animate-spin" /> : <FolderOpen />}
          {t("runner.import")}
        </Button>
      </div>
      {importRun.error ? (
        <div role="alert" className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
          {errorMessage(importRun.error)}
        </div>
      ) : null}
      {runs.data?.length === 0 ? <p className="text-sm text-muted">{t("runner.empty")}</p> : null}
      {runs.data?.map((run) => (
        <RunCard key={run.id} run={run} projectId={projectId} />
      ))}
    </section>
  );
}

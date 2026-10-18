import type { ProjectDetail, ProjectPath } from "@km0/shared";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, FolderGit2, Loader2, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { errorMessage } from "@/lib/ipc";
import { DocumentsPanel } from "../documents/DocumentsPanel";
import { useDocumentActions, useDocumentStreams } from "../documents/useDocuments";
import { RoutingPanel } from "../routing/RoutingPanel";
import { DecisionLedger } from "./DecisionLedger";
import { QuestionRoundCard } from "./QuestionRoundCard";
import { StageStepper } from "./StageStepper";
import { useProject, useProjectAction } from "./useProject";

export function ProjectPage({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const project = useProject(projectId);
  const answer = useProjectAction("round.answer", projectId);
  const advance = useProjectAction("stage.advance", projectId);
  const more = useProjectAction("stage.more", projectId);
  const review = useProjectAction("stage.review", projectId);
  const setPath = useProjectAction("project.setPath", projectId);
  const retry = useProjectAction("project.retry", projectId);
  const edit = useProjectAction("decision.update", projectId);
  const documents = useDocumentActions(projectId);
  const streams = useDocumentStreams(projectId);

  const actions = [answer, advance, more, review, setPath, retry, edit];
  const busy = actions.some((action) => action.isPending);
  const actionError = actions.find((action) => action.error)?.error;

  if (project.isLoading) return null;
  if (project.error || !project.data) {
    return <p className="p-8 text-danger">{errorMessage(project.error)}</p>;
  }
  const detail = project.data;
  const current = detail.stages.find((stage) => stage.status === "active" || stage.status === "ready");
  const isLast = current ? detail.stages.indexOf(current) === detail.stages.length - 1 : false;
  const writesDocuments = detail.documents.length > 0;
  // Finishing the discussion starts writing every document of the path at once.
  const startDocuments = (next: ProjectDetail) => {
    if (!next.discussionComplete) return;
    for (const item of next.documents) {
      if (item.version === null) void documents.generate(item.kind);
    }
  };
  const failure = detail.error ?? (actionError ? { kind: "internal", message: errorMessage(actionError) } : null);

  return (
    <div className="flex min-h-full">
      <div className="min-w-0 flex-1 px-8 py-8">
        <Header detail={detail} busy={busy} onPath={(path) => setPath.mutate({ id: projectId, path })} />

        <div className="mt-6 flex flex-col gap-4">
          {failure ? (
            <div role="alert" className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm">
              <div className="font-medium text-danger">{t("project.error.title")}</div>
              <p className="mt-1">{failure.message}</p>
              <div className="mt-3 flex gap-2">
                {detail.error ? (
                  <Button size="sm" onClick={() => retry.mutate({ id: projectId })} disabled={busy}>
                    <RotateCcw />
                    {t("project.error.retry")}
                  </Button>
                ) : null}
                {failure.kind === "config" ? (
                  <Button size="sm" asChild>
                    <Link to="/settings">{t("project.error.settings")}</Link>
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {busy ? (
            <p className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
              <Loader2 className="size-4 animate-spin" />
              {t("project.thinking")}
            </p>
          ) : null}

          {detail.openRound ? (
            <QuestionRoundCard
              key={detail.openRound.id}
              round={detail.openRound}
              busy={busy}
              onSubmit={(answers) => answer.mutate({ projectId, roundId: detail.openRound?.id ?? 0, answers })}
              onSkipRest={() => advance.mutate({ projectId, adoptRecommended: true }, { onSuccess: startDocuments })}
            />
          ) : current?.status === "ready" ? (
            <section className="rounded-lg border border-border bg-panel p-5">
              <h2 className="font-medium">{t("project.ready.title")}</h2>
              <p className="mt-1 text-sm text-muted">{t("project.ready.body")}</p>
              <div className="mt-4 flex gap-2">
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => advance.mutate({ projectId, adoptRecommended: false }, { onSuccess: startDocuments })}
                >
                  {isLast
                    ? writesDocuments
                      ? t("project.ready.finishWithDocuments")
                      : t("project.ready.finish")
                    : t("project.ready.next")}
                </Button>
                <Button
                  disabled={busy || current.roundsUsed >= current.maxRounds}
                  title={current.roundsUsed >= current.maxRounds ? t("project.ready.noMoreRounds") : undefined}
                  onClick={() => more.mutate({ projectId })}
                >
                  {t("project.ready.more")}
                </Button>
              </div>
            </section>
          ) : detail.discussionComplete && writesDocuments ? (
            <DocumentsPanel projectId={projectId} summaries={detail.documents} actions={documents} streams={streams} />
          ) : detail.discussionComplete ? (
            <>
              <section className="rounded-lg border border-border bg-panel p-5">
                <h2 className="flex items-center gap-2 font-medium">
                  <CheckCircle2 className="size-5 text-success" />
                  {t("project.done.title")}
                </h2>
                <p className="mt-1 text-sm text-muted">{t("project.done.body")}</p>
              </section>
              <RoutingPanel projectId={projectId} blockedReason={null} />
            </>
          ) : null}
        </div>
      </div>

      <div className="w-80 shrink-0 border-l border-border bg-bg px-5 py-8">
        <DecisionLedger
          stages={detail.stages}
          decisions={detail.decisions}
          busy={busy}
          onEdit={(key, text) => edit.mutate({ projectId, key, value: { text } })}
          onReview={(stage) => review.mutate({ projectId, stage })}
        />
      </div>
    </div>
  );
}

function Header({
  detail,
  busy,
  onPath,
}: {
  detail: ProjectDetail;
  busy: boolean;
  onPath: (path: ProjectPath) => void;
}) {
  const { t } = useTranslation();
  const triage = detail.triage;
  return (
    <header className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{detail.title}</h1>
          <p className="mt-1 text-sm text-muted">{detail.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted">
          <label htmlFor="project-path">{t("project.changePath")}</label>
          <Select
            id="project-path"
            className="h-8 w-36"
            value={detail.path ?? "full"}
            disabled={busy}
            onChange={(event) => onPath(event.target.value as ProjectPath)}
          >
            {(["fast", "light", "full"] as const).map((path) => (
              <option key={path} value={path}>
                {t(`project.path.${path}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {triage ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded bg-sunken px-2 py-1">{t(`project.taskType.${triage.taskType}`)}</span>
          <span className="rounded bg-sunken px-2 py-1">{t("project.complexity", { value: triage.complexity })}</span>
          <span className="rounded bg-accent/10 px-2 py-1 text-accent">
            {t(`project.path.${detail.path ?? "full"}`)}
          </span>
          <span className="text-muted">{t(`project.pathHint.${detail.path ?? "full"}`)}</span>
          {triage.reasons.length > 0 ? <span className="text-muted">· {triage.reasons.join("；")}</span> : null}
        </div>
      ) : null}
      {detail.repoScan ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted" title={detail.repoScan.root}>
          <FolderGit2 className="size-4" />
          <span>{t("project.repo", { name: detail.repoScan.name })}</span>
          {detail.repoScan.stack.length > 0 ? (
            <span>
              ·{" "}
              {t("workspace.repo.detected", {
                value: detail.repoScan.stack.map((item) => item.name).join(", "),
              })}
            </span>
          ) : null}
        </div>
      ) : null}
      <StageStepper detail={detail} />
    </header>
  );
}

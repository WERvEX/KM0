import type { RepoScan } from "@km0/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, FolderGit2, Loader2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { projectKey } from "@/features/project/useProject";
import { call, errorMessage, IpcError } from "@/lib/ipc";
import { useIpcQuery } from "@/lib/queries";

export function WorkspacePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const roles = useIpcQuery("settings.roles.get");
  const info = useIpcQuery("app.info");
  const [description, setDescription] = useState("");
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const simulated = info.data?.simulatedModel ?? false;
  const hasModel = simulated || roles.data?.router != null;
  const steps = ["triage", "discuss", "route", "handoff"] as const;

  const create = useMutation({
    mutationFn: () => call("project.create", { description: description.trim(), repoPath }),
    onSuccess: (detail) => {
      queryClient.setQueryData(projectKey(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ["project.list"] });
      setDescription("");
      setRepoPath(null);
      scan.reset();
      void navigate({ to: "/projects/$projectId", params: { projectId: String(detail.id) } });
    },
  });
  // Picking and scanning run back to back so the user sees what was recognised before starting.
  const scan = useMutation({
    mutationFn: async (): Promise<{ path: string; scan: RepoScan } | null> => {
      const path = await call("repo.pick", undefined);
      if (!path) return null;
      return { path, scan: await call("repo.scan", { path }) };
    },
    onSuccess: (result) => {
      if (result) setRepoPath(result.path);
    },
  });
  const linked = repoPath && scan.data?.path === repoPath ? scan.data.scan : null;
  const configError = create.error instanceof IpcError && create.error.shape.kind === "config";
  const canSubmit = hasModel && description.trim().length >= 4 && !create.isPending && !scan.isPending;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 px-8 py-16">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("workspace.title")}</h1>
        <p className="mt-2 text-muted">{t("workspace.subtitle")}</p>
      </header>

      <form
        className="rounded-lg border border-border bg-panel p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <Textarea
          aria-label={t("workspace.title")}
          placeholder={t("workspace.placeholder")}
          rows={4}
          value={description}
          disabled={!hasModel || create.isPending}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSubmit) create.mutate();
          }}
        />
        <RepoLink
          scan={linked}
          busy={scan.isPending}
          disabled={!hasModel || create.isPending}
          error={scan.error ? errorMessage(scan.error) : null}
          onPick={() => scan.mutate()}
          onRemove={() => {
            setRepoPath(null);
            scan.reset();
          }}
        />
        <div className="mt-3 flex items-center justify-between gap-4">
          <p className="text-sm text-muted">
            {!hasModel ? t("workspace.needModel") : simulated ? t("workspace.simulated") : ""}
          </p>
          {hasModel ? (
            <Button type="submit" variant="primary" disabled={!canSubmit}>
              {create.isPending ? <Loader2 className="animate-spin" /> : null}
              {create.isPending ? t("project.creating") : t("workspace.submit")}
            </Button>
          ) : (
            <Button asChild variant="primary">
              <Link to="/settings">
                {t("workspace.configureModel")}
                <ArrowRight />
              </Link>
            </Button>
          )}
        </div>
        {create.error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {errorMessage(create.error)}
            {configError ? (
              <>
                {" "}
                <Link to="/settings" className="underline">
                  {t("project.error.settings")}
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
      </form>

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">{t("workspace.stepsTitle")}</h2>
        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <li key={step} className="flex gap-3 text-sm">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-xs font-medium">
                {index + 1}
              </span>
              <span className="pt-0.5">{t(`workspace.steps.${step}`)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function RepoLink({
  scan,
  busy,
  disabled,
  error,
  onPick,
  onRemove,
}: {
  scan: RepoScan | null;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onPick: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 flex flex-col gap-1 text-sm">
      {scan ? (
        <div className="flex flex-wrap items-center gap-2">
          <FolderGit2 className="size-4 text-muted" />
          <span className="font-medium" title={scan.root}>
            {scan.name}
          </span>
          <span className="text-xs text-muted">
            {t("workspace.repo.files", { count: scan.fileCount })} ·{" "}
            {scan.stack.length > 0
              ? t("workspace.repo.detected", { value: scan.stack.map((item) => item.name).join(", ") })
              : t("workspace.repo.nothing")}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={onPick} disabled={disabled || busy}>
            {t("workspace.repo.change")}
          </Button>
          <Button type="button" size="icon" variant="ghost" aria-label={t("workspace.repo.remove")} onClick={onRemove}>
            <X />
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onPick} disabled={disabled || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <FolderGit2 />}
            {busy ? t("workspace.repo.scanning") : t("workspace.repo.link")}
          </Button>
          <span className="text-xs text-muted">{t("workspace.repo.hint")}</span>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

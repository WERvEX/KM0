import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Loader2 } from "lucide-react";
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
  const simulated = info.data?.simulatedModel ?? false;
  const hasModel = simulated || roles.data?.router != null;
  const steps = ["triage", "discuss", "route", "handoff"] as const;

  const create = useMutation({
    mutationFn: () => call("project.create", { description: description.trim(), repoPath: null }),
    onSuccess: (detail) => {
      queryClient.setQueryData(projectKey(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ["project.list"] });
      setDescription("");
      void navigate({ to: "/projects/$projectId", params: { projectId: String(detail.id) } });
    },
  });
  const configError = create.error instanceof IpcError && create.error.shape.kind === "config";
  const canSubmit = hasModel && description.trim().length >= 4 && !create.isPending;

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

import type { HandoffPackage, RoutingPlan } from "@km0/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { strToU8, zipSync } from "fflate";
import { Check, Copy, FileArchive, Loader2, Package, Terminal } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { call, errorMessage } from "@/lib/ipc";
import { Markdown } from "../documents/Markdown";
import { projectKey } from "../project/useProject";
import { agentName } from "../settings/AgentsTab";

/** What the package was built from; any change to the routing makes it worth rebuilding. */
const routingSignature = (plan: RoutingPlan) =>
  JSON.stringify([plan.createdAt, plan.tasks.map((task) => [task.id, task.tier, task.agent, task.model])]);

export function downloadZip(pkg: HandoffPackage, name: string) {
  const zipped = zipSync(Object.fromEntries(pkg.files.map((file) => [file.path, strToU8(file.content)])));
  const url = URL.createObjectURL(new Blob([zipped as BlobPart], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? <Check /> : <Copy />}
      {done ? t("handoff.copied") : label}
    </Button>
  );
}

/** Builds the hand-off package from the current routing, previews it and exports it as a zip. */
export function HandoffPanel({ projectId, plan }: { projectId: number; plan: RoutingPlan }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [built, setBuilt] = useState<{ pkg: HandoffPackage; signature: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const build = useMutation({
    mutationFn: () => call("handoff.build", { projectId }),
    onSuccess: (pkg) => {
      setBuilt({ pkg, signature: routingSignature(plan) });
      setPreview(pkg.tasks[0]?.promptPath ?? null);
      void queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
    },
  });
  const outdated = built !== null && built.signature !== routingSignature(plan);
  const pkg = built?.pkg;
  const previewFile = pkg?.files.find((file) => file.path === preview);

  return (
    <section
      aria-label={t("handoff.title")}
      className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-medium">
            <Package className="size-5" />
            {t("handoff.title")}
          </h2>
          <p className="mt-1 text-sm text-muted">{t("handoff.body")}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={pkg && !outdated ? "secondary" : "primary"}
            disabled={build.isPending}
            onClick={() => build.mutate()}
          >
            {build.isPending ? <Loader2 className="animate-spin" /> : null}
            {pkg ? t("handoff.rebuild") : t("handoff.build")}
          </Button>
          {pkg ? (
            <Button variant="primary" disabled={outdated} onClick={() => downloadZip(pkg, `km0-handoff-${projectId}`)}>
              <FileArchive />
              {t("handoff.download")}
            </Button>
          ) : null}
        </div>
      </div>

      {build.error ? (
        <div role="alert" className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
          {errorMessage(build.error)}
        </div>
      ) : null}
      {outdated ? (
        <p className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">{t("handoff.outdated")}</p>
      ) : null}

      {pkg ? (
        <>
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {pkg.tasks.map((task) => (
              <li key={task.taskId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <button
                  type="button"
                  className={cn("text-left", preview === task.promptPath ? "font-medium text-accent" : "")}
                  onClick={() => setPreview(task.promptPath)}
                >
                  {String(task.seq).padStart(2, "0")} · {task.title}
                  <span className="ml-2 text-xs text-muted">
                    {task.tier} · {agentName(task.agent, t)}
                    {task.model ? ` · ${task.model}` : ""}
                  </span>
                </button>
                <div className="flex gap-1">
                  <CopyButton text={task.prompt} label={t("handoff.copyPrompt")} />
                  {task.command ? <CopyButton text={task.command} label={t("handoff.copyCommand")} /> : null}
                </div>
              </li>
            ))}
          </ul>

          <div className="grid gap-3 lg:grid-cols-[14rem_1fr]">
            <nav aria-label={t("handoff.files")} className="flex flex-col gap-0.5 text-xs">
              <div className="mb-1 font-medium text-muted">{t("handoff.files")}</div>
              {pkg.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className={cn(
                    "truncate rounded px-2 py-1 text-left font-mono hover:bg-sunken",
                    preview === file.path ? "bg-sunken text-fg" : "text-muted",
                  )}
                  title={file.path}
                  onClick={() => setPreview(file.path)}
                >
                  {file.path}
                </button>
              ))}
            </nav>
            <div className="min-w-0 rounded-md border border-border p-4">
              {previewFile ? (
                previewFile.path.endsWith(".md") ? (
                  <Markdown>{previewFile.content}</Markdown>
                ) : (
                  <pre className="overflow-x-auto text-xs">{previewFile.content}</pre>
                )
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-2 text-sm">
            {pkg.agents.map((agent) => (
              <p key={agent.id} className="flex items-start gap-2 text-muted">
                <Terminal className="mt-0.5 size-4 shrink-0" />
                <span>
                  <span className="font-medium text-fg">{agentName(agent.id, t)}</span>：{agent.howTo}
                </span>
              </p>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

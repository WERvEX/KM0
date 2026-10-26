import type { ExecutionRun } from "@km0/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { call, errorMessage } from "@/lib/ipc";

export const executionKey = (projectId: number) => ["execution.list", projectId] as const;

const FINAL = new Set(["finished", "cancelled", "failed"]);

/**
 * App-wide: keeps each project's runs current from `execution.update` events, says in a toast when a run
 * ends (never a system notification), and asks in KM0's own dialog before closing with runs still going.
 */
export function ExecutionWatcher() {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const seen = useRef(new Map<number, { status: string; imported: number | null }>());
  const [quitting, setQuitting] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    const offUpdate = window.km0.on("execution.update", (run: ExecutionRun) => {
      queryClient.setQueryData<ExecutionRun[]>(executionKey(run.projectId), (list) =>
        list ? [run, ...list.filter((item) => item.id !== run.id)].sort((a, b) => b.id - a.id) : [run],
      );
      const before = seen.current.get(run.id);
      seen.current.set(run.id, { status: run.status, imported: run.importedRunRef });
      if (FINAL.has(run.status) && before && !FINAL.has(before.status)) {
        toast({
          kind: run.status === "failed" ? "error" : run.status === "cancelled" ? "info" : "success",
          message: t(`execution.ended.${run.status}`, { runId: run.runId }),
        });
      }
      if (run.importedRunRef !== null && before?.imported !== run.importedRunRef) {
        // New reports and verdicts: the Runner panel, the routing (rejections move tasks) and local records.
        void queryClient.invalidateQueries({ queryKey: ["runner.list", run.projectId] });
        void queryClient.invalidateQueries({ queryKey: ["routing.get", run.projectId] });
        void queryClient.invalidateQueries({ queryKey: ["settings.models.list"] });
      }
    });
    const offQuit = window.km0.on("app.quitRequest", ({ running }: { running: number }) => setQuitting(running));
    return () => {
      offUpdate();
      offQuit();
    };
  }, [queryClient, t, toast]);

  return (
    <ConfirmDialog
      open={quitting !== null}
      title={t("execution.quit.title")}
      description={t("execution.quit.body", { count: quitting ?? 0 })}
      confirmLabel={t("execution.quit.confirm")}
      cancelLabel={t("execution.quit.cancel")}
      danger
      pending={stopping}
      onCancel={() => setQuitting(null)}
      onConfirm={() => {
        setStopping(true);
        call("app.quit", undefined).catch((error) => {
          setStopping(false);
          toast({ kind: "error", message: errorMessage(error) });
        });
      }}
    />
  );
}

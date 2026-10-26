import type { ProjectSummary } from "@km0/shared";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Pencil, Plus, Settings, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/field";
import { ExecutionWatcher } from "@/features/execution/ExecutionWatcher";
import { UpdateWatcher } from "@/features/settings/UpdateSection";
import { useIpcMutation, useIpcQuery } from "@/lib/queries";

export function AppShell() {
  const { t } = useTranslation();
  const projects = useIpcQuery("project.list");
  const info = useIpcQuery("app.info");

  return (
    <div className="flex h-full flex-col">
      <ExecutionWatcher />
      <UpdateWatcher />
      {info.data?.platform === "web" ? <WebBanner simulated={info.data.simulatedModel} /> : null}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-panel">
          <div className="px-4 pt-5 pb-4">
            <div className="text-lg font-semibold tracking-tight">KM0</div>
            <div className="text-xs text-muted">{t("app.tagline")}</div>
          </div>
          <div className="px-3">
            <Button asChild variant="primary" className="w-full">
              <Link to="/">
                <Plus />
                {t("nav.newTask")}
              </Link>
            </Button>
          </div>
          <nav className="mt-5 flex-1 overflow-y-auto px-3" aria-label={t("nav.projects")}>
            <div className="px-1 pb-2 text-xs font-medium text-muted">{t("nav.projects")}</div>
            {projects.data && projects.data.length > 0 ? (
              <ul className="flex flex-col gap-0.5">
                {projects.data.map((project) => (
                  <ProjectItem key={project.id} project={project} />
                ))}
              </ul>
            ) : (
              <p className="px-1 text-sm text-muted">{t("nav.noProjects")}</p>
            )}
          </nav>
          <div className="border-t border-border p-3">
            <Button asChild variant="ghost" className="w-full justify-start">
              <Link to="/settings" activeProps={{ className: "bg-sunken" }}>
                <Settings />
                {t("nav.settings")}
              </Link>
            </Button>
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Only in the browser debug build: where data lives, and a switch between real and simulated models. */
function WebBanner({ simulated }: { simulated: boolean }) {
  const { t } = useTranslation();
  // Real and simulated runs keep separate data, so switching reloads the page.
  const target = simulated ? "?" : "?simulated=1";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-warning/10 px-4 py-1.5 text-xs">
      <span>{t("web.banner")}</span>
      {simulated ? <span className="font-medium">{t("web.simulatedOn")}</span> : null}
      <a className="text-accent underline" href={`${target}#/`}>
        {simulated ? t("web.useReal") : t("web.useSimulated")}
      </a>
    </div>
  );
}

type Editing = { mode: "rename" | "delete"; project: ProjectSummary } | null;

/** A project in the sidebar, with its stage and rename / delete actions on hover. */
function ProjectItem({ project }: { project: ProjectSummary }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { projectId?: string };
  const [editing, setEditing] = useState<Editing>(null);
  const [title, setTitle] = useState("");
  const rename = useIpcMutation("project.rename", ["project.list"]);
  const remove = useIpcMutation("project.delete", ["project.list"]);
  const close = () => setEditing(null);

  return (
    <li className="group relative">
      <Link
        to="/projects/$projectId"
        params={{ projectId: String(project.id) }}
        className="block rounded-md px-2 py-1.5 pr-14 hover:bg-sunken"
        activeProps={{ className: "bg-sunken" }}
      >
        <span className="block truncate text-sm">{project.title}</span>
        <span className="block text-[11px] text-muted">{t(`nav.stage.${project.stage}`)}</span>
      </Link>
      <div className="absolute top-1.5 right-1 flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          className="rounded p-1 text-muted hover:bg-panel hover:text-fg"
          aria-label={`${t("nav.rename")} ${project.title}`}
          onClick={() => {
            setTitle(project.title);
            setEditing({ mode: "rename", project });
          }}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted hover:bg-panel hover:text-danger"
          aria-label={`${t("nav.delete")} ${project.title}`}
          onClick={() => setEditing({ mode: "delete", project })}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <Dialog
        open={editing?.mode === "rename"}
        onOpenChange={(open) => !open && close()}
        title={t("nav.renameTitle")}
        footer={
          <>
            <Button onClick={close}>{t("nav.cancel")}</Button>
            <Button
              variant="primary"
              disabled={!title.trim() || rename.isPending}
              onClick={() => rename.mutate({ id: project.id, title: title.trim() }, { onSuccess: close })}
            >
              {t("nav.save")}
            </Button>
          </>
        }
      >
        <Input
          aria-label={t("nav.renameTitle")}
          value={title}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Dialog>
      <ConfirmDialog
        open={editing?.mode === "delete"}
        title={t("nav.deleteTitle")}
        description={t("nav.deleteBody", { name: project.title })}
        confirmLabel={t("nav.delete")}
        cancelLabel={t("nav.cancel")}
        danger
        pending={remove.isPending}
        onCancel={close}
        onConfirm={() =>
          remove.mutate(
            { id: project.id },
            {
              onSuccess: () => {
                close();
                if (params.projectId === String(project.id)) void navigate({ to: "/" });
              },
            },
          )
        }
      />
    </li>
  );
}

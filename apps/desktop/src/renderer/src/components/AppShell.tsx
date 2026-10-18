import { Link, Outlet } from "@tanstack/react-router";
import { Plus, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useIpcQuery } from "@/lib/queries";

export function AppShell() {
  const { t } = useTranslation();
  const projects = useIpcQuery("project.list");

  return (
    <div className="flex h-full">
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
                <li key={project.id}>
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: String(project.id) }}
                    className="block truncate rounded-md px-2 py-1.5 text-sm hover:bg-sunken"
                    activeProps={{ className: "bg-sunken font-medium" }}
                  >
                    {project.title}
                  </Link>
                </li>
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
  );
}

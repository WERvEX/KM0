import { Link, Outlet } from "@tanstack/react-router";
import { Plus, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useIpcQuery } from "@/lib/queries";

export function AppShell() {
  const { t } = useTranslation();
  const projects = useIpcQuery("project.list");
  const info = useIpcQuery("app.info");

  return (
    <div className="flex h-full flex-col">
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

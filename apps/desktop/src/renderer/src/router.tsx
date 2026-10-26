import { createHashHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { CrashPage } from "@/components/CrashPage";
import { ProjectPage } from "@/features/project/ProjectPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { WorkspacePage } from "@/features/workspace/WorkspacePage";

const rootRoute = createRootRoute({ component: AppShell });
const workspaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: WorkspacePage });
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
  // `?tab=execution` opens a tab directly, for links that say where to fix something.
  validateSearch: (search: Record<string, unknown>): { tab?: string } =>
    typeof search.tab === "string" ? { tab: search.tab } : {},
});
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: function ProjectRoute() {
    const { projectId } = projectRoute.useParams();
    return <ProjectPage key={projectId} projectId={Number(projectId)} />;
  },
});

// Hash history: the packaged app is loaded from file://, where path-based URLs do not resolve.
export const router = createRouter({
  routeTree: rootRoute.addChildren([workspaceRoute, settingsRoute, projectRoute]),
  history: createHashHistory(),
  // A page that throws shows KM0's own error page inside the shell, never a blank window.
  defaultErrorComponent: CrashPage,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

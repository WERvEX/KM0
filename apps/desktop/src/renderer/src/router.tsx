import { createHashHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { WorkspacePage } from "@/features/workspace/WorkspacePage";

const rootRoute = createRootRoute({ component: AppShell });
const workspaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: WorkspacePage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });

// Hash history: the packaged app is loaded from file://, where path-based URLs do not resolve.
export const router = createRouter({
  routeTree: rootRoute.addChildren([workspaceRoute, settingsRoute]),
  history: createHashHistory(),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

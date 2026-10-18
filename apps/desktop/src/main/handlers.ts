import type { Gateway } from "@km0/core";
import type { AppInfo, ProjectSummary } from "@km0/shared";
import type { Database } from "./db/database";
import type { Handlers } from "./ipc/router";
import type { SettingsStore } from "./services/settings-store";

export interface HandlerDeps {
  db: Database;
  settings: SettingsStore;
  gateway: Gateway;
  appInfo: () => AppInfo;
}

interface ProjectRow {
  id: number;
  title: string;
  path: ProjectSummary["path"];
  stage: ProjectSummary["stage"];
  status: ProjectSummary["status"];
  created_at: string;
  updated_at: string;
}

export function createHandlers({ db, settings, gateway, appInfo }: HandlerDeps): Handlers {
  return {
    "app.info": () => appInfo(),

    "settings.profiles.list": () => settings.listProfiles(),
    "settings.profiles.create": (input) => settings.createProfile(input),
    "settings.profiles.update": ({ id, data }) => settings.updateProfile(id, data),
    "settings.profiles.delete": ({ id }) => settings.deleteProfile(id),
    "settings.profiles.test": async ({ id }) => {
      const profile = settings.resolveProfile(id);
      const result = await gateway.testConnection(profile);
      // Remember what worked so later calls skip the detection.
      if (result.ok && result.detectedMode && profile.structuredMode === "auto") {
        settings.setStructuredMode(id, result.detectedMode);
      }
      return result;
    },
    "settings.roles.get": () => settings.getRoles(),
    "settings.roles.set": (roles) => settings.setRoles(roles),
    "settings.preferences.get": () => settings.getPreferences(),
    "settings.preferences.set": (partial) => settings.setPreferences(partial),

    "project.list": () => {
      const rows = db
        .prepare("SELECT id, title, path, stage, status, created_at, updated_at FROM projects ORDER BY updated_at DESC")
        .all() as unknown as ProjectRow[];
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        path: row.path,
        stage: row.stage,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
  };
}

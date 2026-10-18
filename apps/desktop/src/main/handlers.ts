import type { Gateway } from "@km0/core";
import type { AppInfo } from "@km0/shared";
import type { Handlers } from "./ipc/router";
import type { ProjectService } from "./services/project-service";
import type { SettingsStore } from "./services/settings-store";

export interface HandlerDeps {
  settings: SettingsStore;
  projects: ProjectService;
  gateway: Gateway;
  appInfo: () => AppInfo;
}

export function createHandlers({ settings, projects, gateway, appInfo }: HandlerDeps): Handlers {
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

    "project.list": () => projects.list(),
    "project.create": ({ description, repoPath }) => projects.create(description, repoPath),
    "project.get": ({ id }) => projects.get(id),
    "project.rename": ({ id, title }) => projects.rename(id, title),
    "project.delete": ({ id }) => projects.delete(id),
    "project.setPath": ({ id, path }) => projects.setPath(id, path),
    "project.retry": ({ id }) => projects.retry(id),

    "round.answer": ({ projectId, roundId, answers }) => projects.answer(projectId, roundId, answers),
    "stage.advance": ({ projectId, adoptRecommended }) => projects.advance(projectId, adoptRecommended),
    "stage.more": ({ projectId }) => projects.askMore(projectId),
    "stage.review": ({ projectId, stage }) => projects.review(projectId, stage),
    "decision.update": ({ projectId, key, value }) => projects.updateDecision(projectId, key, value),
  };
}

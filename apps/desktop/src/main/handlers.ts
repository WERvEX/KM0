import type { Gateway } from "@km0/core";
import type { AppInfo } from "@km0/shared";
import type { Handlers } from "./ipc/router";
import type { AgentStore } from "./services/agent-store";
import type { DocumentService } from "./services/document-service";
import type { HandoffService } from "./services/handoff-service";
import type { ProjectService } from "./services/project-service";
import type { RoutingService } from "./services/routing-service";
import type { SettingsStore } from "./services/settings-store";

export interface HandlerDeps {
  settings: SettingsStore;
  projects: ProjectService;
  documents: DocumentService;
  routing: RoutingService;
  handoff: HandoffService;
  agents: AgentStore;
  gateway: Gateway;
  appInfo: () => AppInfo;
}

export function createHandlers({
  settings,
  projects,
  documents,
  routing,
  handoff,
  agents,
  gateway,
  appInfo,
}: HandlerDeps): Handlers {
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
    "settings.agents.list": () => agents.list(),
    "settings.agents.update": ({ id, enabled, models }) => agents.update(id, enabled, models),
    "settings.agents.move": ({ id, direction }) => agents.move(id, direction),

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

    "document.get": ({ projectId, kind, version }) => documents.get(projectId, kind, version),
    "document.generate": ({ projectId, kind, keepEdited }) => documents.generate(projectId, kind, keepEdited),
    "document.saveSection": ({ projectId, kind, baseVersion, sectionId, body }) =>
      documents.saveSection(projectId, kind, baseVersion, sectionId, body),
    "document.revise": ({ projectId, kind, baseVersion, sectionIds, instruction }) =>
      documents.revise(projectId, kind, baseVersion, sectionIds, instruction),
    "document.restore": ({ projectId, kind, version }) => documents.restore(projectId, kind, version),

    "routing.get": ({ projectId }) => routing.get(projectId),
    "routing.plan": ({ projectId }) => routing.plan(projectId),
    "task.override": ({ projectId, taskId, override }) => routing.override(projectId, taskId, override),

    "handoff.build": ({ projectId }) => handoff.build(projectId),
  };
}

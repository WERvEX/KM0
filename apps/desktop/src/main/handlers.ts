import type { Gateway } from "@km0/core";
import type { AppInfo } from "@km0/shared";
import type { Handlers } from "./ipc/router";
import type { AgentStore } from "./services/agent-store";
import type { ConfigService } from "./services/config-service";
import type { DocumentService } from "./services/document-service";
import type { HandoffService } from "./services/handoff-service";
import type { ProjectService } from "./services/project-service";
import { type RepoAccess, scanPath } from "./services/repo-access";
import type { RoutingService } from "./services/routing-service";
import type { SearchStore } from "./services/search-store";
import type { SettingsStore } from "./services/settings-store";

export interface HandlerDeps {
  settings: SettingsStore;
  projects: ProjectService;
  documents: DocumentService;
  routing: RoutingService;
  handoff: HandoffService;
  agents: AgentStore;
  search: SearchStore;
  config: ConfigService;
  repo: RepoAccess;
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
  search,
  config,
  repo,
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
    "settings.agents.update": ({ id, enabled, models, capabilities }) =>
      agents.update(id, enabled, models, capabilities),
    "settings.agents.move": ({ id, direction }) => agents.move(id, direction),
    "settings.search.list": () => search.list(),
    "settings.search.create": (input) => search.create(input),
    "settings.search.update": ({ id, data }) => search.update(id, data),
    "settings.search.delete": ({ id }) => search.delete(id),
    "settings.search.test": ({ id, query }) => search.test(id, query),
    "settings.export": ({ includeSecrets }) => config.export(includeSecrets),
    "settings.import": (bundle) => config.import(bundle),

    "repo.pick": () => repo.pick(),
    "repo.scan": ({ path }) => scanPath(repo, path),

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
    "task.fail": ({ projectId, taskId }) => routing.recordFailure(projectId, taskId),
    "task.clearFailures": ({ projectId, taskId }) => routing.clearFailures(projectId, taskId),

    "handoff.build": ({ projectId }) => handoff.build(projectId),
  };
}

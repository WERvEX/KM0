import { type Gateway, modelKey } from "@km0/core";
import type { AppInfo } from "@km0/shared";
import type { Handlers } from "./ipc/router";
import type { AgentStore } from "./services/agent-store";
import type { ConfigService } from "./services/config-service";
import type { DocumentService } from "./services/document-service";
import type { FilePort } from "./services/file-port";
import type { FolderRequests } from "./services/folder-requests";
import type { HandoffService } from "./services/handoff-service";
import type { ProjectService } from "./services/project-service";
import type { RegistryService } from "./services/registry-service";
import { type RepoAccess, scanPath } from "./services/repo-access";
import type { RoutingService } from "./services/routing-service";
import type { RunRecordStore } from "./services/run-records";
import type { RunnerService } from "./services/runner-service";
import type { SearchStore } from "./services/search-store";
import type { SettingsStore } from "./services/settings-store";

export interface HandlerDeps {
  settings: SettingsStore;
  projects: ProjectService;
  documents: DocumentService;
  routing: RoutingService;
  handoff: HandoffService;
  runner: RunnerService;
  agents: AgentStore;
  search: SearchStore;
  config: ConfigService;
  registry: RegistryService;
  records: RunRecordStore;
  repo: RepoAccess;
  files: FilePort;
  /** Absent in the browser build, which uses the browser's own folder picker. */
  folders: FolderRequests | null;
  gateway: Gateway;
  appInfo: () => AppInfo;
}

export function createHandlers({
  settings,
  projects,
  documents,
  routing,
  handoff,
  runner,
  agents,
  search,
  config,
  registry,
  records,
  repo,
  files,
  folders,
  gateway,
  appInfo,
}: HandlerDeps): Handlers {
  return {
    "app.info": () => appInfo(),

    "settings.providers.list": () => settings.listProviders(),
    "settings.providers.create": (input) => settings.createProvider(input),
    "settings.providers.update": ({ id, data }) => settings.updateProvider(id, data),
    "settings.providers.delete": ({ id }) => settings.deleteProvider(id),
    "settings.models.list": () => settings.listModels(),
    "settings.models.create": (input) => settings.createModel(input),
    "settings.models.update": ({ id, data }) => settings.updateModel(id, data),
    "settings.models.delete": ({ id }) => settings.deleteModel(id),
    "settings.models.test": async ({ id }) => {
      const profile = settings.resolveProfile(id);
      const result = await gateway.testConnection(profile);
      // Remember what worked so later calls skip the detection.
      if (result.ok && result.detectedMode && profile.structuredMode === "auto") {
        settings.setStructuredMode(id, result.detectedMode);
      }
      return result;
    },
    "settings.models.clearRecords": ({ id }) => {
      records.clearModel(modelKey(settings.getModel(id)));
      return settings.getModel(id);
    },
    "settings.models.registryChoices": ({ query }) => registry.choices(query),
    "settings.roles.get": () => settings.getRoles(),
    "settings.roles.set": (roles) => settings.setRoles(roles),
    "settings.preferences.get": () => settings.getPreferences(),
    "settings.preferences.set": (partial) => settings.setPreferences(partial),
    "settings.routingRules.get": () => settings.getRoutingRules(),
    "settings.routingRules.set": (rules) => settings.setRoutingRules(rules),
    "settings.agents.list": () => agents.list(),
    "settings.agents.update": ({ id, enabled, models, capabilities }) =>
      agents.update(id, enabled, models, capabilities),
    "settings.agents.move": ({ id, direction }) => agents.move(id, direction),
    "settings.agents.create": (input) => agents.createCustom(input),
    "settings.agents.redefine": ({ id, data }) => agents.updateCustom(id, data),
    "settings.agents.delete": ({ id }) => agents.deleteCustom(id),
    "settings.search.list": () => search.list(),
    "settings.search.create": (input) => search.create(input),
    "settings.search.update": ({ id, data }) => search.update(id, data),
    "settings.search.delete": ({ id }) => search.delete(id),
    "settings.search.test": ({ id, query }) => search.test(id, query),
    "settings.export": ({ includeSecrets }) => config.export(includeSecrets),
    "settings.import": (bundle) => config.import(bundle),
    "registry.info": () => registry.info(),
    "registry.vendors": () => registry.current().registry.vendors,
    "registry.update": () => registry.update(),
    "registry.import": ({ text }) => registry.import(text),
    "registry.reset": () => registry.reset(),

    "repo.pick": () => repo.pick(),
    "repo.scan": ({ path }) => scanPath(repo, path),

    "files.browse": (input) => files.browse(input),
    "files.read": ({ path }) => files.read(path),
    "files.save": async (input) => ({ path: await files.save(input) }),
    "files.reveal": ({ path }) => files.reveal(path),
    "folder.answer": (answer) => folders?.answer(answer),

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
    "routing.strategy": ({ projectId, level, budget }) => routing.setStrategy(projectId, level, budget),
    "task.record": ({ projectId, taskId, passed }) => routing.record(projectId, taskId, passed),
    "task.clearFailures": ({ projectId, taskId }) => routing.clearFailures(projectId, taskId),

    "handoff.build": ({ projectId, target }) => handoff.build(projectId, target),

    "runner.import": ({ projectId }) => runner.import(projectId),
    "runner.list": ({ projectId }) => runner.list(projectId),
    "runner.judge": ({ projectId, runRef }) => runner.judge(projectId, runRef),
    "runner.override": ({ projectId, resultId, accepted }) => runner.override(projectId, resultId, accepted),
    "runner.writeBack": ({ projectId, runRef }) => runner.writeBack(projectId, runRef),
  };
}

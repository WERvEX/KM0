import { CONFIG_FORMAT, CONFIG_VERSION, type ConfigBundle, type ImportSummary } from "@km0/shared";
import type { AgentStore } from "./agent-store";
import type { SearchStore } from "./search-store";
import type { SettingsStore } from "./settings-store";

/** Moves Settings between installs as one JSON file. */
export class ConfigService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly agents: AgentStore,
    private readonly search: SearchStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  export(includeSecrets: boolean): ConfigBundle {
    const profiles = this.settings.listProfiles();
    const nameOf = (id: number | null) => profiles.find((profile) => profile.id === id)?.name ?? null;
    const roles = this.settings.getRoles();
    return {
      format: CONFIG_FORMAT,
      version: CONFIG_VERSION,
      exportedAt: this.now(),
      includesSecrets: includeSecrets,
      profiles: profiles.map((profile) => {
        const apiKey = includeSecrets ? this.settings.resolveProfile(profile.id).apiKey : null;
        return {
          name: profile.name,
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          model: profile.model,
          structuredMode: profile.structuredMode,
          temperature: profile.temperature,
          priceInPerMTok: profile.priceInPerMTok,
          priceOutPerMTok: profile.priceOutPerMTok,
          ...(apiKey ? { apiKey } : {}),
        };
      }),
      roles: { router: nameOf(roles.router), planner: nameOf(roles.planner) },
      preferences: this.settings.getPreferences(),
      agents: this.agents.list().map((agent) => ({
        id: agent.id,
        enabled: agent.enabled,
        models: agent.models,
        capabilities: agent.capabilities,
      })),
      searchServices: this.search.exportAll(includeSecrets),
    };
  }

  /**
   * Merge a bundle into the current settings. Profiles and search services are matched by name:
   * existing ones are updated (keeping their stored key when the file has none), new ones created.
   * Nothing is deleted.
   */
  import(bundle: ConfigBundle): ImportSummary {
    const summary: ImportSummary = {
      profilesCreated: 0,
      profilesUpdated: 0,
      searchCreated: 0,
      searchUpdated: 0,
      agentsUpdated: 0,
      localServersDisabled: 0,
      rolesSet: false,
    };
    for (const input of bundle.profiles) {
      const existing = this.settings.listProfiles().find((profile) => profile.name === input.name);
      if (existing) {
        this.settings.updateProfile(existing.id, input);
        summary.profilesUpdated += 1;
      } else {
        this.settings.createProfile(input);
        summary.profilesCreated += 1;
      }
    }

    const profiles = this.settings.listProfiles();
    const idOf = (name: string | null) =>
      name === null ? null : (profiles.find((profile) => profile.name === name)?.id ?? null);
    const router = idOf(bundle.roles.router);
    if (router !== null) {
      this.settings.setRoles({ router, planner: idOf(bundle.roles.planner) });
      summary.rolesSet = true;
    }

    this.settings.setPreferences(bundle.preferences);

    const known = new Set(this.agents.list().map((agent) => agent.id));
    for (const agent of bundle.agents) {
      if (!known.has(agent.id)) continue;
      this.agents.update(agent.id, agent.enabled, agent.models, agent.capabilities);
      summary.agentsUpdated += 1;
    }
    if (bundle.agents.length > 0) this.agents.reorder(bundle.agents.map((agent) => agent.id));

    for (const input of bundle.searchServices) {
      const result = this.search.upsertByName(input);
      if (result.created) summary.searchCreated += 1;
      else summary.searchUpdated += 1;
      if (result.disabled) summary.localServersDisabled += 1;
    }
    return summary;
  }
}

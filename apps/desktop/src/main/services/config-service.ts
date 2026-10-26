import {
  CONFIG_FORMAT,
  CONFIG_VERSION,
  type ConfigBundle,
  type ConfigBundleV1,
  type ConfigBundleV2,
  type ImportSummary,
  isPresetAgent,
  TIERS,
  type Tier,
} from "@km0/shared";
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

  export(includeSecrets: boolean): ConfigBundleV2 {
    const providers = this.settings.listProviders();
    const models = this.settings.listModels();
    const nameOf = (id: number | null) => models.find((model) => model.id === id)?.name ?? null;
    const roles = this.settings.getRoles();
    return {
      format: CONFIG_FORMAT,
      version: CONFIG_VERSION,
      exportedAt: this.now(),
      includesSecrets: includeSecrets,
      providers: providers.map((provider) => {
        const apiKey = includeSecrets ? this.settings.providerKey(provider.id) : null;
        return {
          name: provider.name,
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          billing: provider.billing,
          ...(apiKey ? { apiKey } : {}),
        };
      }),
      models: models.map((model) => ({
        provider: model.providerName,
        modelId: model.modelId,
        name: model.name,
        canonicalId: model.canonicalSource === "manual" ? model.canonicalId : null,
        contextWindow: null,
        structuredMode: model.structuredMode,
        temperature: model.temperature,
        priceInPerMTok: model.priceInPerMTok,
        priceOutPerMTok: model.priceOutPerMTok,
        priceCacheReadPerMTok: model.priceCacheReadPerMTok,
      })),
      roles: { router: nameOf(roles.router), planner: nameOf(roles.planner) },
      preferences: this.settings.getPreferences(),
      agents: this.agents.list().map((agent) => ({
        id: agent.id,
        name: agent.name,
        kind: agent.kind,
        enabled: agent.enabled,
        models: {
          T1: agent.models.T1?.name ?? null,
          T2: agent.models.T2?.name ?? null,
          T3: agent.models.T3?.name ?? null,
        },
        capabilities: agent.capabilities,
        instructionFile: agent.instructionFile,
        launchTemplate: agent.launchTemplate,
        apiKinds: agent.kind === "custom" ? agent.apiKinds : [],
        nativeVendor: agent.kind === "custom" ? (agent.nativeVendors[0] ?? null) : null,
      })),
      searchServices: this.search.exportAll(includeSecrets),
    };
  }

  /**
   * Merge a bundle into the current settings. Providers, models, custom agents and search services
   * are matched by name: existing ones are updated (keeping a stored key when the file has none),
   * new ones created. Nothing is deleted. Files from KM0 0.1 are converted first.
   */
  import(input: ConfigBundle): ImportSummary {
    const bundle = input.version === 1 ? upgrade(input) : input;
    const summary: ImportSummary = {
      providersCreated: 0,
      providersUpdated: 0,
      modelsCreated: 0,
      modelsUpdated: 0,
      searchCreated: 0,
      searchUpdated: 0,
      agentsUpdated: 0,
      agentsCreated: 0,
      localServersDisabled: 0,
      rolesSet: false,
    };

    for (const provider of bundle.providers) {
      const existing = this.settings.listProviders().find((item) => item.name === provider.name);
      if (existing) {
        this.settings.updateProvider(existing.id, provider);
        summary.providersUpdated += 1;
      } else {
        this.settings.createProvider(provider);
        summary.providersCreated += 1;
      }
    }
    const providerId = new Map(this.settings.listProviders().map((provider) => [provider.name, provider.id]));
    for (const model of bundle.models) {
      const id = providerId.get(model.provider);
      if (id === undefined) continue;
      const data = { ...model, providerId: id };
      const existing = this.settings.listModels().find((item) => item.name === model.name);
      if (existing) {
        this.settings.updateModel(existing.id, data);
        summary.modelsUpdated += 1;
      } else {
        this.settings.createModel(data);
        summary.modelsCreated += 1;
      }
    }

    const models = this.settings.listModels();
    const modelId = (name: string | null) => (name === null ? null : (models.find((m) => m.name === name)?.id ?? null));
    const router = modelId(bundle.roles.router ?? null);
    if (router !== null) {
      this.settings.setRoles({ router, planner: modelId(bundle.roles.planner ?? null) });
      summary.rolesSet = true;
    }

    this.settings.setPreferences(bundle.preferences);

    const order: string[] = [];
    for (const agent of bundle.agents) {
      let target = this.agents.list().find((item) => item.id === agent.id);
      if (agent.kind === "custom") {
        const definition = {
          name: agent.name,
          instructionFile: agent.instructionFile,
          launchTemplate: agent.launchTemplate,
          apiKinds: agent.apiKinds,
          nativeVendor: agent.nativeVendor,
          capabilities: agent.capabilities,
        };
        const sameName = this.agents.list().find((item) => item.kind === "custom" && item.name === agent.name);
        if (sameName) {
          this.agents.updateCustom(sameName.id, definition);
          target = this.agents.list().find((item) => item.id === sameName.id);
        } else {
          const before = new Set(this.agents.list().map((item) => item.id));
          target = this.agents.createCustom(definition).find((item) => !before.has(item.id));
          summary.agentsCreated += 1;
        }
      } else if (!target || !isPresetAgent(agent.id)) {
        continue;
      }
      if (!target) continue;
      const tiers = Object.fromEntries(TIERS.map((tier) => [tier, modelId(agent.models[tier])])) as Record<
        Tier,
        number | null
      >;
      // A model the agent cannot use (another API format) is left out rather than failing the import.
      for (const tier of TIERS) {
        const model = models.find((item) => item.id === tiers[tier]);
        if (model && target.apiKinds.length > 0 && !target.apiKinds.includes(model.providerKind)) tiers[tier] = null;
      }
      this.agents.update(target.id, agent.enabled, tiers, agent.capabilities);
      if (agent.kind !== "custom") summary.agentsUpdated += 1;
      order.push(target.id);
    }
    if (order.length > 0) this.agents.reorder(order);

    for (const service of bundle.searchServices) {
      const result = this.search.upsertByName(service);
      if (result.created) summary.searchCreated += 1;
      else summary.searchUpdated += 1;
      if (result.disabled) summary.localServersDisabled += 1;
    }
    return summary;
  }
}

/** A 0.1 file: each profile becomes a provider with one model; each agent's typed models a provider named after the agent. */
export function upgrade(old: ConfigBundleV1): ConfigBundleV2 {
  const providers: ConfigBundleV2["providers"] = old.profiles.map((profile) => ({
    name: profile.name,
    kind: profile.provider,
    baseUrl: profile.baseUrl,
    billing: { mode: "token" },
    ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
  }));
  const models: ConfigBundleV2["models"] = old.profiles.map((profile) => ({
    provider: profile.name,
    modelId: profile.model,
    name: profile.name,
    canonicalId: null,
    contextWindow: null,
    structuredMode: profile.structuredMode,
    temperature: profile.temperature,
    priceInPerMTok: profile.priceInPerMTok,
    priceOutPerMTok: profile.priceOutPerMTok,
    priceCacheReadPerMTok: null,
  }));
  const names = new Set([...providers.map((p) => p.name), ...models.map((m) => m.name)]);
  const unique = (name: string) => {
    let candidate = name;
    for (let n = 2; names.has(candidate); n += 1) candidate = `${name} (${n})`;
    names.add(candidate);
    return candidate;
  };
  const agents: ConfigBundleV2["agents"] = old.agents.map((agent) => {
    const tiers: Record<Tier, string | null> = { T1: null, T2: null, T3: null };
    const typed = TIERS.flatMap((tier) => (agent.models[tier] ? [[tier, agent.models[tier]] as const] : []));
    if (typed.length > 0) {
      const provider = unique(agent.id);
      providers.push({
        name: provider,
        kind: agent.id === "claude_code" ? "anthropic" : "openai",
        baseUrl: null,
        billing: { mode: "token" },
      });
      for (const [tier, model] of typed) {
        const name = unique(model.modelId);
        models.push({
          provider,
          modelId: model.modelId,
          name,
          canonicalId: null,
          contextWindow: null,
          structuredMode: "auto",
          temperature: null,
          priceInPerMTok: model.priceInPerMTok,
          priceOutPerMTok: model.priceOutPerMTok,
          priceCacheReadPerMTok: null,
        });
        tiers[tier] = name;
      }
    }
    return {
      id: agent.id,
      name: agent.id,
      kind: "preset",
      enabled: agent.enabled,
      models: tiers,
      capabilities: agent.capabilities ?? [],
      instructionFile: null,
      launchTemplate: null,
      apiKinds: [],
      nativeVendor: null,
    };
  });
  return {
    format: CONFIG_FORMAT,
    version: 2,
    exportedAt: old.exportedAt,
    includesSecrets: old.includesSecrets,
    providers,
    models,
    roles: { router: old.roles.router, planner: old.roles.planner },
    preferences: old.preferences,
    agents,
    searchServices: old.searchServices,
  };
}

import { AbilityKind, type Estimate, type ModelRegistry } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../db/database";
import { migrations } from "../db/migrations";
import { AgentStore } from "./agent-store";
import { RunRecordStore } from "./run-records";
import { PlainSecretStore } from "./secrets";
import { SettingsStore } from "./settings-store";

const abilities = Object.fromEntries(AbilityKind.options.map((kind) => [kind, { mean: 1, sd: 0.3 }])) as Record<
  AbilityKind,
  Estimate
>;

/** A registry with two models, enough to match IDs and fill in official prices. */
const registry: ModelRegistry = {
  schemaVersion: 1,
  generatedAt: "2026-10-26T00:00:00Z",
  dataDate: "2026-10-23",
  sources: [],
  difficulty: { bands: [] },
  vendors: [],
  agents: [],
  models: [
    {
      id: "anthropic/claude-opus-5.5",
      name: "Claude Opus 5.5",
      vendor: "anthropic",
      aliases: ["claude-opus-5.5", "Opus 5.5"],
      released: "2026-09-20",
      contextWindow: 1_000_000,
      pricing: { input: 5, output: 25, cacheRead: 0.5 },
      abilities,
      coverage: "measured",
      observations: [],
    },
    {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      vendor: "deepseek",
      aliases: ["deepseek-v4-flash"],
      released: "2026-04-24",
      contextWindow: 1_048_576,
      pricing: { input: 0.15, output: 0.6, cacheRead: null },
      abilities,
      coverage: "measured",
      observations: [],
    },
  ],
};

function store() {
  const db = openDatabase(":memory:");
  const settings = new SettingsStore(db, new PlainSecretStore(), () => registry);
  return { db, settings };
}

function withProvider(
  settings: SettingsStore,
  overrides: Partial<Parameters<SettingsStore["createProvider"]>[0]> = {},
) {
  return settings.createProvider({
    name: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com",
    ...overrides,
  });
}

describe("database", () => {
  it("applies migrations once", () => {
    const { db } = store();
    migrate(db, migrations);
    const rows = db.prepare("SELECT id FROM schema_migrations").all();
    expect(rows).toHaveLength(migrations.length);
  });

  it("turns 0.1 profiles and the per-agent catalog into providers and models, keeping roles and the call log", () => {
    const db = openDatabase(":memory:", migrations.slice(0, 8));
    const now = "2026-10-01T00:00:00.000Z";
    db.prepare(
      `INSERT INTO llm_profiles (id, name, provider, base_url, model, structured_mode, price_in_per_mtok, price_out_per_mtok, created_at, updated_at)
       VALUES (7, 'Router', 'openai', 'https://api.deepseek.com', 'deepseek-v4-flash', 'tool', 0.2, 0.8, ?, ?)`,
    ).run(now, now);
    db.prepare("INSERT INTO preferences (key, value) VALUES ('role.router', '7')").run();
    db.prepare(
      `INSERT INTO llm_calls (profile_id, model, purpose, mode, attempt, input_tokens, output_tokens, latency_ms, created_at)
       VALUES (7, 'deepseek-v4-flash', 'triage', 'tool', 1, 10, 2, 100, ?)`,
    ).run(now);
    db.prepare(
      "INSERT INTO model_catalog (agent_id, tier, model_id, price_in_per_mtok, price_out_per_mtok) VALUES ('codex', 'T2', 'gpt-6-sol', 2, 8)",
    ).run();
    migrate(db, migrations);

    const settings = new SettingsStore(db, new PlainSecretStore(), () => registry);
    expect(settings.getRoles().router).toBe(7);
    expect(settings.getModel(7)).toMatchObject({
      name: "Router",
      modelId: "deepseek-v4-flash",
      structuredMode: "tool",
      providerName: "Router",
      canonicalId: "deepseek/deepseek-v4-flash",
      priceInPerMTok: 0.2,
    });
    expect(db.prepare("SELECT profile_id FROM llm_calls").get()).toEqual({ profile_id: 7 });

    const agents = new AgentStore(db, () => settings.listModels());
    const claude = agents.list().find((agent) => agent.id === "claude_code");
    const codex = agents.list().find((agent) => agent.id === "codex");
    // The catalog KM0 0.1 shipped for Claude Code, and the one typed for Codex.
    expect(claude?.models.find((model) => model.tier === "T3")).toMatchObject({
      modelId: "claude-opus-5-5",
      vendor: "anthropic",
      native: true,
    });
    expect(claude?.name).toBe("Claude Code");
    expect(codex?.models).toEqual([expect.objectContaining({ modelId: "gpt-6-sol", priceInPerMTok: 2, tier: "T2" })]);
    expect(
      settings
        .listProviders()
        .map((provider) => provider.name)
        .sort(),
    ).toEqual(["Claude Code", "Codex", "Router"]);
  });
});

describe("providers", () => {
  it("stores the key encrypted and only exposes a hint", () => {
    const { db, settings } = store();
    const provider = withProvider(settings, { apiKey: "sk-1234567890abcd" });
    expect(provider).toMatchObject({ hasApiKey: true, apiKeyHint: "••••abcd", billing: { mode: "token" } });
    expect(JSON.stringify(provider)).not.toContain("sk-1234567890abcd");
    const raw = db.prepare("SELECT api_key_encrypted FROM providers WHERE id = ?").get(provider.id) as {
      api_key_encrypted: string;
    };
    expect(raw.api_key_encrypted).not.toContain("sk-1234567890abcd");
    const model = settings.createModel({ providerId: provider.id, modelId: "deepseek-v4-flash" });
    expect(settings.resolveProfile(model.id).apiKey).toBe("sk-1234567890abcd");
    expect(settings.providerKey(provider.id)).toBe("sk-1234567890abcd");
  });

  it("keeps the key when an update omits it and removes it on an empty string", () => {
    const { settings } = store();
    const provider = withProvider(settings, { apiKey: "sk-keep-this-key" });
    settings.updateProvider(provider.id, { name: "Renamed", kind: "openai", baseUrl: provider.baseUrl });
    expect(settings.providerKey(provider.id)).toBe("sk-keep-this-key");
    expect(settings.updateProvider(provider.id, { name: "Renamed", kind: "openai", apiKey: "" }).hasApiKey).toBe(false);
  });

  it("resets detected modes when its endpoint changes, and deletes its models with it", () => {
    const { settings } = store();
    const provider = withProvider(settings);
    const model = settings.createModel({ providerId: provider.id, modelId: "deepseek-v4-flash" });
    settings.setStructuredMode(model.id, "tool");
    settings.updateProvider(provider.id, {
      name: "DeepSeek",
      kind: "anthropic",
      baseUrl: "https://api.deepseek.com/anthropic",
    });
    expect(settings.getModel(model.id).structuredMode).toBe("auto");
    settings.deleteProvider(provider.id);
    expect(settings.listModels().some((entry) => entry.providerId === provider.id)).toBe(false);
    expect(settings.getRoles().router).toBeNull();
  });

  it("rejects duplicate names as a conflict", () => {
    const { settings } = store();
    withProvider(settings);
    expect(() => withProvider(settings)).toThrow(expect.objectContaining({ kind: "conflict" }));
  });
});

describe("models", () => {
  it("start with the Claude Code models KM0 has always suggested", () => {
    const { settings } = store();
    expect(settings.listModels().map((model) => model.modelId)).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(settings.getRoles().router).toBeNull();
  });

  it("makes the first model the router and lets the planner fall back to it", () => {
    const { settings } = store();
    const provider = withProvider(settings);
    const first = settings.createModel({ providerId: provider.id, modelId: "deepseek-v4-flash" });
    settings.createModel({ providerId: provider.id, modelId: "deepseek-v4-pro" });
    expect(settings.getRoles()).toEqual({ router: first.id, planner: null });
    expect(settings.profileForRole("planner").id).toBe(first.id);
  });

  it("matches the registry by model ID, or by hand, and takes the vendor, context window and official price from it", () => {
    const { settings } = store();
    const provider = settings.createProvider({ name: "Anthropic", kind: "anthropic" });
    const opus = settings.createModel({ providerId: provider.id, modelId: "claude-opus-5-5", name: "Opus" });
    expect(opus).toMatchObject({
      name: "Opus",
      canonicalId: "anthropic/claude-opus-5.5",
      canonicalSource: "auto",
      vendor: "anthropic",
      contextWindow: 1_000_000,
      effective: { mode: "token", input: 5, output: 25, cacheRead: 0.5, source: "registry" },
      callable: false,
    });
    const odd = settings.createModel({ providerId: provider.id, modelId: "my-relay-name", name: "Relay model" });
    expect(odd).toMatchObject({ canonicalId: null, matchProblem: "unmatched", vendor: null });
    const fixed = settings.updateModel(odd.id, {
      providerId: provider.id,
      modelId: "my-relay-name",
      name: "Relay model",
      canonicalId: "anthropic/claude-opus-5.5",
    });
    expect(fixed).toMatchObject({ canonicalSource: "manual", vendor: "anthropic" });
  });

  it("applies the provider's billing: own prices, relay multipliers, subscriptions and free models", () => {
    const { settings } = store();
    const relay = settings.createProvider({
      name: "Relay",
      kind: "anthropic",
      baseUrl: "https://relay.example",
      billing: { mode: "relay", multiplier: 0.5 },
    });
    const viaRelay = settings.createModel({ providerId: relay.id, modelId: "claude-opus-5-5", name: "Via relay" });
    expect(viaRelay.effective).toMatchObject({ mode: "relay", input: 2.5, output: 12.5 });
    const priced = settings.createModel({
      providerId: relay.id,
      modelId: "claude-opus-5-5",
      name: "Priced",
      priceInPerMTok: 4,
      priceOutPerMTok: 20,
    });
    expect(priced.effective).toMatchObject({ input: 2, output: 10, source: "model" });

    const max = settings.createProvider({
      name: "Max",
      kind: "anthropic",
      billing: { mode: "subscription", monthlyFee: 200, quota: null, overflow: "unavailable" },
    });
    const inPlan = settings.createModel({ providerId: max.id, modelId: "claude-opus-5-5", name: "Opus in plan" });
    expect(inPlan.effective).toMatchObject({ mode: "subscription", input: 0, output: 0 });
    expect(settings.resolveProfile(inPlan.id).priceInPerMTok).toBe(0);

    const local = settings.createProvider({
      name: "Local",
      kind: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      billing: { mode: "free" },
    });
    const unknown = settings.createModel({ providerId: local.id, modelId: "qwen-local" });
    expect(unknown).toMatchObject({ effective: { mode: "free", input: 0 }, callable: true });
  });

  it("resets a detected mode when the model ID changes, and rejects duplicate names", () => {
    const { settings } = store();
    const provider = withProvider(settings);
    const model = settings.createModel({ providerId: provider.id, modelId: "deepseek-v4-flash" });
    settings.setStructuredMode(model.id, "tool");
    const updated = settings.updateModel(model.id, {
      providerId: provider.id,
      modelId: "deepseek-v4-pro",
      name: "deepseek-v4-flash",
      structuredMode: "tool",
    });
    expect(updated.structuredMode).toBe("auto");
    expect(() => settings.createModel({ providerId: provider.id, modelId: "x", name: "deepseek-v4-flash" })).toThrow(
      expect.objectContaining({ kind: "conflict" }),
    );
  });

  it("clears role assignments when a model is deleted", () => {
    const { settings } = store();
    const model = settings.createModel({ providerId: withProvider(settings).id, modelId: "deepseek-v4-flash" });
    settings.setRoles({ router: model.id, planner: model.id });
    settings.deleteModel(model.id);
    expect(settings.getRoles()).toEqual({ router: null, planner: null });
    expect(() => settings.profileForRole("router")).toThrow(expect.objectContaining({ kind: "config" }));
  });
});

describe("preferences and logs", () => {
  it("merges preference updates", () => {
    const { settings } = store();
    expect(settings.getPreferences()).toEqual({ language: "system", theme: "system" });
    expect(settings.setPreferences({ language: "en" })).toEqual({ language: "en", theme: "system" });
  });

  it("records model calls", () => {
    const { db, settings } = store();
    const model = settings.createModel({ providerId: withProvider(settings).id, modelId: "deepseek-v4-flash" });
    settings.recordCall({
      profileId: model.id,
      model: "deepseek-v4-flash",
      purpose: "connection_test",
      projectId: null,
      mode: "tool",
      attempt: 1,
      inputTokens: 10,
      outputTokens: 2,
      costUsd: null,
      latencyMs: 120,
      error: null,
    });
    expect(db.prepare("SELECT purpose, input_tokens FROM llm_calls").get()).toEqual({
      purpose: "connection_test",
      input_tokens: 10,
    });
  });

  it("stores imported routing rules and goes back to the defaults on null", () => {
    const { settings } = store();
    const defaults = settings.getRoutingRules();
    expect(defaults.custom).toBe(false);
    const rules = { ...defaults.rules, tierLimits: { T1: 1, T2: 4 } };
    expect(settings.setRoutingRules(rules)).toEqual({ rules, custom: true });
    expect(settings.getRoutingRules().rules.tierLimits).toEqual({ T1: 1, T2: 4 });
    expect(() => settings.setRoutingRules({ ...rules, tierLimits: { T1: 5, T2: 2 } })).toThrow();
    expect(settings.setRoutingRules(null)).toEqual(defaults);
  });
});

describe("abilities and quotas", () => {
  it("labels models by ability, keeps a label set by hand and learns from this install's runs", () => {
    const db = openDatabase(":memory:");
    const records = new RunRecordStore(db);
    const settings = new SettingsStore(
      db,
      new PlainSecretStore(),
      () => registry,
      () => records.all(),
    );
    const provider = settings.createProvider({ name: "DeepSeek", kind: "openai" });
    const flash = settings.createModel({ providerId: provider.id, modelId: "deepseek-v4-flash" });
    expect(flash.ability).toMatchObject({ coverage: "measured", runs: 0 });
    const own = settings.createModel({ providerId: provider.id, modelId: "my-local", priceOutPerMTok: 0.5 });
    expect(own.ability.coverage).toBe("unmatched");
    expect(settings.updateModel(own.id, { providerId: provider.id, modelId: "my-local", tierLabel: "T3" }).tier).toBe(
      "T3",
    );
    records.add({
      modelKey: "deepseek/deepseek-v4-flash",
      agent: "pi",
      native: false,
      kind: "general",
      band: "15m-1h",
      passed: false,
      weight: 1,
      source: "user",
      projectId: null,
      taskId: null,
      ref: null,
    });
    const after = settings.getModel(flash.id).ability;
    expect(after).toMatchObject({ runs: 1, passed: 0 });
    expect(after.current.mean).toBeLessThan(after.prior.mean);
    records.clearModel("deepseek/deepseek-v4-flash");
    expect(settings.getModel(flash.id).ability.runs).toBe(0);
  });

  it("treats a subscription past its quota as unavailable, or priced per token when it allows that", () => {
    const db = openDatabase(":memory:");
    const settings = new SettingsStore(db, new PlainSecretStore(), () => registry);
    const quota = { amount: 1, unit: "requests" as const, window: "5h" as const };
    const provider = settings.createProvider({
      name: "Plan",
      kind: "openai",
      billing: { mode: "subscription", monthlyFee: 20, quota, overflow: "unavailable" },
    });
    const model = settings.createModel({ providerId: provider.id, modelId: "deepseek-v4-flash" });
    const tier = { modelRef: model.id, providerId: provider.id } as Parameters<
      ReturnType<SettingsStore["pastQuota"]>
    >[0];
    expect(settings.pastQuota()(tier)).toBeNull();
    settings.recordCall({
      profileId: model.id,
      model: model.modelId,
      purpose: "triage",
      projectId: null,
      mode: "text",
      attempt: 1,
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0,
      latencyMs: 1,
      error: null,
    });
    expect(settings.pastQuota()(tier)).toBe("unavailable");
    settings.updateProvider(provider.id, {
      name: "Plan",
      kind: "openai",
      billing: { mode: "subscription", monthlyFee: 20, quota, overflow: "token" },
    });
    expect(settings.pastQuota()(tier)).toMatchObject({ mode: "token", source: "registry" });
  });
});

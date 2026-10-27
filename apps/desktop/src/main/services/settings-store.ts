import {
  DEFAULT_ROUTING_RULES,
  EMPTY_REGISTRY,
  effectivePrice,
  type LlmCallRecord,
  matchRegistryModel,
  modelAbility,
  type ResolvedProfile,
  type RunRecord,
  tierLabels,
} from "@km0/core";
import {
  AppError,
  Billing,
  DEFAULT_BILLING,
  DEFAULT_PREFERENCES,
  type EffectivePrice,
  type LlmRole,
  type ModelEntry,
  ModelInput,
  type ModelRegistry,
  Preferences,
  type Provider,
  ProviderInput,
  type ProviderKind,
  type Quota,
  type RoleAssignment,
  RoutingRules,
  type RoutingRulesState,
  type StructuredMode,
  type Tier,
  type TierModel,
} from "@km0/shared";
import { type Database, nowIso, transaction } from "../db/sql";
import { keyHint, type SecretStore } from "./secrets";

interface ProviderRow {
  id: number;
  name: string;
  kind: ProviderKind;
  base_url: string | null;
  api_key_encrypted: string | null;
  api_key_hint: string | null;
  billing_json: string;
  created_at: string;
  updated_at: string;
}

interface ModelRow {
  id: number;
  provider_id: number;
  name: string;
  model_id: string;
  canonical_id: string | null;
  context_window: number | null;
  structured_mode: StructuredMode;
  temperature: number | null;
  price_in_per_mtok: number | null;
  price_out_per_mtok: number | null;
  price_cache_read_per_mtok: number | null;
  tier_label: Tier | null;
  created_at: string;
  updated_at: string;
}

function parseBilling(json: string): Billing {
  try {
    const parsed = Billing.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : DEFAULT_BILLING;
  } catch {
    return DEFAULT_BILLING;
  }
}

function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    hasApiKey: row.api_key_encrypted !== null,
    apiKeyHint: row.api_key_hint,
    billing: parseBilling(row.billing_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ROLE_KEYS: Record<LlmRole, string> = { router: "role.router", planner: "role.planner" };

export { EMPTY_REGISTRY };

/** How far back a quota window reaches, in milliseconds; windows roll rather than reset on a calendar. */
const WINDOW_MS: Record<Quota["window"], number> = {
  "5h": 5 * 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

/**
 * Providers, their models, role assignment and UI preferences. A provider holds the endpoint, the
 * key and the billing; its models serve KM0's own calls and the coding agents. API keys never leave
 * this class in plain text except via `resolveProfile` and `providerKey`.
 */
export class SettingsStore {
  constructor(
    private readonly db: Database,
    private readonly secrets: SecretStore,
    private readonly registry: () => ModelRegistry = () => EMPTY_REGISTRY,
    private readonly records: () => RunRecord[] = () => [],
  ) {}

  // Providers

  listProviders(): Provider[] {
    return (this.db.prepare("SELECT * FROM providers ORDER BY name").all() as unknown as ProviderRow[]).map(toProvider);
  }

  getProvider(id: number): Provider {
    return toProvider(this.providerRow(id));
  }

  createProvider(input: ProviderInput): Provider {
    const data = ProviderInput.parse(input);
    const now = nowIso();
    const key = data.apiKey?.trim() ? data.apiKey.trim() : null;
    try {
      const result = this.db
        .prepare(
          `INSERT INTO providers (name, kind, base_url, api_key_encrypted, api_key_hint, billing_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          data.name,
          data.kind,
          data.baseUrl,
          key ? this.secrets.encrypt(key) : null,
          key ? keyHint(key) : null,
          JSON.stringify(data.billing),
          now,
          now,
        );
      return this.getProvider(Number(result.lastInsertRowid));
    } catch (error) {
      throw uniqueNameError(error, "providers") ?? error;
    }
  }

  /** `apiKey` omitted keeps the stored key; an empty string removes it. */
  updateProvider(id: number, input: ProviderInput): Provider {
    const existing = this.providerRow(id);
    const data = ProviderInput.parse(input);
    let encrypted = existing.api_key_encrypted;
    let hint = existing.api_key_hint;
    if (data.apiKey !== undefined) {
      const key = data.apiKey.trim();
      encrypted = key ? this.secrets.encrypt(key) : null;
      hint = key ? keyHint(key) : null;
    }
    try {
      transaction(this.db, () => {
        this.db
          .prepare(
            `UPDATE providers SET name = ?, kind = ?, base_url = ?, api_key_encrypted = ?, api_key_hint = ?,
               billing_json = ?, updated_at = ? WHERE id = ?`,
          )
          .run(data.name, data.kind, data.baseUrl, encrypted, hint, JSON.stringify(data.billing), nowIso(), id);
        // A different endpoint invalidates the structured output mode detected for its models.
        if (existing.kind !== data.kind || existing.base_url !== data.baseUrl) {
          this.db.prepare("UPDATE models SET structured_mode = 'auto' WHERE provider_id = ?").run(id);
        }
      });
    } catch (error) {
      throw uniqueNameError(error, "providers") ?? error;
    }
    return this.getProvider(id);
  }

  /** Deletes the provider with its models; roles that used them are cleared. */
  deleteProvider(id: number): void {
    this.providerRow(id);
    const models = (this.db.prepare("SELECT id FROM models WHERE provider_id = ?").all(id) as { id: number }[]).map(
      (row) => row.id,
    );
    this.db.prepare("DELETE FROM providers WHERE id = ?").run(id);
    this.clearRoles(models);
  }

  /** The provider's key in plain text, for handing to a process that needs it (KM0 Runner). */
  providerKey(id: number): string | null {
    const row = this.providerRow(id);
    return row.api_key_encrypted ? this.decrypt(row.api_key_encrypted, row.name) : null;
  }

  // Models

  listModels(): ModelEntry[] {
    const providers = new Map(
      (this.db.prepare("SELECT * FROM providers").all() as unknown as ProviderRow[]).map((row) => [row.id, row]),
    );
    const rows = this.db.prepare("SELECT * FROM models ORDER BY name").all() as unknown as ModelRow[];
    const records = this.records();
    const entries = rows.flatMap((row) => {
      const provider = providers.get(row.provider_id);
      return provider ? [this.toEntry(row, provider, records)] : [];
    });
    // Tier labels depend on every model: each is placed among the user's own.
    const labels = tierLabels(
      entries.map((entry) => ({ id: entry.id, ability: entry.ability.current.mean, label: entry.tierLabel })),
    );
    return entries.map((entry) => ({ ...entry, tier: labels.get(entry.id) ?? "T2" }));
  }

  getModel(id: number): ModelEntry {
    this.modelRow(id);
    return this.listModels().find((entry) => entry.id === id) as ModelEntry;
  }

  createModel(input: ModelInput): ModelEntry {
    const data = ModelInput.parse(input);
    this.providerRow(data.providerId);
    const now = nowIso();
    try {
      const result = this.db
        .prepare(
          `INSERT INTO models (provider_id, name, model_id, canonical_id, context_window, structured_mode, temperature,
             price_in_per_mtok, price_out_per_mtok, price_cache_read_per_mtok, tier_label, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          data.providerId,
          data.name || data.modelId,
          data.modelId,
          data.canonicalId,
          data.contextWindow,
          data.structuredMode,
          data.temperature,
          data.priceInPerMTok,
          data.priceOutPerMTok,
          data.priceCacheReadPerMTok,
          data.tierLabel,
          now,
          now,
        );
      const id = Number(result.lastInsertRowid);
      // The first model becomes the router so a fresh install works with one model.
      if (this.getRoles().router === null) this.setRoles({ ...this.getRoles(), router: id });
      return this.getModel(id);
    } catch (error) {
      throw uniqueNameError(error, "models") ?? error;
    }
  }

  updateModel(id: number, input: ModelInput): ModelEntry {
    const existing = this.modelRow(id);
    const data = ModelInput.parse(input);
    this.providerRow(data.providerId);
    // A different model or provider invalidates a previously detected mode.
    const endpointChanged = existing.model_id !== data.modelId || existing.provider_id !== data.providerId;
    const mode = endpointChanged && data.structuredMode === existing.structured_mode ? "auto" : data.structuredMode;
    try {
      this.db
        .prepare(
          `UPDATE models SET provider_id = ?, name = ?, model_id = ?, canonical_id = ?, context_window = ?,
             structured_mode = ?, temperature = ?, price_in_per_mtok = ?, price_out_per_mtok = ?,
             price_cache_read_per_mtok = ?, tier_label = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          data.providerId,
          data.name || data.modelId,
          data.modelId,
          data.canonicalId,
          data.contextWindow,
          mode,
          data.temperature,
          data.priceInPerMTok,
          data.priceOutPerMTok,
          data.priceCacheReadPerMTok,
          data.tierLabel,
          nowIso(),
          id,
        );
    } catch (error) {
      throw uniqueNameError(error, "models") ?? error;
    }
    return this.getModel(id);
  }

  deleteModel(id: number): void {
    this.modelRow(id);
    this.db.prepare("DELETE FROM models WHERE id = ?").run(id);
    this.clearRoles([id]);
  }

  setStructuredMode(id: number, mode: StructuredMode): void {
    this.db.prepare("UPDATE models SET structured_mode = ?, updated_at = ? WHERE id = ?").run(mode, nowIso(), id);
  }

  /** A model with its provider's endpoint and decrypted key, for an outgoing call. */
  resolveProfile(id: number): ResolvedProfile {
    const row = this.modelRow(id);
    const provider = this.providerRow(row.provider_id);
    const entry = this.toEntry(row, provider);
    return {
      id: row.id,
      name: row.name,
      provider: provider.kind,
      baseUrl: provider.base_url,
      model: row.model_id,
      apiKey: provider.api_key_encrypted ? this.decrypt(provider.api_key_encrypted, provider.name) : null,
      structuredMode: row.structured_mode,
      temperature: row.temperature,
      priceInPerMTok: entry.effective.input,
      priceOutPerMTok: entry.effective.output,
    };
  }

  /** The model serving a role; the planner falls back to the router. */
  profileForRole(role: LlmRole): ResolvedProfile {
    const roles = this.getRoles();
    const id = role === "planner" ? (roles.planner ?? roles.router) : roles.router;
    if (id === null) throw new AppError("config", "No model is configured yet. Add one in Settings → Models.");
    return this.resolveProfile(id);
  }

  getRoles(): RoleAssignment {
    return { router: this.readRole("router"), planner: this.readRole("planner") };
  }

  setRoles(roles: RoleAssignment): RoleAssignment {
    for (const role of ["router", "planner"] as const) {
      const id = roles[role];
      if (id !== null) this.modelRow(id);
      this.writePreference(ROLE_KEYS[role], id === null ? null : String(id));
    }
    return this.getRoles();
  }

  getPreferences(): Preferences {
    const raw = this.readPreference("ui");
    const parsed = raw ? Preferences.safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? parsed.data : DEFAULT_PREFERENCES;
  }

  setPreferences(partial: Partial<Preferences>): Preferences {
    const next = Preferences.parse({ ...this.getPreferences(), ...partial });
    this.writePreference("ui", JSON.stringify(next));
    return next;
  }

  /** Tier rules for routing: imported from a KM0 Runner calibration, or KM0's defaults. */
  getRoutingRules(): RoutingRulesState {
    const raw = this.readPreference("routing_rules");
    const parsed = raw ? RoutingRules.safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? { rules: parsed.data, custom: true } : { rules: DEFAULT_ROUTING_RULES, custom: false };
  }

  /** Store imported rules; null goes back to the defaults. */
  setRoutingRules(rules: RoutingRules | null): RoutingRulesState {
    this.writePreference("routing_rules", rules === null ? null : JSON.stringify(RoutingRules.parse(rules)));
    return this.getRoutingRules();
  }

  recordCall(record: LlmCallRecord): void {
    this.db
      .prepare(
        `INSERT INTO llm_calls (project_id, profile_id, model, purpose, mode, attempt, input_tokens, output_tokens,
           cost_usd, latency_ms, error_kind, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.projectId,
        record.profileId,
        record.model,
        record.purpose,
        record.mode,
        record.attempt,
        record.inputTokens,
        record.outputTokens,
        record.costUsd,
        record.latencyMs,
        record.error?.kind ?? null,
        record.error?.message ?? null,
        nowIso(),
      );
  }

  /**
   * Subscriptions past their quota, judged from KM0's own calls in the quota's window: what a run
   * costs then (per token, at the official price), or that the model is unavailable until it resets.
   * Runs of coding agents count once KM0 starts them itself.
   */
  pastQuota(): (model: TierModel) => EffectivePrice | "unavailable" | null {
    const past = new Map<number, "token" | "unavailable">();
    const providers = this.db.prepare("SELECT * FROM providers").all() as unknown as ProviderRow[];
    const now = Date.now();
    for (const provider of providers) {
      const billing = parseBilling(provider.billing_json);
      if (billing.mode !== "subscription" || !billing.quota) continue;
      const since = new Date(now - WINDOW_MS[billing.quota.window]).toISOString();
      const calls = this.db
        .prepare(
          `SELECT c.input_tokens AS input, c.output_tokens AS output, c.profile_id AS model FROM llm_calls c
           JOIN models m ON m.id = c.profile_id WHERE m.provider_id = ? AND c.created_at >= ?`,
        )
        .all(provider.id, since) as { input: number; output: number; model: number }[];
      let used = 0;
      if (billing.quota.unit === "requests") used = calls.length;
      else if (billing.quota.unit === "tokens") used = calls.reduce((sum, call) => sum + call.input + call.output, 0);
      else {
        const prices = new Map<number, EffectivePrice>();
        for (const call of calls) {
          let price = prices.get(call.model);
          if (!price) {
            price = this.tokenPrice(this.modelRow(call.model));
            prices.set(call.model, price);
          }
          used += (call.input * (price.input ?? 0) + call.output * (price.output ?? 0)) / 1e6;
        }
      }
      if (used >= billing.quota.amount) past.set(provider.id, billing.overflow);
    }
    return (model) => {
      const overflow = past.get(model.providerId);
      if (!overflow) return null;
      return overflow === "unavailable" ? "unavailable" : this.tokenPrice(this.modelRow(model.modelRef));
    };
  }

  /** The model's price per token as if its provider charged per token: past a subscription's quota. */
  private tokenPrice(row: ModelRow): EffectivePrice {
    const registry = this.registry();
    const match = row.canonical_id
      ? { canonicalId: row.canonical_id }
      : matchRegistryModel(registry, row.model_id, row.name);
    const known = match.canonicalId ? registry.models.find((model) => model.id === match.canonicalId) : undefined;
    return effectivePrice(
      { mode: "token" },
      {
        priceInPerMTok: row.price_in_per_mtok,
        priceOutPerMTok: row.price_out_per_mtok,
        priceCacheReadPerMTok: row.price_cache_read_per_mtok,
      },
      known?.pricing ?? null,
    );
  }

  private toEntry(row: ModelRow, provider: ProviderRow, records: RunRecord[] = this.records()): ModelEntry {
    const registry = this.registry();
    const match = row.canonical_id
      ? { canonicalId: row.canonical_id, problem: null, candidates: [] as string[] }
      : matchRegistryModel(registry, row.model_id, row.name);
    const known = match.canonicalId ? registry.models.find((model) => model.id === match.canonicalId) : undefined;
    return {
      id: row.id,
      providerId: provider.id,
      providerName: provider.name,
      providerKind: provider.kind,
      modelId: row.model_id,
      name: row.name,
      canonicalId: match.canonicalId,
      canonicalSource: row.canonical_id ? "manual" : match.canonicalId ? "auto" : null,
      matchProblem: match.problem,
      matchCandidates: match.candidates,
      vendor: known?.vendor ?? match.canonicalId?.split("/")[0] ?? null,
      contextWindow: row.context_window ?? known?.contextWindow ?? null,
      contextWindowOverride: row.context_window,
      structuredMode: row.structured_mode,
      temperature: row.temperature,
      priceInPerMTok: row.price_in_per_mtok,
      priceOutPerMTok: row.price_out_per_mtok,
      priceCacheReadPerMTok: row.price_cache_read_per_mtok,
      effective: effectivePrice(
        parseBilling(provider.billing_json),
        {
          priceInPerMTok: row.price_in_per_mtok,
          priceOutPerMTok: row.price_out_per_mtok,
          priceCacheReadPerMTok: row.price_cache_read_per_mtok,
        },
        known?.pricing ?? null,
      ),
      tier: row.tier_label ?? "T2",
      tierLabel: row.tier_label,
      ability: modelAbility(
        registry,
        { id: row.id, canonicalId: match.canonicalId, priceOutPerMTok: row.price_out_per_mtok },
        records,
      ),
      // A local endpoint may need no key; a hosted one without a key cannot be called by KM0.
      callable: provider.api_key_encrypted !== null || provider.base_url !== null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private decrypt(encrypted: string, owner: string): string {
    try {
      return this.secrets.decrypt(encrypted);
    } catch (error) {
      throw new AppError("config", `The API key of "${owner}" cannot be decrypted on this device; enter it again.`, {
        cause: error,
      });
    }
  }

  private clearRoles(modelIds: number[]): void {
    const roles = this.getRoles();
    this.setRoles({
      router: roles.router !== null && modelIds.includes(roles.router) ? null : roles.router,
      planner: roles.planner !== null && modelIds.includes(roles.planner) ? null : roles.planner,
    });
  }

  private providerRow(id: number): ProviderRow {
    const row = this.db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as ProviderRow | undefined;
    if (!row) throw new AppError("not_found", `Provider ${id} does not exist.`);
    return row;
  }

  private modelRow(id: number): ModelRow {
    const row = this.db.prepare("SELECT * FROM models WHERE id = ?").get(id) as ModelRow | undefined;
    if (!row) throw new AppError("not_found", `Model ${id} does not exist.`);
    return row;
  }

  private readRole(role: LlmRole): number | null {
    const value = this.readPreference(ROLE_KEYS[role]);
    return value === null ? null : Number(value);
  }

  private readPreference(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM preferences WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private writePreference(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare("DELETE FROM preferences WHERE key = ?").run(key);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }
}

function uniqueNameError(error: unknown, table: "providers" | "models"): AppError | null {
  if (error instanceof Error && new RegExp(`UNIQUE constraint failed: ${table}\\.name`).test(error.message)) {
    return new AppError(
      "conflict",
      table === "providers" ? "A provider with this name already exists." : "A model with this name already exists.",
    );
  }
  return null;
}

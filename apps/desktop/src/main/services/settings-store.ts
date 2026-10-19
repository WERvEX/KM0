import { DEFAULT_ROUTING_RULES, type LlmCallRecord, type ResolvedProfile } from "@km0/core";
import {
  AppError,
  DEFAULT_PREFERENCES,
  type LlmProfile,
  LlmProfileInput,
  type LlmRole,
  Preferences,
  type RoleAssignment,
  RoutingRules,
  type RoutingRulesState,
  type StructuredMode,
} from "@km0/shared";
import { type Database, nowIso } from "../db/sql";
import { keyHint, type SecretStore } from "./secrets";

interface ProfileRow {
  id: number;
  name: string;
  provider: "openai" | "anthropic";
  base_url: string | null;
  model: string;
  api_key_encrypted: string | null;
  api_key_hint: string | null;
  structured_mode: StructuredMode;
  temperature: number | null;
  price_in_per_mtok: number | null;
  price_out_per_mtok: number | null;
  created_at: string;
  updated_at: string;
}

function toProfile(row: ProfileRow): LlmProfile {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    structuredMode: row.structured_mode,
    temperature: row.temperature,
    priceInPerMTok: row.price_in_per_mtok,
    priceOutPerMTok: row.price_out_per_mtok,
    hasApiKey: row.api_key_encrypted !== null,
    apiKeyHint: row.api_key_hint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ROLE_KEYS: Record<LlmRole, string> = { router: "role.router", planner: "role.planner" };

/** Model profiles, role assignment and UI preferences. API keys never leave this class in plain text except via `resolveProfile`. */
export class SettingsStore {
  constructor(
    private readonly db: Database,
    private readonly secrets: SecretStore,
  ) {}

  listProfiles(): LlmProfile[] {
    const rows = this.db.prepare("SELECT * FROM llm_profiles ORDER BY id").all() as unknown as ProfileRow[];
    return rows.map(toProfile);
  }

  getProfile(id: number): LlmProfile {
    return toProfile(this.row(id));
  }

  createProfile(input: LlmProfileInput): LlmProfile {
    const data = LlmProfileInput.parse(input);
    const now = nowIso();
    const key = data.apiKey?.trim() ? data.apiKey.trim() : null;
    try {
      const result = this.db
        .prepare(
          `INSERT INTO llm_profiles (name, provider, base_url, model, api_key_encrypted, api_key_hint, structured_mode,
             temperature, price_in_per_mtok, price_out_per_mtok, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          data.name,
          data.provider,
          data.baseUrl,
          data.model,
          key ? this.secrets.encrypt(key) : null,
          key ? keyHint(key) : null,
          data.structuredMode,
          data.temperature,
          data.priceInPerMTok,
          data.priceOutPerMTok,
          now,
          now,
        );
      const id = Number(result.lastInsertRowid);
      // The first profile becomes the router so a fresh install works with one model.
      if (this.getRoles().router === null) this.setRoles({ ...this.getRoles(), router: id });
      return this.getProfile(id);
    } catch (error) {
      throw uniqueNameError(error) ?? error;
    }
  }

  /** `apiKey` omitted keeps the stored key; an empty string removes it. */
  updateProfile(id: number, input: LlmProfileInput): LlmProfile {
    const existing = this.row(id);
    const data = LlmProfileInput.parse(input);
    let encrypted = existing.api_key_encrypted;
    let hint = existing.api_key_hint;
    if (data.apiKey !== undefined) {
      const key = data.apiKey.trim();
      encrypted = key ? this.secrets.encrypt(key) : null;
      hint = key ? keyHint(key) : null;
    }
    // Changing the endpoint or model invalidates a previously detected mode.
    const endpointChanged =
      existing.provider !== data.provider || existing.base_url !== data.baseUrl || existing.model !== data.model;
    const mode = endpointChanged && data.structuredMode === existing.structured_mode ? "auto" : data.structuredMode;
    try {
      this.db
        .prepare(
          `UPDATE llm_profiles SET name = ?, provider = ?, base_url = ?, model = ?, api_key_encrypted = ?, api_key_hint = ?,
             structured_mode = ?, temperature = ?, price_in_per_mtok = ?, price_out_per_mtok = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          data.name,
          data.provider,
          data.baseUrl,
          data.model,
          encrypted,
          hint,
          mode,
          data.temperature,
          data.priceInPerMTok,
          data.priceOutPerMTok,
          nowIso(),
          id,
        );
    } catch (error) {
      throw uniqueNameError(error) ?? error;
    }
    return this.getProfile(id);
  }

  deleteProfile(id: number): void {
    this.row(id);
    this.db.prepare("DELETE FROM llm_profiles WHERE id = ?").run(id);
    const roles = this.getRoles();
    this.setRoles({
      router: roles.router === id ? null : roles.router,
      planner: roles.planner === id ? null : roles.planner,
    });
  }

  setStructuredMode(id: number, mode: StructuredMode): void {
    this.db.prepare("UPDATE llm_profiles SET structured_mode = ?, updated_at = ? WHERE id = ?").run(mode, nowIso(), id);
  }

  /** Decrypts the key for an outgoing model call. */
  resolveProfile(id: number): ResolvedProfile {
    const row = this.row(id);
    let apiKey: string | null = null;
    if (row.api_key_encrypted) {
      try {
        apiKey = this.secrets.decrypt(row.api_key_encrypted);
      } catch (error) {
        throw new AppError(
          "config",
          `The API key of "${row.name}" cannot be decrypted on this device; enter it again.`,
          {
            cause: error,
          },
        );
      }
    }
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      baseUrl: row.base_url,
      model: row.model,
      apiKey,
      structuredMode: row.structured_mode,
      temperature: row.temperature,
      priceInPerMTok: row.price_in_per_mtok,
      priceOutPerMTok: row.price_out_per_mtok,
    };
  }

  /** The profile serving a role; the planner falls back to the router. */
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
      if (id !== null) this.row(id);
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

  private row(id: number): ProfileRow {
    const row = this.db.prepare("SELECT * FROM llm_profiles WHERE id = ?").get(id) as ProfileRow | undefined;
    if (!row) throw new AppError("not_found", `Model profile ${id} does not exist.`);
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

function uniqueNameError(error: unknown): AppError | null {
  if (error instanceof Error && /UNIQUE constraint failed: llm_profiles\.name/.test(error.message)) {
    return new AppError("conflict", "A model profile with this name already exists.");
  }
  return null;
}

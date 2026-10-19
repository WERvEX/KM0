import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../db/database";
import { migrations } from "../db/migrations";
import { PlainSecretStore } from "./secrets";
import { SettingsStore } from "./settings-store";

function store() {
  const db = openDatabase(":memory:");
  return { db, settings: new SettingsStore(db, new PlainSecretStore()) };
}

const base = {
  name: "DeepSeek",
  provider: "openai" as const,
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
};

describe("database", () => {
  it("applies migrations once", () => {
    const { db } = store();
    migrate(db, migrations);
    const rows = db.prepare("SELECT id FROM schema_migrations").all();
    expect(rows).toHaveLength(migrations.length);
  });
});

describe("SettingsStore", () => {
  it("stores the key encrypted and only exposes a hint", () => {
    const { db, settings } = store();
    const profile = settings.createProfile({ ...base, apiKey: "sk-1234567890abcd" });
    expect(profile).toMatchObject({ hasApiKey: true, apiKeyHint: "••••abcd", structuredMode: "auto" });
    expect(JSON.stringify(profile)).not.toContain("sk-1234567890abcd");
    const raw = db.prepare("SELECT api_key_encrypted FROM llm_profiles").get() as { api_key_encrypted: string };
    expect(raw.api_key_encrypted).not.toContain("sk-1234567890abcd");
    expect(settings.resolveProfile(profile.id).apiKey).toBe("sk-1234567890abcd");
  });

  it("makes the first profile the router and lets the planner fall back to it", () => {
    const { settings } = store();
    const first = settings.createProfile(base);
    settings.createProfile({ ...base, name: "Second" });
    expect(settings.getRoles()).toEqual({ router: first.id, planner: null });
    expect(settings.profileForRole("planner").id).toBe(first.id);
  });

  it("keeps the key when an update omits it and removes it on an empty string", () => {
    const { settings } = store();
    const profile = settings.createProfile({ ...base, apiKey: "sk-keep-this-key" });
    settings.updateProfile(profile.id, { ...base, name: "Renamed" });
    expect(settings.resolveProfile(profile.id).apiKey).toBe("sk-keep-this-key");
    settings.updateProfile(profile.id, { ...base, apiKey: "" });
    expect(settings.getProfile(profile.id).hasApiKey).toBe(false);
  });

  it("resets a detected mode when the model changes", () => {
    const { settings } = store();
    const profile = settings.createProfile(base);
    settings.setStructuredMode(profile.id, "tool");
    const updated = settings.updateProfile(profile.id, { ...base, model: "deepseek-reasoner", structuredMode: "tool" });
    expect(updated.structuredMode).toBe("auto");
  });

  it("rejects duplicate names as a conflict", () => {
    const { settings } = store();
    settings.createProfile(base);
    expect(() => settings.createProfile(base)).toThrow(expect.objectContaining({ kind: "conflict" }));
  });

  it("clears role assignments when a profile is deleted", () => {
    const { settings } = store();
    const profile = settings.createProfile(base);
    settings.setRoles({ router: profile.id, planner: profile.id });
    settings.deleteProfile(profile.id);
    expect(settings.getRoles()).toEqual({ router: null, planner: null });
    expect(() => settings.profileForRole("router")).toThrow(expect.objectContaining({ kind: "config" }));
  });

  it("merges preference updates", () => {
    const { settings } = store();
    expect(settings.getPreferences()).toEqual({ language: "system", theme: "system" });
    expect(settings.setPreferences({ language: "en" })).toEqual({ language: "en", theme: "system" });
  });

  it("records model calls", () => {
    const { db, settings } = store();
    const profile = settings.createProfile(base);
    settings.recordCall({
      profileId: profile.id,
      model: "deepseek-chat",
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

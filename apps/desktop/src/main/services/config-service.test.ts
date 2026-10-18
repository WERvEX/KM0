import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database";
import { AgentStore } from "./agent-store";
import { ConfigService } from "./config-service";
import { SearchStore } from "./search-store";
import { PlainSecretStore } from "./secrets";
import { SettingsStore } from "./settings-store";

function install() {
  const db = openDatabase(":memory:");
  const secrets = new PlainSecretStore();
  const settings = new SettingsStore(db, secrets);
  const agents = new AgentStore(db);
  const search = new SearchStore(db, secrets, {});
  return {
    settings,
    agents,
    search,
    config: new ConfigService(settings, agents, search, () => "2026-10-18T00:00:00Z"),
  };
}

function configured() {
  const app = install();
  const router = app.settings.createProfile({
    name: "Fast",
    provider: "openai",
    model: "m1",
    apiKey: "sk-fast-123456",
  });
  const planner = app.settings.createProfile({ name: "Strong", provider: "anthropic", model: "claude-opus-5-5" });
  app.settings.setRoles({ router: router.id, planner: planner.id });
  app.settings.setPreferences({ language: "en", theme: "dark" });
  app.agents.update("codex", false, {
    T1: null,
    T2: { modelId: "gpt-x", priceInPerMTok: 1, priceOutPerMTok: 4 },
    T3: null,
  });
  app.agents.move("zcode", "up");
  app.search.create({ name: "Bocha", config: { kind: "bocha" }, secret: "sk-bocha-999999" });
  return app;
}

describe("ConfigService", () => {
  it("leaves keys out unless asked", () => {
    const { config } = configured();
    const plain = config.export(false);
    expect(JSON.stringify(plain)).not.toContain("sk-");
    expect(plain).toMatchObject({ format: "km0-config", version: 1, includesSecrets: false });
    expect(plain.roles).toEqual({ router: "Fast", planner: "Strong" });

    const full = config.export(true);
    expect(full.profiles.find((profile) => profile.name === "Fast")?.apiKey).toBe("sk-fast-123456");
    expect(full.searchServices[0]?.secret).toBe("sk-bocha-999999");
  });

  it("restores everything on a fresh install", () => {
    const source = configured();
    const bundle = source.config.export(true);
    const target = install();
    const summary = target.config.import(bundle);
    expect(summary).toEqual({
      profilesCreated: 2,
      profilesUpdated: 0,
      searchCreated: 1,
      searchUpdated: 0,
      agentsUpdated: 7,
      rolesSet: true,
    });
    const names = (id: number | null) => target.settings.listProfiles().find((profile) => profile.id === id)?.name;
    const roles = target.settings.getRoles();
    expect([names(roles.router), names(roles.planner)]).toEqual(["Fast", "Strong"]);
    expect(target.settings.getPreferences()).toEqual({ language: "en", theme: "dark" });
    expect(target.agents.list().map((agent) => agent.id)).toEqual(source.agents.list().map((agent) => agent.id));
    expect(target.agents.list().find((agent) => agent.id === "codex")).toMatchObject({
      enabled: false,
      models: { T2: { modelId: "gpt-x", priceInPerMTok: 1, priceOutPerMTok: 4 } },
    });
    expect(target.search.list()[0]).toMatchObject({ name: "Bocha", hasSecret: true });
    expect(target.config.export(true)).toEqual(bundle);
  });

  it("merges by name and keeps stored keys when the file has none", () => {
    const app = configured();
    const bundle = app.config.export(false);
    const fast = bundle.profiles.find((profile) => profile.name === "Fast");
    if (fast) fast.model = "m2";
    const summary = app.config.import(bundle);
    expect(summary).toMatchObject({ profilesCreated: 0, profilesUpdated: 2, searchCreated: 0, searchUpdated: 1 });
    const profile = app.settings.listProfiles().find((item) => item.name === "Fast");
    expect(profile).toMatchObject({ model: "m2", hasApiKey: true });
    expect(app.search.list()[0]?.hasSecret).toBe(true);
  });
});

import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSimulatedLlm } from "@km0/core";
import bundledRegistry from "@km0/registry/model-registry.json";
import { ModelRegistry } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { AgentStore } from "../services/agent-store";
import { latestDocument } from "../services/document-service";
import { HandoffService } from "../services/handoff-service";
import { ProjectService } from "../services/project-service";
import { RoutingService } from "../services/routing-service";
import { RunRecordStore } from "../services/run-records";
import { SearchStore } from "../services/search-store";
import { PlainSecretStore } from "../services/secrets";
import { SettingsStore } from "../services/settings-store";
import { openDatabase } from "./database";
import { migrations } from "./migrations";

/**
 * `fixtures/km0-0.1.0.db` was written by KM0 0.1.0's own code (the v0.1.0 tag): two model profiles with
 * keys and roles, a disabled Codex with a typed model, a search service, a full-path project with documents
 * and a routed plan carrying a tier override, a routed fast-path project and one still in discussion.
 */
const FIXTURE = join(import.meta.dirname, "fixtures", "km0-0.1.0.db");

function upgraded() {
  const dir = mkdtempSync(join(tmpdir(), "km0-upgrade-"));
  const path = join(dir, "km0.db");
  copyFileSync(FIXTURE, path);
  return { dir, path, db: openDatabase(path) };
}

describe("upgrading a KM0 0.1.0 database", () => {
  it("backs the old file up first, then applies every migration", () => {
    const { dir, db } = upgraded();
    const applied = (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map(
      (row) => row.id,
    );
    expect(applied).toEqual(migrations.map((migration) => migration.id));
    const backups = readdirSync(dir).filter((name) => name.endsWith(".bak"));
    expect(backups).toEqual([expect.stringMatching(/^km0\.db\.before-5-.+\.bak$/)]);
    // The backup is the 0.1.0 database as it was.
    const backup = new DatabaseSync(join(dir, backups[0] as string), { readOnly: true });
    expect(backup.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 5 });
    expect(backup.prepare("SELECT COUNT(*) AS n FROM llm_profiles").get()).toEqual({ n: 2 });
    backup.close();
    db.close();
  });

  it("keeps models, keys, roles, preferences, agents, search services and the call log", () => {
    const { db } = upgraded();
    const registry = ModelRegistry.parse(bundledRegistry);
    const secrets = new PlainSecretStore();
    const settings = new SettingsStore(db, secrets, () => registry);
    const providers = settings.listProviders();
    expect(providers.map((provider) => provider.name)).toEqual(expect.arrayContaining(["DeepSeek Flash", "Opus"]));
    const flash = providers.find((provider) => provider.name === "DeepSeek Flash");
    expect(settings.providerKey(flash?.id ?? 0)).toBe("sk-old-router-111111");
    expect(settings.profileForRole("router")).toMatchObject({
      model: "deepseek-v4-flash",
      apiKey: "sk-old-router-111111",
    });
    expect(settings.profileForRole("planner")).toMatchObject({
      model: "claude-opus-5-5",
      apiKey: "sk-ant-old-planner-222222",
      structuredMode: "json_schema",
    });
    expect(settings.getPreferences()).toMatchObject({ language: "en", theme: "dark" });
    const models = settings.listModels();
    expect(models.find((model) => model.modelId === "deepseek-v4-flash")).toMatchObject({
      canonicalId: "deepseek/deepseek-v4-flash",
      priceInPerMTok: 0.2,
    });
    expect(db.prepare("SELECT profile_id FROM llm_calls").get()).toEqual({
      profile_id: models.find((model) => model.modelId === "deepseek-v4-flash")?.id,
    });

    const agents = new AgentStore(db, () => settings.listModels());
    const list = agents.list();
    expect(list.slice(0, 2).map((agent) => agent.id)).toEqual(["claude_code", "cursor"]);
    expect(list.find((agent) => agent.id === "codex")).toMatchObject({
      enabled: false,
      models: [expect.objectContaining({ modelId: "gpt-6-sol", priceInPerMTok: 2 })],
    });
    expect(list.find((agent) => agent.id === "claude_code")?.models.map((model) => model.modelId)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
    ]);
    const search = new SearchStore(db, secrets, {});
    expect(search.list()).toEqual([expect.objectContaining({ name: "Bocha", hasSecret: true })]);
    db.close();
  });

  it("keeps projects, documents and plans, which route and hand off with the new strategy", async () => {
    const { db } = upgraded();
    const registry = ModelRegistry.parse(bundledRegistry);
    const settings = new SettingsStore(db, new PlainSecretStore(), () => registry);
    const agents = new AgentStore(db, () => settings.listModels());
    const llm = createSimulatedLlm();
    const language = () => "zh-CN" as const;
    const records = new RunRecordStore(db);
    const routing = new RoutingService(db, () => llm, language, agents, undefined, {
      registry: () => registry,
      records,
      pastQuota: () => undefined,
    });
    const projects = new ProjectService(db, () => llm, language).list();
    expect(projects).toHaveLength(3);
    const full = projects.find((project) => project.path === "full");
    expect(full?.stage).toBe("routing");
    expect(latestDocument(db, full?.id ?? 0, "prd")?.version).toBe(1);

    const plan = routing.get(full?.id ?? 0);
    expect(plan).toMatchObject({ level: 3, budget: null, outdated: false });
    expect(plan?.tasks).toHaveLength(3);
    // 0.1's override: T3 on Codex. Codex is disabled now as it was then, but a forced agent still takes it,
    // and the tier limits the choice to models labelled T3 when it has any.
    expect(plan?.tasks[0]).toMatchObject({ override: { tier: "T3", agent: "codex" }, agent: "codex" });
    expect(plan?.tasks[1]?.choice).not.toBeNull();

    const handoff = new HandoffService(db, routing, language).build(full?.id ?? 0, "runner");
    expect(handoff.tasks).toHaveLength(3);
    expect(handoff.files.some((file) => file.path === "km0/tasks.json")).toBe(true);
    db.close();
  });

  it("does not back up again when nothing is left to migrate", () => {
    const { dir, path, db } = upgraded();
    db.close();
    openDatabase(path).close();
    expect(readdirSync(dir).filter((name) => name.endsWith(".bak"))).toHaveLength(1);
  });
});

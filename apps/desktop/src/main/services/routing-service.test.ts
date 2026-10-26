import { createSimulatedLlm } from "@km0/core";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database";
import { AgentStore } from "./agent-store";
import { DocumentService } from "./document-service";
import { ProjectService } from "./project-service";
import { RoutingService } from "./routing-service";
import { PlainSecretStore } from "./secrets";
import { SettingsStore } from "./settings-store";

function setup() {
  const db = openDatabase(":memory:");
  const llm = createSimulatedLlm();
  const language = () => "zh-CN" as const;
  const settings = new SettingsStore(db, new PlainSecretStore());
  const agents = new AgentStore(db, () => settings.listModels());
  return {
    settings,
    agents,
    projects: new ProjectService(db, () => llm, language),
    documents: new DocumentService(
      db,
      () => llm,
      language,
      () => undefined,
    ),
    routing: new RoutingService(db, () => llm, language, agents),
  };
}

describe("agent catalog", () => {
  it("starts with every agent enabled in order and Claude Code's models filled in", () => {
    const { agents } = setup();
    const list = agents.list();
    expect(list.map((agent) => agent.id)).toEqual(["claude_code", "codex", "cursor", "pi", "dsh", "zcode", "generic"]);
    expect(list.every((agent) => agent.enabled)).toBe(true);
    expect(list[0]?.models).toMatchObject({
      T1: { modelId: "claude-haiku-5-5", priceInPerMTok: null, priceOutPerMTok: null },
      T2: { modelId: "claude-sonnet-5-5", priceInPerMTok: null, priceOutPerMTok: null },
      T3: { modelId: "claude-opus-5-5", priceInPerMTok: null, priceOutPerMTok: null },
    });
  });

  it("starts with what each agent is good at and saves changes to it", () => {
    const { agents } = setup();
    const capabilities = Object.fromEntries(agents.list().map((agent) => [agent.id, agent.capabilities]));
    expect(capabilities).toMatchObject({
      claude_code: ["backend", "debugging", "testing", "docs", "devops"],
      codex: ["backend", "testing"],
      cursor: ["frontend"],
      generic: [],
    });
    const codex = agents.list().find((agent) => agent.id === "codex");
    if (!codex) throw new Error("codex missing");
    const refs = { T1: null, T2: null, T3: null };
    const saved = agents.update("codex", true, refs, ["frontend", "frontend", "debugging"]);
    expect(saved.find((agent) => agent.id === "codex")?.capabilities).toEqual(["frontend", "debugging"]);
    // Leaving them out keeps what is stored.
    const kept = agents.update("codex", false, refs);
    expect(kept.find((agent) => agent.id === "codex")?.capabilities).toEqual(["frontend", "debugging"]);
  });

  it("saves models and prices, and reorders by swapping neighbours", () => {
    const { agents, settings } = setup();
    const provider = settings.createProvider({ name: "OpenAI", kind: "openai" });
    const gpt = settings.createModel({
      providerId: provider.id,
      modelId: "gpt-x",
      priceInPerMTok: 2,
      priceOutPerMTok: 8,
    });
    expect(
      agents.update("codex", false, { T1: null, T2: gpt.id, T3: null }).find((agent) => agent.id === "codex"),
    ).toMatchObject({
      enabled: false,
      models: { T1: null, T2: { modelRef: gpt.id, modelId: "gpt-x", priceInPerMTok: 2, priceOutPerMTok: 8 }, T3: null },
    });
    // Claude Code takes Anthropic-format providers only.
    expect(() => agents.update("claude_code", true, { T1: gpt.id, T2: null, T3: null })).toThrow(/anthropic/);
    expect(
      agents
        .move("codex", "up")
        .map((agent) => agent.id)
        .slice(0, 2),
    ).toEqual(["codex", "claude_code"]);
    expect(agents.move("codex", "up").map((agent) => agent.id)[0]).toBe("codex");
    expect(agents.move("generic", "down").at(-1)?.id).toBe("generic");
  });
});

describe("routing", () => {
  it("needs a finished discussion and written documents", async () => {
    const { projects, routing } = setup();
    let project = await projects.create("从零做一个团队内部的需求管理平台", null);
    await expect(routing.plan(project.id)).rejects.toMatchObject({ kind: "conflict" });
    for (let stage = 0; stage < 4; stage += 1) project = await projects.advance(project.id, true);
    await expect(routing.plan(project.id)).rejects.toMatchObject({
      kind: "conflict",
      message: "Write the documents before breaking the work into tasks.",
    });
    expect(routing.get(project.id)).toBeNull();
  });

  it("breaks the work into tasks, routes them by rules and follows overrides and the catalog", async () => {
    const { projects, documents, routing, agents, settings } = setup();
    let project = await projects.create("从零做一个团队内部的需求管理平台", null);
    for (let stage = 0; stage < 4; stage += 1) project = await projects.advance(project.id, true);
    await documents.generate(project.id, "prd", false);
    await documents.generate(project.id, "tech_design", false);

    let plan = await routing.plan(project.id);
    expect((await projects.get(project.id)).stage).toBe("routing");
    expect(plan.tasks.map((task) => [task.seq, task.tier, task.agent, task.model])).toEqual([
      [1, "T1", "claude_code", "claude-haiku-5-5"],
      [2, "T2", "claude_code", "claude-sonnet-5-5"],
      [3, "T3", "claude_code", "claude-opus-5-5"],
    ]);
    expect(plan.tasks[2]).toMatchObject({
      splitSuggested: true,
      dependsOn: [1, 2],
      sections: [
        { kind: "tech_design", sectionId: "data_model" },
        { kind: "tech_design", sectionId: "security" },
      ],
    });
    expect(plan.tierCounts).toEqual({ T1: 1, T2: 1, T3: 1 });
    // No prices yet, so nothing can be totalled.
    expect(plan.totals).toEqual({ cost: null, costAllT3: null, saving: null, unpriced: 3 });
    expect(plan).toMatchObject({
      outdated: false,
      basedOn: [
        { kind: "prd", version: 1 },
        { kind: "tech_design", version: 1 },
      ],
    });

    const provider = settings.createProvider({ name: "Anthropic", kind: "anthropic" });
    const price = (modelId: string, input: number, output: number) =>
      settings.createModel({
        providerId: provider.id,
        modelId,
        name: `${modelId} priced`,
        priceInPerMTok: input,
        priceOutPerMTok: output,
      }).id;
    agents.update("claude_code", true, {
      T1: price("claude-haiku-5-5", 1, 5),
      T2: price("claude-sonnet-5-5", 3, 15),
      T3: price("claude-opus-5-5", 5, 25),
    });
    plan = routing.get(project.id) ?? plan;
    expect(plan.totals.unpriced).toBe(0);
    expect(plan.totals.saving).toBeGreaterThan(0);
    expect(plan.totals.saving).toBeLessThan(1);

    const first = plan.tasks[0]?.id ?? 0;
    plan = await routing.override(project.id, first, { tier: "T3", agent: "codex" });
    expect(plan.tasks[0]).toMatchObject({ ruleTier: "T1", tier: "T3", agent: "codex", model: null, cost: null });
    expect(plan.totals.unpriced).toBe(1);
    plan = await routing.override(project.id, first, null);
    expect(plan.tasks[0]).toMatchObject({ tier: "T1", agent: "claude_code", override: null });
    await expect(routing.override(project.id, 999, null)).rejects.toMatchObject({ kind: "not_found" });

    // Two failed runs on T1 lift the task to T2; clearing them puts it back.
    plan = await routing.recordFailure(project.id, first);
    expect(plan.tasks[0]).toMatchObject({ tier: "T1", failures: [{ tier: "T1" }], escalatedFrom: null });
    plan = await routing.recordFailure(project.id, first);
    expect(plan.tasks[0]).toMatchObject({ tier: "T2", escalatedFrom: "T1", model: "claude-sonnet-5-5" });
    plan = await routing.recordFailure(project.id, first);
    expect(plan.tasks[0]?.failures.map((failure) => failure.tier)).toEqual(["T1", "T1", "T2"]);
    plan = await routing.clearFailures(project.id, first);
    expect(plan.tasks[0]).toMatchObject({ tier: "T1", failures: [], escalatedFrom: null });
    await expect(routing.recordFailure(project.id, 999)).rejects.toMatchObject({ kind: "not_found" });

    // A newer document version makes the plan worth redoing.
    await documents.generate(project.id, "prd", false);
    expect(routing.get(project.id)?.outdated).toBe(true);
    plan = await routing.plan(project.id);
    expect(plan.outdated).toBe(false);
  });

  it("plans the fast path straight from its decisions", async () => {
    const { projects, routing } = setup();
    let project = await projects.create("修复登录页按钮上的错别字", null);
    project = await projects.advance(project.id, true);
    expect(project.stage).toBe("routing");
    const plan = await routing.plan(project.id);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({ tier: "T1", agent: "claude_code" });
    expect(plan.basedOn).toEqual([]);
  });
});

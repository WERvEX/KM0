import type { AgentConfig, TaskFailure, TaskFeatures, Tier } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { createSimulatedLlm } from "../discussion/simulator";
import { breakDown } from "./breakdown";
import {
  chooseAgent,
  estimateCost,
  estimateTokens,
  planTotals,
  routeTask,
  type TaskBasics,
  taskCapability,
} from "./route";
import { DEFAULT_ROUTING_RULES, decideTier, escalateTier } from "./scoring";

/** Scores 0: one file, clear, do as written, little context, covered by tests. */
const base: TaskFeatures = {
  scope: "single_file",
  ambiguity: "low",
  reasoning: "follow",
  context: "small",
  hasTests: true,
  risks: [],
  kind: "code",
};
const tierOf = (overrides: Partial<TaskFeatures>) => decideTier({ ...base, ...overrides }, "zh-CN");

describe("score", () => {
  it.each([
    [{}, 0],
    [{ scope: "few_files" }, 1],
    [{ scope: "many_files" }, 2],
    [{ scope: "new_subsystem" }, 3],
    [{ ambiguity: "medium" }, 1],
    [{ ambiguity: "high" }, 2],
    [{ reasoning: "judgement" }, 1],
    [{ context: "large" }, 1],
    [{ hasTests: false }, 1],
  ] as [Partial<TaskFeatures>, number][])("counts %o as %i", (overrides, score) => {
    expect(tierOf(overrides).score).toBe(score);
  });

  it("puts 0-2 on T1, 3-5 on T2 and 6 or more on T3", () => {
    expect(tierOf({ scope: "many_files" })).toMatchObject({ score: 2, tier: "T1" });
    expect(tierOf({ scope: "many_files", hasTests: false })).toMatchObject({ score: 3, tier: "T2" });
    expect(tierOf({ scope: "new_subsystem", ambiguity: "high" })).toMatchObject({ score: 5, tier: "T2" });
    expect(tierOf({ scope: "new_subsystem", ambiguity: "high", context: "large" })).toMatchObject({
      score: 6,
      tier: "T3",
    });
  });

  it("explains the score with the factors that added points", () => {
    expect(tierOf({ scope: "few_files", hasTests: false }).reasons).toEqual([
      "总分 2 → T1：改 2–5 个文件 +1，没有现成测试 +1",
    ]);
    expect(decideTier(base, "en").reasons).toEqual(["score 0 → T1: —"]);
  });

  it("uses imported points and limits in place of the defaults", () => {
    const rules = {
      featurePoints: { ...DEFAULT_ROUTING_RULES.featurePoints, hasTests: { true: 0, false: 3 } },
      tierLimits: { T1: 1, T2: 3 },
    };
    expect(decideTier({ ...base, scope: "many_files" }, "zh-CN", rules)).toMatchObject({ score: 2, tier: "T2" });
    expect(decideTier({ ...base, hasTests: false }, "zh-CN", rules)).toMatchObject({ score: 3, tier: "T2" });
    expect(decideTier({ ...base, hasTests: false, context: "large" }, "zh-CN", rules).tier).toBe("T3");
    expect(decideTier({ ...base, reasoning: "design" }, "zh-CN", rules).tier).toBe("T3");
  });
});

describe("hard rules", () => {
  it("sends docs and boilerplate in at most 5 files to T1 whatever the score", () => {
    const heavy = { scope: "few_files", ambiguity: "high", context: "large", hasTests: false } as const;
    expect(tierOf(heavy).tier).toBe("T2");
    expect(tierOf({ ...heavy, kind: "docs" })).toMatchObject({ score: 5, tier: "T1" });
    expect(tierOf({ ...heavy, kind: "boilerplate" }).tier).toBe("T1");
    // More than 5 files is not cheap any more.
    expect(tierOf({ ...heavy, scope: "many_files", kind: "docs" }).tier).toBe("T3");
  });

  it("lifts any risky task to at least T2, without lowering a T3", () => {
    expect(tierOf({ risks: ["security"] }).tier).toBe("T2");
    expect(tierOf({ risks: ["data_migration"] }).tier).toBe("T2");
    expect(tierOf({ risks: ["production"], kind: "docs" }).tier).toBe("T2");
    expect(tierOf({ risks: ["security"], scope: "new_subsystem", ambiguity: "high", context: "large" }).tier).toBe(
      "T3",
    );
    expect(tierOf({ risks: ["security", "security", "production"] }).reasons.at(-1)).toBe(
      "有风险（安全、生产环境）→ 至少 T2",
    );
  });

  it("sends design work to T3, even for docs", () => {
    expect(tierOf({ reasoning: "design" })).toMatchObject({ score: 3, tier: "T3" });
    expect(tierOf({ reasoning: "design", kind: "docs" }).tier).toBe("T3");
  });

  it("lifts debugging and bug fixes to at least T2, even small ones", () => {
    expect(tierOf({ kind: "fix" })).toMatchObject({ score: 0, tier: "T2" });
    expect(tierOf({ kind: "fix" }).reasons.at(-1)).toBe("调试和修复 bug → 至少 T2");
    expect(tierOf({ kind: "fix", reasoning: "design" }).tier).toBe("T3");
    expect(tierOf({ kind: "fix", scope: "new_subsystem", ambiguity: "high", context: "large" }).tier).toBe("T3");
  });

  it("suggests splitting new subsystems and tasks scoring 8 or more", () => {
    expect(tierOf({ scope: "new_subsystem" }).splitSuggested).toBe(true);
    // Scaffolding a new app creates many files in one step; there is nothing to split.
    expect(tierOf({ scope: "new_subsystem", kind: "boilerplate" }).splitSuggested).toBe(false);
    const busy = { scope: "many_files", ambiguity: "high", reasoning: "design" } as const;
    expect(tierOf(busy)).toMatchObject({ score: 7, splitSuggested: false });
    expect(tierOf({ ...busy, context: "large" })).toMatchObject({ score: 8, splitSuggested: true });
  });
});

const priced = (modelId: string, input: number, output: number) => ({
  modelId,
  priceInPerMTok: input,
  priceOutPerMTok: output,
});

const agents: AgentConfig[] = [
  {
    id: "codex",
    enabled: true,
    preference: 1,
    models: { T1: null, T2: priced("codex-mid", 2, 8), T3: priced("codex-max", 10, 40) },
    capabilities: ["frontend", "testing"],
  },
  {
    id: "claude_code",
    enabled: true,
    preference: 0,
    models: { T1: priced("claude-haiku-5-5", 1, 5), T2: null, T3: priced("claude-opus-5-5", 5, 25) },
    capabilities: ["backend", "debugging"],
  },
  {
    id: "cursor",
    enabled: false,
    preference: 2,
    models: { T1: null, T2: priced("x", 1, 1), T3: null },
    capabilities: ["frontend"],
  },
];

describe("agents", () => {
  it("takes the first enabled agent, by preference, that has a model for the tier", () => {
    expect(chooseAgent(agents, "T1", "zh-CN")).toMatchObject({
      agent: "claude_code",
      model: { modelId: "claude-haiku-5-5" },
    });
    expect(chooseAgent(agents, "T2", "zh-CN")).toMatchObject({ agent: "codex", model: { modelId: "codex-mid" } });
  });

  it("falls back to the first enabled agent without a model, and to generic when none is enabled", () => {
    const noT2 = agents.map((agent) => ({ ...agent, models: { ...agent.models, T2: null } }));
    expect(chooseAgent(noT2, "T2", "zh-CN")).toMatchObject({ agent: "claude_code", model: null });
    const disabled = agents.map((agent) => ({ ...agent, enabled: false }));
    expect(chooseAgent(disabled, "T2", "zh-CN")).toMatchObject({ agent: "generic", model: null });
  });
});

describe("capabilities", () => {
  it("reads what a task needs from its kind, and for code from its files", () => {
    expect(taskCapability({ ...base, kind: "fix" }, [])).toBe("debugging");
    expect(taskCapability({ ...base, kind: "test" }, ["src/App.tsx"])).toBe("testing");
    expect(taskCapability({ ...base, kind: "docs" }, [])).toBe("docs");
    expect(taskCapability({ ...base, kind: "config" }, [])).toBe("devops");
    expect(taskCapability(base, ["src/components/Comment.tsx", "src/styles/app.css"])).toBe("frontend");
    expect(taskCapability(base, ["server/routes.py", "migrations/001.sql", "src/App.tsx"])).toBe("backend");
    expect(taskCapability({ ...base, kind: "boilerplate" }, ["src/renderer/pages/**"])).toBe("frontend");
    // No files, or files that lean neither way: the preference order decides.
    expect(taskCapability(base, [])).toBeNull();
    expect(taskCapability(base, ["src/lib/util.ts"])).toBeNull();
    expect(taskCapability(base, ["src/ui/Button.tsx", "src/api/client.ts"])).toBeNull();
  });

  it("prefers an agent good at the work among those with a model for the tier", () => {
    expect(chooseAgent(agents, "T3", "zh-CN", { capability: "frontend" })).toMatchObject({
      agent: "codex",
      model: { modelId: "codex-max" },
      reason: "擅长前端、且配置了 T3 模型的 Agent 中排在最前",
    });
    expect(chooseAgent(agents, "T3", "zh-CN", { capability: "backend" })).toMatchObject({ agent: "claude_code" });
    // Nobody good at docs: the order decides, and the reason says so.
    expect(chooseAgent(agents, "T3", "en", { capability: "docs" })).toMatchObject({
      agent: "claude_code",
      reason: "no agent good at docs has a T3 model; using the first enabled agent with one",
    });
  });

  it("puts a model for the tier before the capability, and ignores disabled agents", () => {
    // claude_code is good at debugging but has no T2 model; codex has one.
    expect(chooseAgent(agents, "T2", "zh-CN", { capability: "debugging" })).toMatchObject({
      agent: "codex",
      model: { modelId: "codex-mid" },
    });
    // cursor is good at frontend and has a T2 model, but it is disabled.
    expect(chooseAgent(agents, "T2", "zh-CN", { capability: "frontend" }).agent).toBe("codex");
    expect(chooseAgent(agents, "T1", "zh-CN", { capability: "frontend", forced: "cursor" })).toMatchObject({
      agent: "cursor",
      reason: "手动指定",
    });
  });

  it("names the enabled agents that are good at the work but lack a model for the tier", () => {
    expect(chooseAgent(agents, "T2", "zh-CN", { capability: "debugging" }).reason).toBe(
      "Claude Code 擅长调试，但没有配置 T2 模型，暂用排在最前、且配置了 T2 模型的 Agent；在“设置 → Agent”里补上模型后，这类任务会交给它",
    );
    // Nobody is good at docs, so there is no one to name.
    expect(chooseAgent(agents, "T2", "en", { capability: "docs" }).reason).toBe(
      "no agent good at docs has a T2 model; using the first enabled agent with one",
    );
  });
});

describe("escalation", () => {
  const failed = (...tiers: Tier[]): TaskFailure[] =>
    tiers.map((tier, index) => ({ tier, at: `2026-01-0${index + 1}T00:00:00.000Z`, source: "user" }));

  it("starts a task KM0 rejected one tier above where KM0 Runner finished it", () => {
    const rejected = (tier: Tier): TaskFailure => ({
      tier,
      at: "2026-01-01T00:00:00.000Z",
      source: "runner",
      reason: "x",
    });
    expect(escalateTier("T1", [rejected("T2")], "zh-CN")).toEqual({
      tier: "T3",
      escalatedFrom: "T1",
      needsHuman: false,
      reasons: ["KM0 Runner 在 T2 完成的改动未通过验收 → 从 T3 重新分发"],
    });
    // A rejection does not count towards the two hand-run failures.
    expect(escalateTier("T2", [rejected("T1"), ...failed("T2")], "zh-CN").tier).toBe("T2");
    expect(escalateTier("T1", [rejected("T3")], "zh-CN")).toMatchObject({ tier: "T3", needsHuman: true });
  });

  it("moves a task up one tier after two failures on its tier", () => {
    expect(escalateTier("T1", failed("T1"), "zh-CN")).toEqual({
      tier: "T1",
      escalatedFrom: null,
      needsHuman: false,
      reasons: [],
    });
    expect(escalateTier("T1", failed("T1", "T1"), "zh-CN")).toEqual({
      tier: "T2",
      escalatedFrom: "T1",
      needsHuman: false,
      reasons: ["T1 已失败 2 次 → 升到 T2"],
    });
    expect(escalateTier("T1", failed("T1", "T1", "T2", "T2"), "zh-CN")).toMatchObject({
      tier: "T3",
      escalatedFrom: "T1",
      reasons: ["T1 已失败 2 次 → 升到 T2", "T2 已失败 2 次 → 升到 T3"],
    });
  });

  it("hands a task that keeps failing on T3 to a person", () => {
    const result = escalateTier("T2", failed("T2", "T2", "T3", "T3"), "en");
    expect(result).toMatchObject({ tier: "T3", escalatedFrom: "T2", needsHuman: true });
    expect(result.reasons.at(-1)).toBe(
      "failed 2 times on T3 too → a person has to decide: split it, clarify it or do it by hand",
    );
  });

  it("counts only failures on the tier the task starts from or reaches", () => {
    expect(escalateTier("T3", failed("T1", "T1"), "zh-CN")).toMatchObject({ tier: "T3", escalatedFrom: null });
    expect(escalateTier("T1", failed("T2", "T2"), "zh-CN")).toMatchObject({ tier: "T1", escalatedFrom: null });
  });
});

describe("cost", () => {
  it("estimates a token range per scope and prices it", () => {
    const tokens = estimateTokens(base);
    expect(tokens).toEqual({ input: { low: 20_000, high: 80_000 }, output: { low: 1_500, high: 6_000 } });
    expect(estimateCost(priced("m", 1, 5), tokens)).toEqual({ low: 0.0275, high: 0.11 });
    expect(estimateCost({ modelId: "m", priceInPerMTok: null, priceOutPerMTok: 5 }, tokens)).toBeNull();
    expect(estimateTokens({ ...base, context: "large", ambiguity: "high" }).input.high).toBe(156_000);
  });

  const task = (overrides: Partial<TaskBasics> = {}): TaskBasics => ({
    id: 1,
    seq: 1,
    title: "t",
    goal: "g",
    acceptance: [],
    files: [],
    dependsOn: [],
    decisionKeys: [],
    sections: [],
    features: base,
    override: null,
    failures: [],
    ...overrides,
  });

  it("routes by the rules and lets the user override tier, agent and model", () => {
    const routed = routeTask(task(), agents, "zh-CN");
    expect(routed).toMatchObject({ ruleTier: "T1", tier: "T1", agent: "claude_code", model: "claude-haiku-5-5" });
    expect(routed.costAllT3).toEqual(estimateCost(priced("o", 5, 25), routed.tokens));

    const lifted = routeTask(task({ override: { tier: "T3" } }), agents, "zh-CN");
    expect(lifted).toMatchObject({ ruleTier: "T1", tier: "T3", agent: "claude_code", model: "claude-opus-5-5" });

    const moved = routeTask(task({ override: { agent: "codex" } }), agents, "zh-CN");
    expect(moved).toMatchObject({ agent: "codex", model: null, cost: null, agentReason: "手动指定" });

    // A typed model gets the catalog price when it matches an entry of the agent.
    const typed = routeTask(task({ override: { model: "claude-opus-5-5" } }), agents, "zh-CN");
    expect(typed).toMatchObject({ tier: "T1", model: "claude-opus-5-5" });
    expect(typed.cost).toEqual(typed.costAllT3);
    expect(routeTask(task({ override: { model: "my-model" } }), agents, "zh-CN").cost).toBeNull();
  });

  it("routes a lifted task on the new tier and drops a model typed for the old one", () => {
    const failures: TaskFailure[] = [
      { tier: "T1", at: "2026-01-01T00:00:00.000Z", source: "user" },
      { tier: "T1", at: "2026-01-02T00:00:00.000Z", source: "user" },
    ];
    const lifted = routeTask(task({ failures, override: { model: "my-model" } }), agents, "zh-CN");
    expect(lifted).toMatchObject({
      ruleTier: "T1",
      tier: "T2",
      escalatedFrom: "T1",
      agent: "codex",
      model: "codex-mid",
    });
    expect(lifted.reasons.at(-1)).toBe("T1 已失败 2 次 → 升到 T2");
    expect(lifted.failures).toEqual(failures);

    const fix = routeTask(task({ features: { ...base, kind: "fix" } }), agents, "zh-CN");
    expect(fix).toMatchObject({ ruleTier: "T2", capability: "debugging", agent: "codex", needsHuman: false });
  });

  it("totals priced tasks and compares them with running everything on T3", () => {
    const cheap = routeTask(task(), agents, "zh-CN");
    const unpriced = routeTask(task({ id: 2, seq: 2, override: { model: "my-model" } }), agents, "zh-CN");
    const { totals, tierCounts } = planTotals([cheap, unpriced]);
    expect(tierCounts).toEqual({ T1: 2, T2: 0, T3: 0 });
    expect(totals.unpriced).toBe(1);
    expect(totals.cost).toEqual(cheap.cost);
    // Haiku-priced work against Opus-priced work: 1/5 of the cost.
    expect(totals.saving).toBeCloseTo(0.8);
    expect(planTotals([unpriced]).totals).toEqual({ cost: null, costAllT3: null, saving: null, unpriced: 1 });
  });
});

describe("breakdown", () => {
  it("keeps only earlier tasks as prerequisites and references that exist", async () => {
    const llm = createSimulatedLlm();
    const tasks = await breakDown(llm, {
      language: "zh-CN",
      path: "light",
      title: "博客评论",
      description: "给博客加评论",
      triage: null,
      decisions: [],
      documents: [{ kind: "brief", sections: [{ id: "scope", title: "范围", body: "文章页" }] }],
    });
    expect(tasks.map((item) => [item.seq, item.dependsOn])).toEqual([
      [1, []],
      [2, [1]],
      [3, [1, 2]],
    ]);
    // tech_design and prd sections are not part of a light-path project.
    expect(tasks.map((item) => item.sections)).toEqual([
      [{ kind: "brief", sectionId: "approach" }],
      [{ kind: "brief", sectionId: "scope" }],
      [],
    ]);
    expect(tasks.map((item) => decideTier(item.features, "zh-CN").tier)).toEqual(["T1", "T2", "T3"]);
  });
});

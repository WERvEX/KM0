import type { AgentConfig, ModelRegistry, RegistryModel, TaskFailure, TaskFeatures, TierModel } from "@km0/shared";
import { describe, expect, it } from "vitest";
import type { RunRecord } from "../ability/records";
import { tierLabels } from "../ability/records";
import { createSimulatedLlm } from "../discussion/simulator";
import { agentConfig, tierModel } from "../testing";
import { breakDown, breakdownSystem } from "./breakdown";
import { estimateTokens, planTotals, type RouteOptions, routeTask, type TaskBasics, taskCapability } from "./route";
import { DEFAULT_ROUTING_RULES, decideTier } from "./scoring";
import { costOf } from "./strategy";

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
});

/** A registry model with a general ability; every other kind of work gets the same. */
function registryModel(id: string, mean: number, sd: number, input: number, output: number): RegistryModel {
  const ability = { mean, sd };
  return {
    id,
    name: id,
    vendor: id.split("/")[0] ?? "",
    aliases: [],
    released: null,
    contextWindow: 200_000,
    pricing: { input, output, cacheRead: null },
    abilities: {
      general: ability,
      frontend: ability,
      backend: ability,
      debugging: ability,
      testing: ability,
      docs: ability,
      devops: ability,
    },
    coverage: "measured",
    observations: [{ column: "swe", source: "swebench", agent: null, value: 50, effort: null, date: null }],
  };
}

const registry: ModelRegistry = {
  schemaVersion: 1,
  generatedAt: "2026-10-01T00:00:00Z",
  dataDate: "2026-09-30",
  sources: [
    {
      id: "swebench",
      name: "SWE-bench Verified",
      url: "",
      measures: "",
      fetchedAt: "",
      newestEntry: null,
      entries: 1,
      unmatched: 0,
    },
  ],
  difficulty: { bands: [] },
  vendors: [],
  agents: [
    {
      id: "pi",
      name: "Pi",
      nativeVendors: [],
      offset: { native: { mean: 0, sd: 0.05 }, foreign: { mean: 0, sd: 0.05 } },
      evidence: 0,
    },
    {
      id: "claude_code",
      name: "Claude Code",
      nativeVendors: ["anthropic"],
      offset: { native: { mean: 0.7, sd: 0.1 }, foreign: { mean: 0, sd: 0.05 } },
      evidence: 5,
    },
  ],
  models: [
    registryModel("v/cheap", -1, 0.3, 0.2, 1),
    registryModel("v/mid", 0.7, 0.3, 1, 5),
    registryModel("v/strong", 2, 0.3, 5, 25),
    registryModel("v/vague", 1.5, 1.5, 0.3, 1.5),
    registryModel("anthropic/opus", 1.6, 0.3, 5, 25),
  ],
};

const known = (ref: number, canonicalId: string, extra: Partial<TierModel> = {}): TierModel => {
  const found = registry.models.find((model) => model.id === canonicalId) as RegistryModel;
  return tierModel(canonicalId.split("/")[1] ?? canonicalId, found.pricing.input, found.pricing.output, {
    modelRef: ref,
    canonicalId,
    vendor: found.vendor,
    ...extra,
  });
};

const cheap = known(1, "v/cheap", { tier: "T1" });
const mid = known(2, "v/mid", { tier: "T2" });
const strong = known(3, "v/strong", { tier: "T3" });
const vague = known(4, "v/vague", { tier: "T2" });

const pi = (models: TierModel[], extra: Partial<AgentConfig> = {}) =>
  agentConfig({ id: "pi", preference: 0, models, ...extra });

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

const route = (basics: TaskBasics, agents: AgentConfig[], options: RouteOptions = {}) =>
  routeTask(basics, agents, "zh-CN", { registry, ...options });

describe("cost", () => {
  it("estimates a token range per scope and prices it", () => {
    const tokens = estimateTokens(base);
    expect(tokens).toEqual({ input: { low: 20_000, high: 80_000 }, output: { low: 1_500, high: 6_000 } });
    expect(costOf({ input: 1, output: 5 }, tokens)).toEqual({ low: 0.0275, high: 0.11 });
    expect(costOf({ input: null, output: 5 }, tokens)).toBeNull();
    expect(estimateTokens({ ...base, context: "large", ambiguity: "high" }).input.high).toBe(156_000);
  });

  it("prices a run by the provider's billing: relay multiplied, subscription and free at nothing", () => {
    const relay = { ...mid, price: { ...mid.price, mode: "relay" as const, input: 2, output: 10 } };
    const subscription = {
      ...mid,
      price: { mode: "subscription" as const, input: 0, output: 0, cacheRead: 0, source: "billing" as const },
    };
    const routedRelay = route(task(), [pi([relay])]);
    const routedToken = route(task(), [pi([mid])]);
    expect(routedRelay.cost?.low).toBeCloseTo((routedToken.cost?.low ?? 0) * 2);
    expect(route(task(), [pi([subscription])]).expectedCost).toBe(0);
  });
});

describe("strategy levels", () => {
  const agents = [pi([cheap, mid, strong, vague])];

  it("takes the cheapest combination that meets the level's target, and the likeliest when none does", () => {
    const aggressive = route(task(), agents, { level: 1 });
    expect(aggressive.meetsTarget).toBe(true);
    expect(aggressive.choice?.pass.atLevel).toBeGreaterThanOrEqual(0.5);
    const conservative = route(task(), agents, { level: 5 });
    expect(conservative.model).toBe("strong");
    expect(conservative.agentReason).toMatch(/没有组合/);
    expect(conservative.meetsTarget).toBe(false);
    expect(aggressive.agentReason).toMatch(/期望成本最低/);
  });

  it("gives an uncertain model a chance at aggressive levels only", () => {
    const options = route(task(), agents, { level: 1 }).options;
    const vagueOption = options.find((option) => option.modelRef === 4);
    const midOption = options.find((option) => option.modelRef === 2);
    expect(vagueOption?.pass.low).toBeLessThan(midOption?.pass.low ?? 0);
    expect(route(task(), [pi([mid, vague, strong])], { level: 1 }).model).toBe("vague");
    expect(route(task(), [pi([mid, vague, strong])], { level: 4 }).model).not.toBe("vague");
  });

  it("never costs less or passes less often at a more conservative level", () => {
    // Random catalogs with equal uncertainty: expected cost never falls, nor does the chance of passing.
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let round = 0; round < 60; round += 1) {
      const models = Array.from({ length: 4 }, (_, index) => {
        const id = `r/m${round}-${index}`;
        const price = 0.1 + random() * 20;
        registry.models.push(registryModel(id, -2 + random() * 5, 0.3, price / 5, price));
        return known(100 + index, id);
      });
      const features: TaskFeatures = { ...base, scope: random() < 0.5 ? "few_files" : "many_files" };
      const routed = [1, 2, 3, 4, 5].map((level) =>
        route(task({ features }), [pi(models)], { level: level as 1 | 2 | 3 | 4 | 5 }),
      );
      for (let index = 1; index < routed.length; index += 1) {
        const before = routed[index - 1];
        const after = routed[index];
        expect(after?.expectedCost ?? 0).toBeGreaterThanOrEqual((before?.expectedCost ?? 0) - 1e-9);
        expect(after?.choice?.pass.mean ?? 0).toBeGreaterThanOrEqual((before?.choice?.pass.mean ?? 0) - 1e-9);
      }
      const costs = routed[0]?.levelCosts ?? [];
      expect(costs).toEqual(routed.map((item) => item.expectedCost));
      registry.models.splice(-4);
    }
  });

  it("prefers the cheaper of two equally able models", () => {
    const pricey = {
      ...mid,
      modelRef: 9,
      modelId: "mid-pricey",
      name: "mid-pricey",
      price: { ...mid.price, input: 3, output: 15 },
    };
    expect(route(task(), [pi([pricey, mid])]).model).toBe("mid");
    expect(route(task(), [pi([mid, pricey])]).model).toBe("mid");
  });

  it("routes risky tasks at least at level 4 and requires the ability floor", () => {
    const risky = task({ features: { ...base, risks: ["security"] } });
    const routed = route(risky, agents, { level: 1 });
    expect(routed).toMatchObject({ level: 4, levelSource: "risk" });
    expect(routed.options.find((option) => option.modelRef === 1)?.excluded).toBe("risk_floor");
    expect(route(risky, agents, { level: 5 }).levelSource).toBe("project");
    // A level set on the task still cannot go below the risk level.
    expect(route(task({ ...risky, override: { level: 2 } }), agents).level).toBe(4);
    expect(route(task({ override: { level: 2 } }), agents)).toMatchObject({ level: 2, levelSource: "task" });
  });

  it("explains why cheaper combinations were passed over, and where the numbers come from", () => {
    const routed = route(task(), agents, { level: 3 });
    expect(routed.passedOver.length).toBeGreaterThan(0);
    expect(routed.passedOver[0]).toMatch(/低于目标 70%/);
    expect(routed.evidence).toMatch(/1 个榜单（SWE-bench Verified），截至 2026-09-30/);
    const en = routeTask(task(), agents, "en", { registry, level: 3 });
    expect(en.passedOver[0]).toMatch(/below the 70% target/);
  });
});

describe("hard constraints", () => {
  it("rules out a context window smaller than the task needs", () => {
    const small = { ...strong, contextWindow: 64_000 };
    const routed = route(task({ features: { ...base, context: "large" } }), [pi([small, mid])], { level: 5 });
    expect(routed.model).toBe("mid");
    expect(routed.options.find((option) => option.modelRef === 3)?.excluded).toBe("context");
  });

  it("rules out a subscription past its quota, or prices it per token when it allows that", () => {
    const subscription = {
      ...mid,
      price: { mode: "subscription" as const, input: 0, output: 0, cacheRead: 0, source: "billing" as const },
    };
    const unavailable = route(task(), [pi([subscription, cheap])], { level: 1, pastQuota: () => "unavailable" });
    expect(unavailable.options.find((option) => option.modelRef === 2)?.excluded).toBe("quota");
    const overflow = route(task(), [pi([subscription])], { pastQuota: () => ({ ...mid.price }) });
    expect(overflow.expectedCost).toBeGreaterThan(0);
  });

  it("ignores models of another API format and disabled agents", () => {
    const anthropic = { ...strong, providerKind: "anthropic" as const };
    const codex = agentConfig({ id: "codex", models: [anthropic], apiKinds: ["openai"] });
    expect(route(task(), [codex, pi([mid], { enabled: false, preference: 1 })]).choice).toBeNull();
  });

  it("falls back to the first enabled agent without a model, and to generic when none is enabled", () => {
    const routed = route(task(), [agentConfig({ id: "cursor" })]);
    expect(routed).toMatchObject({
      agent: "cursor",
      model: null,
      choice: null,
      agentReason: "这个 Agent 没有可用的模型",
    });
    expect(route(task(), [pi([mid], { enabled: false })])).toMatchObject({ agent: "generic", model: null });
  });
});

describe("agents", () => {
  const opusNative = known(5, "anthropic/opus", { native: true });
  const opusForeign = known(5, "anthropic/opus");

  it("runs a model in its vendor's own agent when that is at most 5 points less likely to pass", () => {
    const claude = agentConfig({ id: "claude_code", preference: 1, models: [opusNative] });
    const routed = route(task(), [pi([opusForeign]), claude], { level: 5 });
    expect(routed.agent).toBe("claude_code");
    expect(routed.choice?.native).toBe(true);
    expect(routed.options.find((option) => option.agent === "pi")?.excluded).toBe("native");
  });

  it("breaks ties by the capability the task needs, then by preference", () => {
    const free = {
      ...mid,
      price: { mode: "free" as const, input: 0, output: 0, cacheRead: 0, source: "billing" as const },
    };
    const first = pi([free]);
    // Claude Code adds nothing to another vendor's model here, the same as Pi.
    const second = agentConfig({ id: "claude_code", preference: 1, models: [free], capabilities: ["frontend"] });
    expect(route(task(), [first, second]).agent).toBe("pi");
    expect(route(task({ files: ["src/components/App.tsx"] }), [first, second]).agent).toBe("claude_code");
  });

  it("takes an agent and model chosen by hand, even past a constraint", () => {
    const routed = route(task({ override: { agent: "pi", modelRef: 1 } }), [pi([cheap, strong])], { level: 5 });
    expect(routed).toMatchObject({ model: "cheap", agentReason: "手动指定", passedOver: [] });
    // KM0 0.1's tier override keeps models with that label.
    expect(route(task({ override: { tier: "T3" } }), [pi([cheap, mid, strong])], { level: 1 }).model).toBe("strong");
    expect(route(task({ override: { model: "mid" } }), [pi([cheap, mid, strong])]).model).toBe("mid");
  });

  it("keeps an agent chosen by hand even when it has been disabled, as KM0 0.1 did", () => {
    const disabled = agentConfig({ id: "claude_code", preference: 1, enabled: false, models: [strong] });
    const routed = route(task({ override: { agent: "claude_code" } }), [pi([cheap]), disabled]);
    expect(routed).toMatchObject({ agent: "claude_code", model: "strong", agentReason: "手动指定" });
    // Without the override a disabled agent is never chosen.
    expect(route(task(), [pi([cheap]), disabled]).agent).toBe("pi");
  });
});

describe("escalation", () => {
  const agents = [pi([cheap, mid, strong])];
  const failure = (modelRef: number, source: TaskFailure["source"] = "user"): TaskFailure => ({
    tier: "T1",
    at: "2026-01-01T00:00:00Z",
    source,
    agent: "pi",
    modelRef,
  });

  it("moves a task to a stronger combination after two failures, or one rejection of KM0 Runner's work", () => {
    const start = route(task(), agents, { level: 1 });
    expect(start.model).toBe("cheap");
    expect(start.chain.map((step) => step.modelId)).toEqual(["mid", "strong"]);
    expect(route(task({ failures: [failure(1)] }), agents, { level: 1 }).model).toBe("cheap");
    const lifted = route(task({ failures: [failure(1), failure(1)] }), agents, { level: 1 });
    expect(lifted).toMatchObject({ model: "mid", escalatedFrom: "T1" });
    expect(lifted.agentReason).toMatch(/已在这个任务上失败/);
    expect(route(task({ failures: [failure(1, "runner")] }), agents, { level: 1 }).model).toBe("mid");
  });

  it("hands a task to a person once the chain is used up", () => {
    const failures = [failure(1), failure(1), failure(2), failure(2), failure(3, "runner")];
    const routed = route(task({ failures }), agents);
    expect(routed).toMatchObject({ needsHuman: true, choice: null });
    expect(routed.reasons.at(-1)).toMatch(/需要人来决定/);
  });

  it("reads KM0 0.1 failures by tier", () => {
    const old: TaskFailure[] = [
      { tier: "T1", at: "a", source: "user" },
      { tier: "T1", at: "b", source: "user" },
    ];
    expect(route(task({ failures: old }), agents, { level: 1 }).choice?.tier).not.toBe("T1");
  });
});

describe("local records", () => {
  const agents = [pi([cheap, mid, strong])];
  const record = (passed: boolean): RunRecord => ({
    modelKey: "v/cheap",
    agent: "pi",
    native: false,
    kind: "general",
    band: "lt15m",
    passed,
    weight: 1,
  });

  it("learns from this install's runs: repeated failures move work off a model", () => {
    expect(route(task(), agents, { level: 1 }).model).toBe("cheap");
    const records = Array.from({ length: 8 }, () => record(false));
    const routed = route(task(), agents, { level: 1, records });
    expect(routed.model).not.toBe("cheap");
    expect(routed.options.find((option) => option.modelRef === 1)?.localRecords).toBe(8);
  });

  it("guesses a model the registry does not list from its price, very uncertainly", () => {
    const unknown = tierModel("my-model", 1, 5, { modelRef: 7 });
    const routed = route(task(), [pi([unknown])]);
    expect(routed.choice?.coverage).toBe("unmatched");
    expect(routed.evidence).toMatch(/按价格估计/);
  });

  it("labels models by where their ability sits among the user's models, unless set by hand", () => {
    const labels = tierLabels([
      { id: 1, ability: -1, label: null },
      { id: 2, ability: 0.5, label: null },
      { id: 3, ability: 2, label: null },
      { id: 4, ability: 2, label: "T1" },
    ]);
    expect([...labels.entries()]).toEqual([
      [1, "T1"],
      [2, "T2"],
      [3, "T3"],
      [4, "T1"],
    ]);
    expect(tierLabels([{ id: 1, ability: 0, label: null }]).get(1)).toBe("T2");
  });
});

describe("plan totals", () => {
  const agents = [pi([cheap, mid, strong])];

  it("totals priced tasks and compares them with the strongest combination", () => {
    const one = route(task(), agents, { level: 1 });
    const unpriced = route(task({ id: 2, seq: 2 }), [pi([tierModel("x", null, null, { modelRef: 8 })])]);
    const { totals } = planTotals([one, unpriced]);
    expect(totals.unpriced).toBe(1);
    expect(totals.cost).toEqual(one.cost);
    expect(totals.saving).toBeGreaterThan(0.9);
    expect(totals.expectedCost).toBeCloseTo(one.expectedCost ?? 0);
  });

  it("over budget, names tasks that fit at a cheaper level, largest saving first", () => {
    const tasks = [1, 2, 3].map((id) => route(task({ id, seq: id }), agents, { level: 5 }));
    const total = tasks.reduce((sum, item) => sum + (item.expectedCost ?? 0), 0);
    expect(planTotals(tasks, null).budgetAdvice).toBeNull();
    expect(planTotals(tasks, total * 2).budgetAdvice).toBeNull();
    const advice = planTotals(tasks, total / 2).budgetAdvice;
    expect(advice?.fits).toBe(true);
    expect(advice?.moves[0]?.level).toBeLessThan(5);
    const impossible = planTotals(tasks, 0.000001).budgetAdvice;
    expect(impossible?.fits).toBe(false);
    expect(impossible?.moves).toHaveLength(3);
  });
});

describe("breakdown", () => {
  // A request with five criteria lost one when the prompt asked for 2-4 per task.
  it("asks for every stated criterion instead of a fixed number", () => {
    const system = breakdownSystem({
      language: "zh-CN",
      path: "fast",
      title: "t",
      description: "d",
      triage: null,
      decisions: [],
      documents: [],
    });
    expect(system).not.toMatch(/2-4 criteria/);
    expect(system).toContain("carry over every acceptance criterion");
  });

  // A criterion that the render helper must sort its input rejected a change whose endpoint was correct.
  it("asks for criteria a caller can observe, not internal structure", () => {
    const system = breakdownSystem({
      language: "zh-CN",
      path: "fast",
      title: "t",
      description: "d",
      triage: null,
      decisions: [],
      documents: [],
    });
    expect(system).toContain("behaviour that can be observed from outside the code");
    expect(system).toContain("Do not prescribe internal structure");
  });

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

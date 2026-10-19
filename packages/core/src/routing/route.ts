import type {
  AgentConfig,
  AgentId,
  Capability,
  CostRange,
  RoutedTask,
  RoutingPlan,
  RoutingRules,
  TaskFailure,
  TaskFeatures,
  TaskOverride,
  Tier,
  TierModel,
} from "@km0/shared";
import { TIERS } from "@km0/shared";
import type { Language } from "../discussion/prompts";
import { DEFAULT_ROUTING_RULES, decideTier, escalateTier } from "./scoring";

/**
 * Tokens one agent run is expected to use, by scope. Coding agents re-read files and tool output
 * on every turn, so input dwarfs output. The range runs from half to twice the middle value.
 */
const TOKEN_BASE: Record<TaskFeatures["scope"], { input: number; output: number }> = {
  single_file: { input: 40_000, output: 3_000 },
  few_files: { input: 150_000, output: 10_000 },
  many_files: { input: 400_000, output: 25_000 },
  new_subsystem: { input: 800_000, output: 50_000 },
};
const RANGE = { low: 0.5, high: 2 } as const;

export function estimateTokens(features: TaskFeatures): { input: CostRange; output: CostRange } {
  const base = TOKEN_BASE[features.scope];
  const contextFactor = features.context === "large" ? 1.5 : 1;
  const ambiguityFactor = features.ambiguity === "high" ? 1.3 : 1;
  const input = base.input * contextFactor * ambiguityFactor;
  const output = base.output * ambiguityFactor;
  const range = (value: number) => ({ low: Math.round(value * RANGE.low), high: Math.round(value * RANGE.high) });
  return { input: range(input), output: range(output) };
}

export function estimateCost(model: TierModel | null, tokens: { input: CostRange; output: CostRange }) {
  if (!model || model.priceInPerMTok === null || model.priceOutPerMTok === null) return null;
  const at = (side: keyof CostRange) =>
    (tokens.input[side] * (model.priceInPerMTok ?? 0) + tokens.output[side] * (model.priceOutPerMTok ?? 0)) / 1e6;
  return { low: at("low"), high: at("high") };
}

/** Paths that are mostly user interface, or mostly server, data or tooling code. */
const FRONTEND_PATH =
  /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$|(^|\/)(components|pages|views|ui|renderer|frontend|styles)(\/|$)/i;
const BACKEND_PATH =
  /\.(py|go|rs|java|kt|rb|php|cs|sql)$|(^|\/)(server|api|backend|services|db|migrations|cli|main)(\/|$)/i;

/**
 * What the task needs its agent to be good at: its kind says so for fixes, tests, docs and
 * config; for code, the files decide between frontend and backend. Null when the files do not
 * lean either way, so the preference order alone decides.
 */
export function taskCapability(features: TaskFeatures, files: string[]): Capability | null {
  switch (features.kind) {
    case "fix":
      return "debugging";
    case "test":
      return "testing";
    case "docs":
      return "docs";
    case "config":
      return "devops";
    default: {
      const ui = files.filter((file) => FRONTEND_PATH.test(file)).length;
      const server = files.filter((file) => BACKEND_PATH.test(file)).length;
      if (ui > server) return "frontend";
      if (server > ui) return "backend";
      return null;
    }
  }
}

const AGENT_TEXT = {
  "zh-CN": {
    capability: {
      frontend: "前端",
      backend: "后端",
      debugging: "调试",
      testing: "测试",
      docs: "文档",
      devops: "部署与配置",
    },
    forced: "手动指定",
    first: (tier: Tier) => `已启用的 Agent 中排在最前、且配置了 ${tier} 模型`,
    matched: (skill: string, tier: Tier) => `擅长${skill}、且配置了 ${tier} 模型的 Agent 中排在最前`,
    unmatched: (skill: string, tier: Tier) =>
      `没有擅长${skill}的 Agent 配置了 ${tier} 模型，改用排在最前、且配置了 ${tier} 模型的 Agent`,
    noModel: (tier: Tier) => `没有 Agent 配置 ${tier} 模型，暂用排在最前的 Agent`,
    none: "没有启用的 Agent，使用通用提示词",
  },
  en: {
    capability: {
      frontend: "frontend",
      backend: "backend",
      debugging: "debugging",
      testing: "testing",
      docs: "docs",
      devops: "devops",
    },
    forced: "chosen by hand",
    first: (tier: Tier) => `first enabled agent with a ${tier} model`,
    matched: (skill: string, tier: Tier) => `first agent good at ${skill} with a ${tier} model`,
    unmatched: (skill: string, tier: Tier) =>
      `no agent good at ${skill} has a ${tier} model; using the first enabled agent with one`,
    noModel: (tier: Tier) => `no agent has a ${tier} model; using the first enabled agent`,
    none: "no agent is enabled; using the generic prompt",
  },
} as const;

/**
 * The agent for a task: among enabled agents that have a model for the tier, the first by
 * preference that is good at what the task needs, else the first by preference. A model for the
 * tier matters more than the capability, since without one there is no price and no command.
 */
export function chooseAgent(
  agents: AgentConfig[],
  tier: Tier,
  language: Language,
  options: { forced?: AgentId; capability?: Capability | null } = {},
): { agent: AgentId; model: TierModel | null; reason: string } {
  const text = AGENT_TEXT[language];
  const { forced, capability } = options;
  if (forced) {
    const config = agents.find((agent) => agent.id === forced);
    return { agent: forced, model: config?.models[tier] ?? null, reason: text.forced };
  }
  const enabled = agents.filter((agent) => agent.enabled).sort((a, b) => a.preference - b.preference);
  const withModel = enabled.filter((agent) => agent.models[tier]);
  if (capability) {
    const skill = text.capability[capability];
    const good = withModel.find((agent) => agent.capabilities.includes(capability));
    if (good) return { agent: good.id, model: good.models[tier], reason: text.matched(skill, tier) };
    const fallback = withModel[0];
    if (fallback) return { agent: fallback.id, model: fallback.models[tier], reason: text.unmatched(skill, tier) };
  }
  const first = withModel[0];
  if (first) return { agent: first.id, model: first.models[tier], reason: text.first(tier) };
  const any = enabled[0];
  if (any) return { agent: any.id, model: null, reason: text.noModel(tier) };
  return { agent: "generic", model: null, reason: text.none };
}

/** A model ID typed by hand gets the price of the matching catalog entry, if there is one. */
function priceOf(agent: AgentConfig | undefined, modelId: string): TierModel | null {
  if (!agent) return null;
  return TIERS.map((tier) => agent.models[tier]).find((model) => model?.modelId === modelId) ?? null;
}

export interface TaskBasics {
  id: number;
  seq: number;
  title: string;
  goal: string;
  acceptance: string[];
  files: string[];
  dependsOn: number[];
  decisionKeys: string[];
  sections: RoutedTask["sections"];
  testCommand?: string | null;
  features: TaskFeatures;
  override: TaskOverride | null;
  failures: TaskFailure[];
}

/**
 * Tier, agent, model and cost for a task: rules first, then whatever the user overrode, then a
 * lift for failed runs. Once failures lift the task, a model typed by hand no longer applies.
 */
export function routeTask(
  task: TaskBasics,
  agents: AgentConfig[],
  language: Language,
  rules: RoutingRules = DEFAULT_ROUTING_RULES,
): RoutedTask {
  const decision = decideTier(task.features, language, rules);
  const override = task.override;
  const escalation = escalateTier(override?.tier ?? decision.tier, task.failures, language);
  const tier = escalation.tier;
  const capability = taskCapability(task.features, task.files);
  const chosen = chooseAgent(agents, tier, language, { forced: override?.agent, capability });
  const config = agents.find((agent) => agent.id === chosen.agent);
  const typed = escalation.escalatedFrom ? undefined : override?.model;
  const model = typed ? priceOf(config, typed) : chosen.model;
  const tokens = estimateTokens(task.features);
  return {
    ...task,
    testCommand: task.testCommand ?? null,
    score: decision.score,
    ruleTier: decision.tier,
    tier,
    reasons: [...decision.reasons, ...escalation.reasons],
    escalatedFrom: escalation.escalatedFrom,
    needsHuman: escalation.needsHuman,
    capability,
    agent: chosen.agent,
    agentReason: chosen.reason,
    model: typed ?? chosen.model?.modelId ?? null,
    tokens,
    cost: estimateCost(model, tokens),
    costAllT3: estimateCost(config?.models.T3 ?? null, tokens),
    splitSuggested: decision.splitSuggested,
  };
}

const middle = (range: CostRange) => (range.low + range.high) / 2;

/** Sums over the tasks that have a price both as routed and on T3. */
export function planTotals(tasks: RoutedTask[]): Pick<RoutingPlan, "totals" | "tierCounts"> {
  const priced = tasks.filter((task) => task.cost && task.costAllT3);
  const sum = (pick: (task: RoutedTask) => CostRange | null) =>
    priced.length === 0
      ? null
      : priced.reduce(
          (total, task) => {
            const range = pick(task) as CostRange;
            return { low: total.low + range.low, high: total.high + range.high };
          },
          { low: 0, high: 0 },
        );
  const cost = sum((task) => task.cost);
  const costAllT3 = sum((task) => task.costAllT3);
  const saving = cost && costAllT3 && middle(costAllT3) > 0 ? 1 - middle(cost) / middle(costAllT3) : null;
  const tierCounts = { T1: 0, T2: 0, T3: 0 };
  for (const task of tasks) tierCounts[task.tier] += 1;
  return { totals: { cost, costAllT3, saving, unpriced: tasks.length - priced.length }, tierCounts };
}

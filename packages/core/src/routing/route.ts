import type {
  AgentConfig,
  AgentId,
  CostRange,
  RoutedTask,
  RoutingPlan,
  TaskFeatures,
  TaskOverride,
  Tier,
  TierModel,
} from "@km0/shared";
import { TIERS } from "@km0/shared";
import type { Language } from "../discussion/prompts";
import { decideTier } from "./scoring";

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

const AGENT_TEXT = {
  "zh-CN": {
    forced: "手动指定",
    first: (tier: Tier) => `已启用的 Agent 中排在最前、且配置了 ${tier} 模型`,
    noModel: (tier: Tier) => `没有 Agent 配置 ${tier} 模型，暂用排在最前的 Agent`,
    none: "没有启用的 Agent，使用通用提示词",
  },
  en: {
    forced: "chosen by hand",
    first: (tier: Tier) => `first enabled agent with a ${tier} model`,
    noModel: (tier: Tier) => `no agent has a ${tier} model; using the first enabled agent`,
    none: "no agent is enabled; using the generic prompt",
  },
} as const;

/** The preferred enabled agent that has a model for the tier. */
export function chooseAgent(
  agents: AgentConfig[],
  tier: Tier,
  language: Language,
  forced?: AgentId,
): { agent: AgentId; model: TierModel | null; reason: string } {
  const text = AGENT_TEXT[language];
  if (forced) {
    const config = agents.find((agent) => agent.id === forced);
    return { agent: forced, model: config?.models[tier] ?? null, reason: text.forced };
  }
  const enabled = agents.filter((agent) => agent.enabled).sort((a, b) => a.preference - b.preference);
  const withModel = enabled.find((agent) => agent.models[tier]);
  if (withModel) return { agent: withModel.id, model: withModel.models[tier], reason: text.first(tier) };
  const first = enabled[0];
  if (first) return { agent: first.id, model: null, reason: text.noModel(tier) };
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
  features: TaskFeatures;
  override: TaskOverride | null;
}

/** Tier, agent, model and cost for a task: rules first, then whatever the user overrode. */
export function routeTask(task: TaskBasics, agents: AgentConfig[], language: Language): RoutedTask {
  const decision = decideTier(task.features, language);
  const override = task.override;
  const tier = override?.tier ?? decision.tier;
  const chosen = chooseAgent(agents, tier, language, override?.agent);
  const config = agents.find((agent) => agent.id === chosen.agent);
  const model = override?.model ? priceOf(config, override.model) : chosen.model;
  const tokens = estimateTokens(task.features);
  return {
    ...task,
    score: decision.score,
    ruleTier: decision.tier,
    tier,
    reasons: decision.reasons,
    agent: chosen.agent,
    agentReason: chosen.reason,
    model: override?.model ?? chosen.model?.modelId ?? null,
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

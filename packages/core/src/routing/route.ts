import {
  type AbilityKind,
  type AgentConfig,
  type Capability,
  type CostRange,
  DEFAULT_LEVEL,
  type ModelRegistry,
  RISK_LEVEL,
  type RoutedTask,
  type RoutingPlan,
  type RoutingRules,
  type StrategyLevel,
  type TaskFailure,
  type TaskFeatures,
  type TaskOverride,
} from "@km0/shared";
import { EMPTY_REGISTRY, type RunRecord } from "../ability/records";
import type { Language } from "../discussion/prompts";
import { DEFAULT_ROUTING_RULES, decideTier } from "./scoring";
import {
  bandFor,
  CONTEXT_NEED,
  candidates,
  evidenceLine,
  explainChoice,
  levelCosts,
  passedOver,
  STRATEGY_TEXT,
  type StrategyContext,
  select,
} from "./strategy";

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

export interface RouteOptions {
  rules?: RoutingRules;
  registry?: ModelRegistry;
  records?: RunRecord[];
  /** The project's strategy level. */
  level?: StrategyLevel;
  pastQuota?: StrategyContext["pastQuota"];
}

/**
 * Difficulty, strategy level, agent, model and cost for a task. The rules give the task a score and
 * a tier, which place it in a difficulty band; the strategy picks the combination; what the user
 * overrode and the task's failed runs apply on top.
 */
export function routeTask(
  task: TaskBasics,
  agents: AgentConfig[],
  language: Language,
  options: RouteOptions = {},
): RoutedTask {
  const registry = options.registry ?? EMPTY_REGISTRY;
  const decision = decideTier(task.features, language, options.rules ?? DEFAULT_ROUTING_RULES);
  const capability = taskCapability(task.features, task.files);
  const abilityKind: AbilityKind = capability ?? "general";
  const tokens = estimateTokens(task.features);
  const band = bandFor(registry, decision.tier, decision.score);
  const risky = task.features.risks.length > 0;
  const asked = task.override?.level ?? options.level ?? DEFAULT_LEVEL;
  const level = (risky ? Math.max(asked, RISK_LEVEL) : asked) as StrategyLevel;
  const levelSource = risky && asked < RISK_LEVEL ? "risk" : task.override?.level ? "task" : "project";

  const all = candidates(
    { features: task.features, tier: decision.tier, score: decision.score, abilityKind, capability, tokens },
    agents,
    { registry, records: options.records ?? [], pastQuota: options.pastQuota },
    task.override?.agent,
  );
  const settings = { risky, failures: task.failures, override: task.override };
  const selection = select(all, level, settings);
  const choice = selection.choice;
  const fallback = agents.filter((agent) => agent.enabled).sort((a, b) => a.preference - b.preference)[0];
  const agent = choice?.agent ?? task.override?.agent ?? fallback?.id ?? "generic";
  const config = agents.find((item) => item.id === agent);
  const model = config?.models.find((item) => item.modelRef === choice?.modelRef);
  const text = STRATEGY_TEXT[language];
  const agentReason =
    choice || !config || selection.exhausted ? explainChoice(selection, level, language) : text.noModel;
  const reasons = [...decision.reasons];
  if (selection.exhausted) reasons.push(text.exhausted);

  return {
    ...task,
    testCommand: task.testCommand ?? null,
    score: decision.score,
    ruleTier: decision.tier,
    tier: choice?.tier ?? decision.tier,
    reasons,
    escalatedFrom: selection.movedFrom && choice ? selection.movedFrom.tier : null,
    needsHuman: selection.exhausted,
    capability,
    abilityKind,
    level,
    levelSource,
    band: band.id,
    difficulty: band.difficulty,
    agent,
    agentReason,
    modelRef: choice?.modelRef ?? null,
    model: choice?.modelId ?? null,
    choice,
    meetsTarget: selection.meetsTarget,
    chain: selection.chain,
    options: selection.options,
    passedOver: passedOver(
      selection,
      level,
      {
        contextNeed: CONTEXT_NEED[task.features.context],
        windowOf: (ref) =>
          agents.flatMap((item) => item.models).find((item) => item.modelRef === ref)?.contextWindow ?? null,
      },
      language,
    ),
    evidence: evidenceLine(registry, choice, model?.canonicalId ?? null, language),
    tokens,
    cost: choice?.cost ?? null,
    expectedCost: choice?.expectedCost ?? null,
    levelCosts: levelCosts(all, settings),
    costStrongest: selection.strongest?.cost ?? null,
    splitSuggested: decision.splitSuggested,
  };
}

const middle = (range: CostRange) => (range.low + range.high) / 2;

/**
 * Sums over the tasks that have a price both as routed and on the strongest combination; over a
 * budget, the tasks that could move to a cheaper level, largest saving first, until the plan fits.
 */
export function planTotals(
  tasks: RoutedTask[],
  budget: number | null = null,
): Pick<RoutingPlan, "totals" | "tierCounts" | "budgetAdvice"> {
  const priced = tasks.filter((task) => task.cost && task.costStrongest);
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
  const costStrongest = sum((task) => task.costStrongest);
  const saving = cost && costStrongest && middle(costStrongest) > 0 ? 1 - middle(cost) / middle(costStrongest) : null;
  const expected = tasks.filter((task) => task.expectedCost !== null);
  const expectedCost =
    expected.length === 0 ? null : expected.reduce((total, task) => total + (task.expectedCost ?? 0), 0);
  const tierCounts = { T1: 0, T2: 0, T3: 0 };
  for (const task of tasks) tierCounts[task.tier] += 1;

  let budgetAdvice: RoutingPlan["budgetAdvice"] = null;
  if (budget !== null && expectedCost !== null && expectedCost > budget) {
    const over = expectedCost - budget;
    const moves = tasks
      .flatMap((task) => {
        const current = task.expectedCost;
        if (current === null) return [];
        const lowest = task.features.risks.length > 0 ? RISK_LEVEL : 1;
        // The cheapest level below the current one; equal costs keep the more conservative level.
        let best: { level: StrategyLevel; saving: number } | null = null;
        for (let level = task.level - 1; level >= lowest; level -= 1) {
          const value = task.levelCosts[level - 1];
          if (value === null || value === undefined) continue;
          const gain = current - value;
          if (gain > 1e-9 && (!best || gain > best.saving + 1e-9))
            best = { level: level as StrategyLevel, saving: gain };
        }
        return best ? [{ taskId: task.id, seq: task.seq, ...best }] : [];
      })
      .sort((a, b) => b.saving - a.saving);
    const chosen: typeof moves = [];
    let left = over;
    for (const move of moves) {
      if (left <= 0) break;
      chosen.push(move);
      left -= move.saving;
    }
    budgetAdvice = { over, fits: left <= 0, moves: chosen };
  }
  return {
    totals: {
      cost,
      expectedCost,
      costStrongest,
      saving,
      unpriced: tasks.length - priced.length,
      belowTarget: tasks.filter((task) => task.choice && !task.meetsTarget).length,
    },
    tierCounts,
    budgetAdvice,
  };
}

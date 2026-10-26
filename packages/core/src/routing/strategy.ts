import {
  type AbilityKind,
  type AgentConfig,
  type AgentId,
  type Capability,
  type CostRange,
  type DifficultyBand,
  type EffectivePrice,
  ESCALATE_AFTER,
  LEVEL_SETTINGS,
  type ModelRegistry,
  NATIVE_MARGIN,
  type OptionExclusion,
  type RouteOption,
  STRATEGY_LEVELS,
  type StrategyLevel,
  type TaskFailure,
  type TaskFeatures,
  type TaskOverride,
  type Tier,
  type TierModel,
} from "@km0/shared";
import { type Chance, passProbability, passProbabilityAt } from "../ability/ability";
import {
  agentOffset,
  band,
  currentAbility,
  modelKey,
  priorAbility,
  type RunRecord,
  recordsFor,
} from "../ability/records";
import type { Language } from "../discussion/prompts";
import { SPLIT_SCORE } from "./scoring";

/**
 * Dispatch strategy: which agent and model take a task. Every enabled agent with each model it can
 * run is a candidate; hard constraints rule some out; each remaining one gets a chance of passing
 * on its first run and an expected cost until some run passes, climbing an escalation chain. The
 * strategy level sets how likely the first run must be to pass, judged at a quantile of the
 * ability: the cheapest candidate that meets it wins.
 */

/** What routing knows besides the task and the agents. */
export interface StrategyContext {
  registry: ModelRegistry;
  records: RunRecord[];
  /** A subscription whose quota is used up: the price per token past it, or unavailable; null while within quota. */
  pastQuota?: (model: TierModel) => EffectivePrice | "unavailable" | null;
}

/** Tokens a single request may need: the context window must hold this much. */
export const CONTEXT_NEED: Record<TaskFeatures["context"], number> = { small: 32_000, large: 128_000 };

/** A combination is a step up the chain when it is at least this much more likely to pass. */
export const CHAIN_STEP = 0.02;
/** Runs in a chain, the first included; KM0 Runner's ladders have three rungs. */
export const CHAIN_LENGTH = 3;
/** Risk tasks need at least this chance even at the 10% quantile of the ability. */
export const RISK_FLOOR = { quantile: 0.1, pass: 0.5 } as const;

/** The difficulty band of a task, from the tier the rules give it: imported rules keep deciding the scale. */
export function bandFor(registry: ModelRegistry, tier: Tier, score: number): DifficultyBand {
  const id = tier === "T1" ? "lt15m" : tier === "T2" ? "15m-1h" : score >= SPLIT_SCORE ? "gt4h" : "1h-4h";
  return band(registry, id);
}

export function costOf(
  price: Pick<EffectivePrice, "input" | "output">,
  tokens: { input: CostRange; output: CostRange },
): CostRange | null {
  if (price.input === null || price.output === null) return null;
  const at = (side: keyof CostRange) =>
    (tokens.input[side] * (price.input ?? 0) + tokens.output[side] * (price.output ?? 0)) / 1e6;
  return { low: at("low"), high: at("high") };
}

const middle = (range: CostRange | null) => (range ? (range.low + range.high) / 2 : null);

/** Chance at a level's quantile: the expectation at 0.5, a pessimistic reading below it. */
function chanceAt(chance: Chance, quantile: number): number {
  return quantile >= 0.5 ? passProbability(chance) : passProbabilityAt(chance, quantile);
}

/** A candidate with what selection needs beyond what the UI shows. */
interface Candidate extends RouteOption {
  chance: Chance;
  preference: number;
  midCost: number | null;
}

export interface TaskShape {
  features: TaskFeatures;
  tier: Tier;
  score: number;
  abilityKind: AbilityKind;
  capability: Capability | null;
  tokens: { input: CostRange; output: CostRange };
}

/** Every agent and model that could take the task, before any choice, with the constraints that rule some out. */
export function candidates(
  task: TaskShape,
  agents: AgentConfig[],
  context: StrategyContext,
  /** An agent chosen by hand for the task: a candidate even when disabled, as in KM0 0.1, but only for that. */
  forced?: AgentId,
): Candidate[] {
  const difficulty = bandFor(context.registry, task.tier, task.score).difficulty;
  const need = CONTEXT_NEED[task.features.context];
  const result: Candidate[] = [];
  const usable = agents
    .filter((agent) => agent.enabled || agent.id === forced)
    .sort((a, b) => a.preference - b.preference);
  usable.forEach((agent, preference) => {
    for (const model of agent.models) {
      // An agent cannot be pointed at a model of another API format at all.
      if (agent.apiKinds.length > 0 && !agent.apiKinds.includes(model.providerKind)) continue;
      const past = context.pastQuota?.(model) ?? null;
      const price = past && past !== "unavailable" ? past : model.price;
      const key = modelKey({ canonicalId: model.canonicalId, id: model.modelRef });
      const prior = priorAbility(
        context.registry,
        { canonicalId: model.canonicalId, priceOutPerMTok: model.priceOutPerMTok },
        task.abilityKind,
      );
      const own = recordsFor(context.records, key, task.abilityKind);
      const ability = currentAbility(context.registry, prior.estimate, own);
      const chance: Chance = { ability, offset: agentOffset(context.registry, agent.id, model.native), difficulty };
      const cost = costOf(price, task.tokens);
      let excluded: OptionExclusion | null = null;
      if (!agent.enabled) excluded = "disabled";
      else if (past === "unavailable") excluded = "quota";
      else if (model.contextWindow !== null && model.contextWindow < need) excluded = "context";
      result.push({
        agent: agent.id,
        agentName: agent.name,
        modelRef: model.modelRef,
        modelId: model.modelId,
        modelName: model.name,
        tier: model.tier,
        native: model.native,
        pass: {
          mean: passProbability(chance),
          low: passProbabilityAt(chance, 0.05),
          high: passProbabilityAt(chance, 0.95),
          atLevel: 0,
        },
        cost,
        expectedCost: null,
        coverage: prior.coverage,
        localRecords: own.length,
        capable: task.capability !== null && agent.capabilities.includes(task.capability),
        excluded,
        chance,
        preference,
        midCost: middle(cost),
      });
    }
  });
  return result;
}

/** Failures that rule combinations out: two by hand on one combination, or one rejection of KM0 Runner's work. */
export function failedCombinations(failures: TaskFailure[]): {
  combos: { agent: AgentId | undefined; modelRef: number }[];
  tiers: Tier[];
  last: TaskFailure | null;
} {
  const combos: { agent: AgentId | undefined; modelRef: number }[] = [];
  const tiers: Tier[] = [];
  const counts = new Map<string, number>();
  for (const failure of failures) {
    const key = failure.modelRef === undefined ? `tier:${failure.tier}` : `${failure.agent ?? ""}|${failure.modelRef}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (failure.source !== "runner" && count < ESCALATE_AFTER) continue;
    if (failure.modelRef === undefined) {
      if (!tiers.includes(failure.tier)) tiers.push(failure.tier);
    } else if (!combos.some((combo) => combo.agent === failure.agent && combo.modelRef === failure.modelRef)) {
      combos.push({ agent: failure.agent, modelRef: failure.modelRef });
    }
  }
  return { combos, tiers, last: failures.at(-1) ?? null };
}

const TIER_RANK: Record<Tier, number> = { T1: 1, T2: 2, T3: 3 };

/** Ahead when cheaper in expectation, then likelier to pass, matching the capability, native, earlier in preference. */
function better(a: Candidate, b: Candidate): number {
  const ac = a.expectedCost ?? Number.POSITIVE_INFINITY;
  const bc = b.expectedCost ?? Number.POSITIVE_INFINITY;
  // Costs within a cent or 2% of each other count as equal, so chances decide between near-equal prices.
  const tolerance = Math.max(0.01, 0.02 * Math.min(ac, bc));
  if (Number.isFinite(ac) || Number.isFinite(bc)) {
    if (Math.abs(ac - bc) > tolerance || !Number.isFinite(ac) || !Number.isFinite(bc)) return ac - bc;
  }
  if (a.pass.atLevel !== b.pass.atLevel) return b.pass.atLevel - a.pass.atLevel;
  if (a.capable !== b.capable) return a.capable ? -1 : 1;
  if (a.native !== b.native) return a.native ? -1 : 1;
  return a.preference - b.preference;
}

/**
 * Where a task goes after the given combination fails: a combination at least CHAIN_STEP likelier to
 * pass, from the same agent when it has one, the cheapest per run; then the same from there.
 */
export function chainFrom<T extends Candidate>(start: T, pool: T[]): T[] {
  const chain: T[] = [];
  let current = start;
  while (chain.length < CHAIN_LENGTH - 1) {
    const stronger = pool.filter((item) => item.pass.mean >= current.pass.mean + CHAIN_STEP);
    if (stronger.length === 0) break;
    const sameAgent = stronger.filter((item) => item.agent === current.agent);
    const next = (sameAgent.length > 0 ? sameAgent : stronger).sort(
      (a, b) =>
        (a.midCost ?? Number.POSITIVE_INFINITY) - (b.midCost ?? Number.POSITIVE_INFINITY) || b.pass.mean - a.pass.mean,
    )[0] as T;
    chain.push(next);
    current = next;
  }
  return chain;
}

/** Expected cost until a run passes, trying each step once: c₁ + (1 − p₁)(c₂ + (1 − p₂)(…)). Null when a step has no price. */
export function expectedCost(steps: Candidate[]): number | null {
  let total = 0;
  let reach = 1;
  for (const step of steps) {
    if (step.midCost === null) return null;
    total += reach * step.midCost;
    reach *= 1 - step.pass.mean;
  }
  return total;
}

export interface Selection {
  choice: RouteOption | null;
  chain: RouteOption[];
  options: RouteOption[];
  meetsTarget: boolean;
  /** Something about the choice worth a line: forced by hand, past failures, no combination meeting the risk floor. */
  notes: ("forced" | "escalated" | "riskFloor" | "native")[];
  /** The failed combination the task moved away from, when it did. */
  movedFrom: Candidate | null;
  /** The chain is used up after failures: a person has to decide. */
  exhausted: boolean;
  strongest: RouteOption | null;
}

const strip = ({ chance: _c, preference: _p, midCost: _m, ...option }: Candidate): RouteOption => option;

/** Pick the combination for a task at one strategy level. */
export function select(
  all: Candidate[],
  level: StrategyLevel,
  options: { risky: boolean; failures: TaskFailure[]; override: TaskOverride | null },
): Selection {
  const { target, quantile } = LEVEL_SETTINGS[level];
  const pool: Candidate[] = all.map((item) => ({
    ...item,
    pass: { ...item.pass, atLevel: chanceAt(item.chance, quantile) },
  }));
  const notes: Selection["notes"] = [];

  // A tier set by hand in KM0 0.1 limits the choice to models with that label, when there are any.
  const tier = options.override?.tier;
  const byTier = tier ? pool.filter((item) => item.tier === tier) : [];
  const scoped = byTier.length > 0 ? byTier : pool;

  // Failed runs rule their combinations out, and anything not stronger than them.
  const failed = failedCombinations(options.failures);
  const failedHere = scoped.filter((item) =>
    failed.combos.some(
      (combo) => combo.modelRef === item.modelRef && (combo.agent === undefined || combo.agent === item.agent),
    ),
  );
  const failedTier = Math.max(0, ...failed.tiers.map((t) => TIER_RANK[t]));
  for (const item of scoped) {
    if (failedHere.includes(item)) item.excluded = "failed";
    else if (failedTier > 0 && TIER_RANK[item.tier] <= failedTier && !item.excluded) item.excluded = "failed";
  }
  const floor = Math.max(...failedHere.map((item) => item.pass.mean), Number.NEGATIVE_INFINITY);
  for (const item of scoped) if (!item.excluded && item.pass.mean <= floor) item.excluded = "weaker";
  const movedFrom =
    [...failedHere].sort((a, b) => b.pass.mean - a.pass.mean)[0] ??
    (failedTier > 0 ? (scoped.find((item) => item.excluded === "failed") ?? null) : null);

  // Risk tasks need a chance of at least RISK_FLOOR.pass even when the model is judged pessimistically.
  if (options.risky) {
    const open = scoped.filter((item) => !item.excluded);
    const safe = open.filter((item) => passProbabilityAt(item.chance, RISK_FLOOR.quantile) >= RISK_FLOOR.pass);
    if (safe.length > 0)
      for (const item of open)
        if (!safe.includes(item)) item.excluded = "risk_floor";
        else if (open.length > 0) notes.push("riskFloor");
  }

  // A vendor's own agent takes its model when it is at most NATIVE_MARGIN less likely to pass than another agent.
  for (const item of scoped) {
    if (item.excluded || item.native) continue;
    const own = scoped.find(
      (other) =>
        !other.excluded &&
        other.native &&
        other.modelRef === item.modelRef &&
        other.pass.mean >= item.pass.mean - NATIVE_MARGIN,
    );
    if (own) item.excluded = "native";
  }

  // After a failure, stay with the agent that failed when it has a stronger model.
  let open = scoped.filter((item) => !item.excluded);
  const lastAgent = movedFrom?.agent;
  if (lastAgent && open.some((item) => item.agent === lastAgent))
    open = open.filter((item) => item.agent === lastAgent);
  for (const item of scoped) item.expectedCost = expectedCost([item, ...chainFrom(item, open)]);

  const strongest = [...pool].sort((a, b) => b.pass.mean - a.pass.mean)[0] ?? null;
  const sorted = [...scoped].sort(better);
  const finish = (choice: Candidate | null, meetsTarget: boolean): Selection => ({
    choice: choice ? strip(choice) : null,
    chain: choice ? chainFrom(choice, open).map(strip) : [],
    options: sorted.map(strip),
    meetsTarget,
    notes,
    movedFrom,
    exhausted: choice === null && (failedHere.length > 0 || failedTier > 0),
    strongest: strongest ? strip(strongest) : null,
  });

  // A combination set by hand is used even when a constraint would rule it out.
  const forced = options.override;
  if (forced?.agent || forced?.modelRef !== undefined || forced?.model) {
    const matches = pool.filter(
      (item) =>
        (!forced.agent || item.agent === forced.agent) &&
        (forced.modelRef === undefined || item.modelRef === forced.modelRef) &&
        (!forced.model || item.modelId === forced.model),
    );
    const pick = [...matches].sort(better)[0];
    if (pick) {
      notes.push("forced");
      return finish(pick, pick.pass.atLevel >= target);
    }
  }

  if (movedFrom) notes.push("escalated");
  const meeting = open.filter((item) => item.pass.atLevel >= target).sort(better);
  const choice =
    meeting[0] ??
    [...open].sort((a, b) => b.pass.atLevel - a.pass.atLevel || (a.midCost ?? Infinity) - (b.midCost ?? Infinity))[0] ??
    null;
  if (choice?.native && scoped.some((item) => item.excluded === "native" && item.modelRef === choice.modelRef)) {
    notes.push("native");
  }
  return finish(choice, meeting.length > 0);
}

/** Expected cost of the choice at every level, 1 to 5; with the same inputs, never lower at a more conservative level. */
export function levelCosts(
  all: Candidate[],
  options: { risky: boolean; failures: TaskFailure[]; override: TaskOverride | null },
): (number | null)[] {
  return STRATEGY_LEVELS.map((level) => select(all, level, options).choice?.expectedCost ?? null);
}

export type { Candidate };

const TEXT = {
  "zh-CN": {
    pct: (value: number) => `${Math.round(value * 100)}%`,
    quantile: (q: number) => (q >= 0.5 ? "按均值" : `按 ${Math.round(q * 100)}% 分位`),
    meets: (target: string, q: string) => `在首次通过率达到 ${target}（${q}）的组合中，期望成本最低`,
    best: (target: string) => `没有组合的首次通过率能达到 ${target}，选了最有把握的组合`,
    forced: "手动指定",
    escalated: (agent: string, model: string) => `${model}（${agent}）已在这个任务上失败，换到能力更高的组合；`,
    native: (agent: string) => `；${agent} 是这个模型的本家 Agent`,
    riskFloor: "没有组合达到风险任务的能力下限，选了最有把握的组合",
    exhausted: "升级链已经用完：需要人来决定是拆小、补充说明还是手动处理",
    none: "没有可用的 Agent 和模型组合，使用通用提示词",
    noModel: "这个 Agent 没有可用的模型",
    over: {
      below: (model: string, agent: string, pass: string, target: string) =>
        `${model}（${agent}）首次通过率 ${pass}，低于目标 ${target}`,
      context: (model: string, window: number, need: number) =>
        `${model} 的上下文窗口 ${Math.round(window / 1000)}K，小于任务需要的 ${Math.round(need / 1000)}K`,
      quota: (model: string) => `${model} 的订阅额度已用完`,
      risk_floor: (model: string) => `${model}：风险任务要求即使按 10% 分位估计，通过率也不低于 50%`,
      failed: (model: string, agent: string) => `${model}（${agent}）在这个任务上已经失败`,
      weaker: (model: string, agent: string) => `${model}（${agent}）不比已失败的组合强`,
      native: (model: string, agent: string) => `${model} 改由本家 Agent 运行，而不是 ${agent}`,
      disabled: (agent: string) => `${agent} 已停用`,
    },
    evidence: {
      measured: (count: number, names: string, date: string) => `能力数据：${count} 个榜单（${names}），截至 ${date}`,
      inferred: (date: string) => `能力数据：只有综合指数，其余按榜单之间的关系推算，截至 ${date}`,
      none: "榜单没有这个模型的成绩，能力按价格估计",
      unmatched: "模型注册表里没有这个模型，能力按价格估计",
      local: (count: number) => `本地记录 ${count} 次`,
      join: "；",
    },
  },
  en: {
    pct: (value: number) => `${Math.round(value * 100)}%`,
    quantile: (q: number) => (q >= 0.5 ? "on the expected ability" : `at the ${Math.round(q * 100)}% quantile`),
    meets: (target: string, q: string) =>
      `cheapest expected cost among combinations whose first run passes ${target} of the time (${q})`,
    best: (target: string) => `no combination reaches ${target} on its first run, so the likeliest one is used`,
    forced: "chosen by hand",
    escalated: (agent: string, model: string) =>
      `${model} (${agent}) already failed this task, so a stronger combination takes it; `,
    native: (agent: string) => `; ${agent} is this model's own vendor's agent`,
    riskFloor: "no combination meets the ability floor for risky tasks, so the likeliest one is used",
    exhausted:
      "the escalation chain is used up: a person has to decide whether to split it, clarify it or do it by hand",
    none: "no agent with a model is available; using the generic prompt",
    noModel: "this agent has no model it can run",
    over: {
      below: (model: string, agent: string, pass: string, target: string) =>
        `${model} (${agent}) passes ${pass} on the first run, below the ${target} target`,
      context: (model: string, window: number, need: number) =>
        `${model} has a ${Math.round(window / 1000)}K context window; the task needs ${Math.round(need / 1000)}K`,
      quota: (model: string) => `${model}'s subscription quota is used up`,
      risk_floor: (model: string) => `${model}: risky tasks need at least 50% even at the 10% quantile`,
      failed: (model: string, agent: string) => `${model} (${agent}) already failed this task`,
      weaker: (model: string, agent: string) => `${model} (${agent}) is no stronger than a combination that failed`,
      native: (model: string, agent: string) => `${model} runs in its vendor's own agent rather than ${agent}`,
      disabled: (agent: string) => `${agent} is disabled`,
    },
    evidence: {
      measured: (count: number, names: string, date: string) =>
        `ability data: ${count} leaderboards (${names}), as of ${date}`,
      inferred: (date: string) =>
        `ability data: general indices only, the rest inferred from how leaderboards relate, as of ${date}`,
      none: "no leaderboard has results for this model; its ability is estimated from its price",
      unmatched: "the model registry does not list this model; its ability is estimated from its price",
      local: (count: number) => `${count} local records`,
      join: "; ",
    },
  },
} as const;

/** The sentence that says why the combination was chosen. */
export function explainChoice(selection: Selection, level: StrategyLevel, language: Language): string {
  const text = TEXT[language];
  const { target, quantile } = LEVEL_SETTINGS[level];
  if (selection.notes.includes("forced")) return text.forced;
  if (!selection.choice) return selection.exhausted ? text.exhausted : text.none;
  const moved = selection.movedFrom ? text.escalated(selection.movedFrom.agentName, selection.movedFrom.modelName) : "";
  const why = selection.notes.includes("riskFloor")
    ? text.riskFloor
    : selection.meetsTarget
      ? text.meets(text.pct(target), text.quantile(quantile))
      : text.best(text.pct(target));
  const native = selection.notes.includes("native") ? text.native(selection.choice.agentName) : "";
  return `${moved}${why}${native}`;
}

/** Cheaper combinations that were not chosen, and why; at most `limit`. */
export function passedOver(
  selection: Selection,
  level: StrategyLevel,
  context: { contextNeed: number; windowOf: (modelRef: number) => number | null },
  language: Language,
  limit = 3,
): string[] {
  const text = TEXT[language].over;
  const pct = TEXT[language].pct;
  const choice = selection.choice;
  if (!choice || selection.notes.includes("forced")) return [];
  const cost = choice.expectedCost ?? Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const option of selection.options) {
    if (lines.length >= limit) break;
    if (option.modelRef === choice.modelRef && option.agent === choice.agent) continue;
    if ((option.expectedCost ?? Number.POSITIVE_INFINITY) >= cost) continue;
    const key = `${option.agent}|${option.modelRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    switch (option.excluded) {
      case "context":
        lines.push(text.context(option.modelName, context.windowOf(option.modelRef) ?? 0, context.contextNeed));
        break;
      case "quota":
        lines.push(text.quota(option.modelName));
        break;
      case "risk_floor":
        lines.push(text.risk_floor(option.modelName));
        break;
      case "failed":
        lines.push(text.failed(option.modelName, option.agentName));
        break;
      case "weaker":
        lines.push(text.weaker(option.modelName, option.agentName));
        break;
      case "native":
        lines.push(text.native(option.modelName, option.agentName));
        break;
      case "disabled":
        lines.push(text.disabled(option.agentName));
        break;
      default:
        lines.push(
          text.below(option.modelName, option.agentName, pct(option.pass.atLevel), pct(LEVEL_SETTINGS[level].target)),
        );
    }
  }
  return lines;
}

/** Where the chosen model's ability comes from, in a line. */
export function evidenceLine(
  registry: ModelRegistry,
  choice: RouteOption | null,
  canonicalId: string | null,
  language: Language,
): string {
  if (!choice) return "";
  const text = TEXT[language].evidence;
  const model = canonicalId ? registry.models.find((item) => item.id === canonicalId) : undefined;
  const parts: string[] = [];
  if (choice.coverage === "measured" && model) {
    const ids = [...new Set(model.observations.map((o) => o.source))];
    const names = ids.map((id) => registry.sources.find((source) => source.id === id)?.name ?? id);
    parts.push(text.measured(ids.length, names.slice(0, 3).join(language === "en" ? ", " : "、"), registry.dataDate));
  } else if (choice.coverage === "inferred") {
    parts.push(text.inferred(registry.dataDate));
  } else {
    parts.push(choice.coverage === "none" ? text.none : text.unmatched);
  }
  if (choice.localRecords > 0) parts.push(text.local(choice.localRecords));
  return parts.join(text.join);
}

export const STRATEGY_TEXT = TEXT;

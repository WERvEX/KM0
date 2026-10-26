import type {
  AbilityKind,
  AgentId,
  DifficultyBand,
  Estimate,
  ModelRegistry,
  RegistryFallback,
  RegistryModel,
} from "@km0/shared";
import { passProbability, updateAbility } from "./ability";

/**
 * Abilities as routing uses them: the registry's prior for a model, or a guess for one the registry
 * does not list, corrected by this install's own records of runs.
 */

/** One run recorded on this install: who ran which model on how hard a task, and whether it passed. */
export interface RunRecord {
  /** The registry model, or `model:<id>` for a model the registry does not list. */
  modelKey: string;
  agent: AgentId;
  /** The agent is the official tool of the model's vendor. */
  native: boolean;
  kind: AbilityKind;
  band: DifficultyBand["id"];
  passed: boolean;
  /** A person's verdict can count more than an automatic one. */
  weight: number;
}

/** What records and abilities are keyed by: the registry model, so the same model through two providers shares them. */
export const modelKey = (model: { canonicalId: string | null; id: number }) => model.canonicalId ?? `model:${model.id}`;

/** Used when the registry predates its `fallback` block; the values of the first 1.0 build. */
export const DEFAULT_FALLBACK: RegistryFallback = {
  price: { intercept: -0.32, slope: 0.848, sd: 1.133 },
  noPrice: { mean: -0.234, sd: 3.887 },
  kindSd: { general: 0, frontend: 1.359, backend: 0, debugging: 0, testing: 0.3, docs: 0.3, devops: 1.359 },
  agent: { native: { mean: 0.372, sd: 0.744 }, foreign: { mean: 0, sd: 0.68 } },
};

/** Difficulty bands when the registry has none (tests, an empty registry); the values of the first 1.0 build. */
export const DEFAULT_BANDS: DifficultyBand[] = [
  { id: "lt15m", maxScore: 2, difficulty: { mean: -1.18, sd: 2.278 }, tasks: 194 },
  { id: "15m-1h", maxScore: 5, difficulty: { mean: 0.3, sd: 2.64 }, tasks: 261 },
  { id: "1h-4h", maxScore: 7, difficulty: { mean: 2.793, sd: 2.362 }, tasks: 42 },
  { id: "gt4h", maxScore: null, difficulty: { mean: 3.875, sd: 2.519 }, tasks: 3 },
];

export function band(registry: ModelRegistry, id: DifficultyBand["id"]): DifficultyBand {
  const found =
    registry.difficulty.bands.find((item) => item.id === id) ?? DEFAULT_BANDS.find((item) => item.id === id);
  return found as DifficultyBand;
}

export type Coverage = RegistryModel["coverage"] | "unmatched";

export interface Prior {
  estimate: Estimate;
  coverage: Coverage;
  model: RegistryModel | null;
}

/**
 * The registry's ability for a model and kind of work. A model the registry does not list is
 * guessed from its own output price, by the same line the registry uses for models no leaderboard
 * covers, and otherwise very widely.
 */
export function priorAbility(
  registry: ModelRegistry,
  model: { canonicalId: string | null; priceOutPerMTok: number | null },
  kind: AbilityKind,
): Prior {
  const known = model.canonicalId ? registry.models.find((item) => item.id === model.canonicalId) : undefined;
  if (known) {
    return { estimate: known.abilities[kind] ?? known.abilities.general, coverage: known.coverage, model: known };
  }
  const fallback = registry.fallback ?? DEFAULT_FALLBACK;
  const price = model.priceOutPerMTok;
  const general =
    price !== null && price > 0
      ? { mean: fallback.price.intercept + fallback.price.slope * Math.log10(price), sd: fallback.price.sd }
      : fallback.noPrice;
  return {
    estimate: { mean: general.mean, sd: Math.hypot(general.sd, fallback.kindSd[kind] ?? 0) },
    coverage: "unmatched",
    model: null,
  };
}

/** What an agent adds to a model's ability: from the registry, or the share every native or other agent gets. */
export function agentOffset(registry: ModelRegistry, agent: AgentId, native: boolean): Estimate {
  const known = registry.agents.find((item) => item.id === agent);
  if (known) return native ? known.offset.native : known.offset.foreign;
  const fallback = (registry.fallback ?? DEFAULT_FALLBACK).agent;
  return native ? fallback.native : fallback.foreign;
}

/** Records that inform an ability of this kind: all of them for general, else that kind's and the general ones. */
export function recordsFor(records: RunRecord[], key: string, kind: AbilityKind): RunRecord[] {
  return records.filter(
    (record) => record.modelKey === key && (kind === "general" || record.kind === kind || record.kind === "general"),
  );
}

/** The ability after this install's records: each one updates the prior through the chance it had of passing. */
export function currentAbility(registry: ModelRegistry, prior: Estimate, records: RunRecord[]): Estimate {
  return updateAbility(
    prior,
    records.map((record) => ({
      passed: record.passed,
      difficulty: band(registry, record.band).difficulty,
      offset: agentOffset(registry, record.agent, record.native),
      weight: record.weight,
    })),
  );
}

export interface ModelAbility {
  prior: Estimate;
  current: Estimate;
  /** Chance of passing a typical 15-minute-to-1-hour task with no agent bonus, before and after the records. */
  typical: { prior: number; current: number };
  coverage: Coverage;
  runs: number;
  passed: number;
}

/** A model's general ability, before and after this install's records. */
export function modelAbility(
  registry: ModelRegistry,
  model: { id: number; canonicalId: string | null; priceOutPerMTok: number | null },
  records: RunRecord[],
): ModelAbility {
  const prior = priorAbility(registry, model, "general");
  const own = recordsFor(records, modelKey(model), "general");
  const current = currentAbility(registry, prior.estimate, own);
  const difficulty = band(registry, "15m-1h").difficulty;
  const chance = (ability: Estimate) => passProbability({ ability, offset: { mean: 0, sd: 0 }, difficulty });
  return {
    prior: prior.estimate,
    current,
    typical: { prior: chance(prior.estimate), current: chance(current) },
    coverage: prior.coverage,
    runs: own.length,
    passed: own.filter((record) => record.passed).length,
  };
}

type TierLabel = "T1" | "T2" | "T3";

/**
 * Tier labels by where each model's general ability sits among the user's models: the bottom third
 * T1, the middle T2, the top T3. A single model is T2. Labels set by hand win.
 */
export function tierLabels(models: { id: number; ability: number; label: TierLabel | null }[]): Map<number, TierLabel> {
  const sorted = [...models].sort((a, b) => a.ability - b.ability);
  const labels = new Map<number, TierLabel>();
  for (const model of sorted) {
    // Equal abilities share the label of the first of them.
    const rank = sorted.findIndex((other) => other.ability === model.ability);
    const position = sorted.length === 1 ? 0.5 : rank / (sorted.length - 1);
    const auto: TierLabel = position < 1 / 3 ? "T1" : position < 2 / 3 ? "T2" : "T3";
    labels.set(model.id, model.label ?? auto);
  }
  return labels;
}

/** A registry with no models, for stores and tests built without one; difficulty falls back to DEFAULT_BANDS. */
export const EMPTY_REGISTRY: ModelRegistry = {
  schemaVersion: 1,
  generatedAt: "",
  dataDate: "",
  sources: [],
  difficulty: { bands: [] },
  vendors: [],
  agents: [],
  models: [],
};

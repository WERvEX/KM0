import type { DifficultyBand, Estimate } from "@km0/shared";

/**
 * Chances of passing, and learning from outcomes, on the registry's ability scale. A model with
 * ability θ, run by an agent that adds δ, passes a task of difficulty d with probability σ(θ + δ − d).
 * None of the three is known exactly; each is a normal distribution, and the chance averages over
 * them with the probit approximation σ(μ / √(1 + π s² / 8)).
 */

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** How much uncertainty flattens a logistic curve: the probit approximation's scale factor. */
const flatten = (variance: number) => 1 / Math.sqrt(1 + (Math.PI * variance) / 8);

export interface Chance {
  ability: Estimate;
  offset: Estimate;
  difficulty: Estimate;
}

/** Expected chance of passing, averaged over every uncertainty. */
export function passProbability({ ability, offset, difficulty }: Chance): number {
  const margin = ability.mean + offset.mean - difficulty.mean;
  return sigmoid(margin * flatten(ability.sd ** 2 + offset.sd ** 2 + difficulty.sd ** 2));
}

/**
 * Chance of passing if the model is only as good as the given quantile of what we believe about it.
 * Conservative routing asks for, say, the 10% quantile: a model we know little about then needs a
 * larger margin to be trusted. The task's own spread of difficulty still averages out.
 */
export function passProbabilityAt(chance: Chance, quantile: number): number {
  const spread = Math.sqrt(chance.ability.sd ** 2 + chance.offset.sd ** 2);
  const pessimistic = chance.ability.mean + chance.offset.mean + normalQuantile(quantile) * spread;
  return sigmoid((pessimistic - chance.difficulty.mean) * flatten(chance.difficulty.sd ** 2));
}

/** The difficulty band a routing score falls in: the first whose maximum score is not below it. */
export function bandForScore(score: number, bands: DifficultyBand[]): DifficultyBand {
  const band = bands.find((b) => b.maxScore === null || score <= b.maxScore) ?? bands[bands.length - 1];
  if (!band) throw new Error("The registry has no difficulty bands");
  return band;
}

/** One result of running a model on a task: accepted or not. */
export interface Outcome {
  passed: boolean;
  difficulty: Estimate;
  offset: Estimate;
  /** How much the outcome counts; a person's own verdict can count more than an automatic one. */
  weight?: number;
}

/**
 * The ability after seeing outcomes, as a normal approximation of the posterior (Laplace's method):
 * the mode of prior × likelihood, and the curvature there for the spread. Each outcome's likelihood
 * is flattened by the uncertainty of its task's difficulty and of the agent's offset.
 */
export function updateAbility(prior: Estimate, outcomes: Outcome[]): Estimate {
  if (outcomes.length === 0) return prior;
  const priorPrecision = 1 / Math.max(prior.sd, 1e-3) ** 2;
  const terms = outcomes.map((o) => ({
    sign: o.passed ? 1 : -1,
    scale: flatten(o.difficulty.sd ** 2 + o.offset.sd ** 2),
    shift: o.offset.mean - o.difficulty.mean,
    weight: o.weight ?? 1,
  }));
  let theta = prior.mean;
  let curvature = priorPrecision;
  for (let step = 0; step < 50; step += 1) {
    let gradient = -(theta - prior.mean) * priorPrecision;
    curvature = priorPrecision;
    for (const t of terms) {
      const p = sigmoid(t.sign * t.scale * (theta + t.shift));
      gradient += t.weight * t.sign * t.scale * (1 - p);
      curvature += t.weight * t.scale ** 2 * p * (1 - p);
    }
    const move = Math.max(-1, Math.min(1, gradient / curvature));
    theta += move;
    if (Math.abs(move) < 1e-9) break;
  }
  return { mean: theta, sd: 1 / Math.sqrt(curvature) };
}

/** The standard normal quantile (Acklam's rational approximation, accurate to about 1e-9). */
export function normalQuantile(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239,
  ];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const poly = (coefficients: number[], x: number) => coefficients.reduce((sum, k) => sum * x + k, 0);
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return poly(c, q) / (poly(d, q) * q + 1);
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -poly(c, q) / (poly(d, q) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (poly(a, r) * q) / (poly(b, r) * r + 1);
}

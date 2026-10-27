import {
  type ColumnSpec,
  DEFAULT_FIT,
  type FitResult,
  fitPrior,
  type Observation,
  transform,
  untransform,
} from "./fit";

/**
 * How well the prior predicts results it has not seen, using only public data:
 *
 * - Held-out results: each column's results are split into five folds; each fold is hidden in turn,
 *   the model refitted, and the hidden results predicted. Only results of models that keep at least
 *   one other result are scored, since the rest would be predicted from the prior alone.
 * - New models: models released after a cutoff keep only their Artificial Analysis intelligence
 *   index, the one number new models usually have, and everything else about them is predicted.
 *
 * Coverage is the share of results inside the predicted 90% interval; `extraSd` is chosen so the
 * held-out coverage comes out at 90%, and the build adds it to every published sd.
 */

export interface Prediction {
  model: string;
  column: string;
  actual: number;
  predicted: number;
  /** (actual − predicted) / predictive sd, on the logit scale. */
  z: number;
}

export interface ColumnScore {
  column: string;
  results: number;
  /** Root mean squared error in the column's own units (percentage points, index points or Elo). */
  rmse: number;
  coverage90: number;
}

export interface Evaluation {
  extraSd: number;
  heldOut: { overall: { results: number; coverage90: number; meanAbsZ: number }; columns: ColumnScore[] };
  newModels: {
    cutoff: string;
    models: number;
    overall: { results: number; coverage90: number; meanAbsZ: number };
    columns: ColumnScore[];
  };
  /** Kendall τ between estimated abilities and each column's published values. */
  rankAgreement: { column: string; tau: number; models: number }[];
}

const Z90 = 1.645;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface RawPrediction {
  observation: Observation;
  y: number;
  mean: number;
  /** Predictive variance without the extra sd. */
  variance: number;
  /** β², which scales the extra variance. */
  betaSquared: number;
}

function predict(result: FitResult, specs: Record<string, ColumnSpec>, observation: Observation): RawPrediction | null {
  const spec = specs[observation.column];
  const column = result.columns.get(observation.column);
  const ability = result.ability.get(observation.model);
  if (!spec || !column || !ability) return null;
  const cap = spec.capability === "general" ? null : result.capability.get(`${observation.model}|${spec.capability}`);
  const agent = observation.agent
    ? result.agent.get(`${observation.agent}|${observation.native ? "native" : "foreign"}`)
    : null;
  const latentMean = ability.mean + (cap?.mean ?? 0) + (agent?.mean ?? 0);
  const latentVar = ability.sd ** 2 + (cap ? cap.sd ** 2 : 0) + (agent ? agent.sd ** 2 : 0);
  return {
    observation,
    y: transform(spec, observation.value),
    mean: column.alpha + column.beta * latentMean,
    variance: column.beta ** 2 * latentVar + column.sigma ** 2 / spec.weight,
    betaSquared: column.beta ** 2,
  };
}

function score(predictions: RawPrediction[], specs: Record<string, ColumnSpec>, extraSd: number) {
  const scored: Prediction[] = predictions.map((p) => {
    const spec = specs[p.observation.column] as ColumnSpec;
    const sd = Math.sqrt(p.variance + p.betaSquared * extraSd ** 2);
    return {
      model: p.observation.model,
      column: p.observation.column,
      actual: p.observation.value,
      predicted: untransform(spec, p.mean),
      z: (p.y - p.mean) / sd,
    };
  });
  const overall = {
    results: scored.length,
    coverage90: scored.filter((p) => Math.abs(p.z) <= Z90).length / Math.max(1, scored.length),
    meanAbsZ: scored.reduce((sum, p) => sum + Math.abs(p.z), 0) / Math.max(1, scored.length),
  };
  const columns = [...new Set(scored.map((p) => p.column))].sort().map((column) => {
    const rows = scored.filter((p) => p.column === column);
    return {
      column,
      results: rows.length,
      rmse: Math.sqrt(rows.reduce((sum, p) => sum + (p.actual - p.predicted) ** 2, 0) / rows.length),
      coverage90: rows.filter((p) => Math.abs(p.z) <= Z90).length / rows.length,
    };
  });
  return { overall, columns };
}

function kendall(xs: number[], ys: number[]): number {
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = i + 1; j < xs.length; j += 1) {
      const s = Math.sign(((xs[i] as number) - (xs[j] as number)) * ((ys[i] as number) - (ys[j] as number)));
      if (s > 0) concordant += 1;
      else if (s < 0) discordant += 1;
    }
  }
  return (concordant - discordant) / Math.max(1, concordant + discordant);
}

export function evaluate(
  observations: Observation[],
  specs: Record<string, ColumnSpec>,
  released: Map<string, string | null>,
  cutoff: string,
  folds = 5,
): Evaluation {
  const perModel = new Map<string, number>();
  for (const o of observations) perModel.set(o.model, (perModel.get(o.model) ?? 0) + 1);

  const heldOut: RawPrediction[] = [];
  const columns = [...new Set(observations.map((o) => o.column))].sort();
  for (const column of columns) {
    for (let fold = 0; fold < folds; fold += 1) {
      const hidden = observations.filter(
        (o) =>
          o.column === column && hash(`${o.model}|${o.agent}`) % folds === fold && (perModel.get(o.model) ?? 0) > 1,
      );
      if (hidden.length === 0) continue;
      const hiddenSet = new Set(hidden);
      const result = fitPrior(
        observations.filter((o) => !hiddenSet.has(o)),
        specs,
        { ...DEFAULT_FIT, iterations: 150 },
      );
      for (const o of hidden) {
        const p = predict(result, specs, o);
        if (p) heldOut.push(p);
      }
    }
  }

  // The extra sd that brings held-out coverage to 90%.
  let extraSd = 0;
  for (let candidate = 0; candidate <= 1.5; candidate += 0.01) {
    extraSd = candidate;
    if (score(heldOut, specs, candidate).overall.coverage90 >= 0.9) break;
  }

  const recent = new Set(
    [...perModel.keys()].filter((model) => {
      const date = released.get(model);
      const hasIndex = observations.some((o) => o.model === model && o.column === "aa_intelligence");
      return Boolean(date && date >= cutoff && hasIndex && (perModel.get(model) ?? 0) > 1);
    }),
  );
  const newHidden = observations.filter((o) => recent.has(o.model) && o.column !== "aa_intelligence");
  const newHiddenSet = new Set(newHidden);
  const newResult = fitPrior(
    observations.filter((o) => !newHiddenSet.has(o)),
    specs,
  );
  const newPredictions = newHidden.flatMap((o) => {
    const p = predict(newResult, specs, o);
    return p ? [p] : [];
  });

  const full = fitPrior(observations, specs);
  const rankAgreement = columns.map((column) => {
    const rows = observations.filter((o) => o.column === column && !o.agent);
    const abilities = rows.map((o) => full.ability.get(o.model)?.mean ?? 0);
    return {
      column,
      tau: kendall(
        abilities,
        rows.map((o) => o.value),
      ),
      models: rows.length,
    };
  });

  return {
    extraSd,
    heldOut: score(heldOut, specs, extraSd),
    newModels: { cutoff, models: recent.size, ...score(newPredictions, specs, extraSd) },
    rankAgreement,
  };
}

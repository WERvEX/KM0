/**
 * The joint model behind the priors. Every leaderboard result is a noisy linear reading of one
 * latent ability per model, on a logit scale anchored on SWE-bench Verified:
 *
 *   y = α_col + β_col · (θ_model + γ_model,capability + δ_agent) + ε,   ε ~ N(0, σ_col² / weight_col)
 *
 * θ is the model's coding ability in a neutral harness; γ lets a model be better or worse at
 * frontend or devops work than its general ability says; δ is what the agent adds, with one value
 * for the agent's own vendor's models ("native") and one for any other model. All are given normal
 * priors and fitted by alternating updates, which also yields a posterior standard deviation for
 * each, so models with few results come out with wide intervals.
 */

export type Capability = "general" | "frontend" | "devops";

export interface ColumnSpec {
  transform: "rate" | "index" | "elo";
  capability: Capability;
  weight: number;
  anchor?: boolean;
}

export interface Observation {
  model: string;
  column: string;
  /** Null for model-only results and the reference harness. */
  agent: string | null;
  native: boolean;
  /** As published. */
  value: number;
  source?: string;
  effort?: string | null;
  date?: string | null;
}

export interface FitOptions {
  /** Prior sd of θ around the prior mean. */
  abilitySd: number;
  /** Prior sd of the capability deviations γ. */
  capabilitySd: number;
  /** Prior sd of each agent offset around its prior mean. */
  agentSd: number;
  /** Prior mean of the shared native-agent effect. */
  nativeMean: number;
  iterations: number;
}

export const DEFAULT_FIT: FitOptions = {
  abilitySd: 2,
  capabilitySd: 0.7,
  agentSd: 0.35,
  nativeMean: 0.25,
  iterations: 300,
};

export interface Normal {
  mean: number;
  sd: number;
}

export interface ColumnFit {
  alpha: number;
  beta: number;
  sigma: number;
  observations: number;
}

export interface FitResult {
  ability: Map<string, Normal>;
  /** Keyed `${model}|${capability}` for frontend and devops. */
  capability: Map<string, Normal>;
  /** Keyed `${agent}|native` and `${agent}|foreign`. */
  agent: Map<string, Normal & { evidence: number }>;
  nativeEffect: Normal;
  columns: Map<string, ColumnFit>;
}

const logit = (p: number) => Math.log(p / (1 - p));

/** A published value on the logit scale. */
export function transform(spec: ColumnSpec, value: number): number {
  if (spec.transform === "elo") return ((value - 1250) * Math.LN10) / 400;
  const p = Math.min(0.995, Math.max(0.005, value / 100));
  return logit(p);
}

/** The inverse of `transform`, for predicting a column's published value. */
export function untransform(spec: ColumnSpec, y: number): number {
  if (spec.transform === "elo") return 1250 + (y * 400) / Math.LN10;
  return 100 / (1 + Math.exp(-y));
}

interface Prepared {
  model: number;
  column: number;
  agentKey: number | null;
  capKey: number | null;
  y: number;
}

/** Fit the model to the observations. Models without observations are absent from the result. */
export function fitPrior(
  observations: Observation[],
  specs: Record<string, ColumnSpec>,
  options: FitOptions = DEFAULT_FIT,
): FitResult {
  const models = [...new Set(observations.map((o) => o.model))].sort();
  const columns = [...new Set(observations.map((o) => o.column))].filter((c) => specs[c]).sort();
  const modelIndex = new Map(models.map((m, i) => [m, i]));
  const columnIndex = new Map(columns.map((c, i) => [c, i]));
  const agentKeys: string[] = [];
  const agentIndex = new Map<string, number>();
  const capKeys: string[] = [];
  const capIndex = new Map<string, number>();
  const intern = (keys: string[], index: Map<string, number>, key: string) => {
    let at = index.get(key);
    if (at === undefined) {
      at = keys.length;
      keys.push(key);
      index.set(key, at);
    }
    return at;
  };

  const data: Prepared[] = [];
  for (const o of observations) {
    const column = columnIndex.get(o.column);
    const spec = specs[o.column];
    if (column === undefined || !spec) continue;
    data.push({
      model: modelIndex.get(o.model) as number,
      column,
      agentKey: o.agent ? intern(agentKeys, agentIndex, `${o.agent}|${o.native ? "native" : "foreign"}`) : null,
      capKey: spec.capability === "general" ? null : intern(capKeys, capIndex, `${o.model}|${spec.capability}`),
      y: transform(spec, o.value),
    });
  }

  const columnSpecs = columns.map((c) => specs[c] as ColumnSpec);
  const theta = new Float64Array(models.length);
  const thetaPrec = new Float64Array(models.length);
  const gamma = new Float64Array(capKeys.length);
  const gammaPrec = new Float64Array(capKeys.length);
  const delta = new Float64Array(agentKeys.length);
  const deltaPrec = new Float64Array(agentKeys.length);
  const alpha = new Float64Array(columns.length);
  const beta = new Float64Array(columns.length).fill(1);
  const sigma = new Float64Array(columns.length).fill(0.5);
  let nativeEffect = options.nativeMean;
  let nativePrec = 1 / options.agentSd ** 2;

  // Start each column at its mean, so the first ability update is not dragged by offsets.
  for (let j = 0; j < columns.length; j += 1) {
    const ys = data.filter((d) => d.column === j).map((d) => d.y);
    alpha[j] = columnSpecs[j]?.anchor ? 0 : ys.reduce((a, b) => a + b, 0) / Math.max(1, ys.length);
  }

  const latent = (d: Prepared) =>
    (theta[d.model] as number) +
    (d.capKey === null ? 0 : (gamma[d.capKey] as number)) +
    (d.agentKey === null ? 0 : (delta[d.agentKey] as number));
  const weightOf = (d: Prepared) => (columnSpecs[d.column]?.weight ?? 1) / (sigma[d.column] as number) ** 2;

  const byModel = groupBy(data, (d) => d.model, models.length);
  const byCap = groupBy(
    data.filter((d) => d.capKey !== null),
    (d) => d.capKey as number,
    capKeys.length,
  );
  const byAgent = groupBy(
    data.filter((d) => d.agentKey !== null),
    (d) => d.agentKey as number,
    agentKeys.length,
  );
  const byColumn = groupBy(data, (d) => d.column, columns.length);

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    // Columns: weighted least squares of y on the latent value, with a mild prior pulling β to 1.
    for (let j = 0; j < columns.length; j += 1) {
      const rows = byColumn[j] ?? [];
      const spec = columnSpecs[j] as ColumnSpec;
      if (!spec.anchor && rows.length >= 2) {
        let sx = 0;
        let sy = 0;
        for (const d of rows) {
          sx += latent(d);
          sy += d.y;
        }
        const mx = sx / rows.length;
        const my = sy / rows.length;
        let sxx = 0;
        let sxy = 0;
        for (const d of rows) {
          sxx += (latent(d) - mx) ** 2;
          sxy += (latent(d) - mx) * (d.y - my);
        }
        // Prior β ~ N(1, 1), in units of the residual variance.
        const s2 = (sigma[j] as number) ** 2;
        const b = Math.max(0.05, (sxy + s2) / (sxx + s2));
        beta[j] = b;
        alpha[j] = my - b * mx;
      }
      // Residual sd from leave-one-out residuals: a model seen only in this column fits it exactly,
      // so each residual is weighted by how little the model's ability rests on it (1 − leverage).
      // Shrunk towards 0.5 when a column has little independent evidence.
      let rss = 0;
      let dof = 0;
      for (const d of rows) {
        const residual = d.y - (alpha[j] as number) - (beta[j] as number) * latent(d);
        // The ability and, for frontend and devops columns, the capability deviation both fit the row.
        const thetaP = thetaPrec[d.model] as number;
        const gammaP = d.capKey === null ? 0 : (gammaPrec[d.capKey] as number);
        const spread = (thetaP > 0 ? 1 / thetaP : 0) + (gammaP > 0 ? 1 / gammaP : 0);
        const leverage = (beta[j] as number) ** 2 * (spec.weight / (sigma[j] as number) ** 2) * spread;
        // A row the model's own parameters fit almost alone says nothing about the column's noise.
        if (leverage > 0.9) continue;
        rss += residual ** 2 / (1 - leverage);
        dof += 1 - leverage;
      }
      const prior = 4;
      sigma[j] = Math.max(0.1, Math.sqrt((rss + prior * 0.25) / (dof + prior)));
    }

    // Abilities.
    for (let m = 0; m < models.length; m += 1) {
      let precision = 1 / options.abilitySd ** 2;
      let sum = 0;
      for (const d of byModel[m] ?? []) {
        const b = beta[d.column] as number;
        const w = weightOf(d);
        const rest = latent(d) - (theta[m] as number);
        precision += b * b * w;
        sum += b * w * (d.y - (alpha[d.column] as number) - b * rest);
      }
      theta[m] = sum / precision;
      thetaPrec[m] = precision;
    }

    // Capability deviations.
    for (let k = 0; k < capKeys.length; k += 1) {
      let precision = 1 / options.capabilitySd ** 2;
      let sum = 0;
      for (const d of byCap[k] ?? []) {
        const b = beta[d.column] as number;
        const w = weightOf(d);
        const rest = latent(d) - (gamma[k] as number);
        precision += b * b * w;
        sum += b * w * (d.y - (alpha[d.column] as number) - b * rest);
      }
      gamma[k] = sum / precision;
      gammaPrec[k] = precision;
    }

    // Agent offsets: native ones share a mean that is itself estimated.
    const agentPrior = 1 / options.agentSd ** 2;
    for (let k = 0; k < agentKeys.length; k += 1) {
      const native = (agentKeys[k] as string).endsWith("|native");
      let precision = agentPrior;
      let sum = agentPrior * (native ? nativeEffect : 0);
      for (const d of byAgent[k] ?? []) {
        const b = beta[d.column] as number;
        const w = weightOf(d);
        const rest = latent(d) - (delta[k] as number);
        precision += b * b * w;
        sum += b * w * (d.y - (alpha[d.column] as number) - b * rest);
      }
      delta[k] = sum / precision;
      deltaPrec[k] = precision;
    }
    const natives = agentKeys.map((key, k) => (key.endsWith("|native") ? k : -1)).filter((k) => k >= 0);
    nativePrec = 1 / options.agentSd ** 2 + natives.length * agentPrior;
    nativeEffect =
      (options.nativeMean / options.agentSd ** 2 + natives.reduce((s, k) => s + (delta[k] as number), 0) * agentPrior) /
      nativePrec;
  }

  const ability = new Map<string, Normal>();
  models.forEach((m, i) => {
    ability.set(m, { mean: theta[i] as number, sd: 1 / Math.sqrt(thetaPrec[i] as number) });
  });
  const capability = new Map<string, Normal>();
  capKeys.forEach((key, k) => {
    capability.set(key, { mean: gamma[k] as number, sd: 1 / Math.sqrt(gammaPrec[k] as number) });
  });
  const agent = new Map<string, Normal & { evidence: number }>();
  agentKeys.forEach((key, k) => {
    agent.set(key, {
      mean: delta[k] as number,
      sd: 1 / Math.sqrt(deltaPrec[k] as number),
      evidence: byAgent[k]?.length ?? 0,
    });
  });
  const columnFits = new Map<string, ColumnFit>();
  columns.forEach((c, j) => {
    columnFits.set(c, {
      alpha: alpha[j] as number,
      beta: beta[j] as number,
      sigma: sigma[j] as number,
      observations: byColumn[j]?.length ?? 0,
    });
  });
  return {
    ability,
    capability,
    agent,
    nativeEffect: { mean: nativeEffect, sd: 1 / Math.sqrt(nativePrec) },
    columns: columnFits,
  };
}

function groupBy<T>(items: T[], key: (item: T) => number, size: number): T[][] {
  const groups: T[][] = Array.from({ length: size }, () => []);
  for (const item of items) groups[key(item)]?.push(item);
  return groups;
}

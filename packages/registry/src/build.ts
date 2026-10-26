import {
  type AbilityKind,
  type Estimate,
  type ModelRegistry,
  REGISTRY_SCHEMA_VERSION,
  type RegistryAgent,
  type RegistryModel,
} from "@km0/shared";
import { type DifficultyFit, fitDifficulty } from "./difficulty";
import { type Evaluation, evaluate } from "./evaluate";
import { DEFAULT_FIT, type FitResult, fitPrior } from "./fit";
import { type Aligned, align, type Tables } from "./observations";
import type { OpenRouterModel, Snapshots } from "./sources";

/** Models released on or after this date are the "new models" of the evaluation. */
const NEW_MODEL_CUTOFF_MONTHS = 4;
/** Extra uncertainty for work no leaderboard measures directly. */
const UNMEASURED_KIND_SD = 0.3;

export interface Built {
  registry: ModelRegistry;
  aligned: Aligned;
  result: FitResult;
  difficulty: DifficultyFit;
  evaluation: Evaluation;
  /** The price fallback for models without results: ability ≈ intercept + slope · log10(output $/Mtok). */
  priceFallback: { intercept: number; slope: number; sd: number; models: number };
}

const round = (value: number, digits = 3) => Number(value.toFixed(digits));
const est = (mean: number, sd: number): Estimate => ({ mean: round(mean), sd: round(sd) });
// OpenRouter marks a variable price, such as its own router's, with a negative number.
const perMillion = (perToken: number | null) => (perToken === null || perToken < 0 ? null : round(perToken * 1e6, 4));

function shiftMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function build(snapshots: Snapshots, tables: Tables): Built {
  const catalog = snapshots.openrouter.models;
  const aligned = align(snapshots.parsed, catalog, tables);
  const result = fitPrior(aligned.observations, tables.columns, DEFAULT_FIT);
  const difficulty = fitDifficulty(snapshots.swebench);
  const released = new Map(catalog.map((m) => [m.id, new Date(m.created * 1000).toISOString().slice(0, 10)]));

  const dataDate = [...aligned.counts.values()]
    .map((count) => count.newest ?? "")
    .reduce((a, b) => (a > b ? a : b), "");
  const evaluation = evaluate(
    aligned.observations,
    tables.columns,
    released,
    shiftMonths(dataDate, -NEW_MODEL_CUTOFF_MONTHS),
  );

  // Fitted abilities live on the logit-of-Verified scale; the registry uses the Rasch scale of the
  // difficulty bands, so a model's chance on a task is σ(ability − difficulty).
  const { intercept, slope, residualSd } = difficulty.link;
  const toScale = (value: Estimate): Estimate =>
    est(
      intercept + slope * value.mean,
      Math.sqrt(slope ** 2 * (value.sd ** 2 + evaluation.extraSd ** 2) + residualSd ** 2),
    );
  const offset = (value: Estimate): Estimate => est(slope * value.mean, slope * value.sd);

  const priceFallback = fitPriceFallback(catalog, result);
  const models: RegistryModel[] = catalog.map((model) => {
    const observations = aligned.observations.filter((o) => o.model === model.id);
    const columns = new Set(observations.map((o) => o.column));
    const coverage: RegistryModel["coverage"] =
      observations.length === 0
        ? "none"
        : [...columns].every((c) => c.startsWith("aa_intelligence"))
          ? "inferred"
          : "measured";
    const fitted = result.ability.get(model.id);
    const outputPrice = perMillion(model.pricing.completion);
    const general: Estimate = fitted
      ? toScale(fitted)
      : outputPrice && outputPrice > 0
        ? toScale({
            mean: priceFallback.intercept + priceFallback.slope * Math.log10(outputPrice),
            sd: priceFallback.sd,
          })
        : toScale({ mean: 0, sd: DEFAULT_FIT.abilitySd });
    const withDeviation = (capability: "frontend" | "devops"): Estimate => {
      const deviation = result.capability.get(`${model.id}|${capability}`) ?? {
        mean: 0,
        sd: DEFAULT_FIT.capabilitySd,
      };
      return est(general.mean + slope * deviation.mean, Math.hypot(general.sd, slope * deviation.sd));
    };
    const widen = (value: Estimate): Estimate => est(value.mean, Math.hypot(value.sd, UNMEASURED_KIND_SD));
    const abilities: Record<AbilityKind, Estimate> = {
      general,
      backend: general,
      debugging: general,
      testing: widen(general),
      docs: widen(general),
      frontend: withDeviation("frontend"),
      devops: withDeviation("devops"),
    };
    const shortId = model.id.split("/").slice(1).join("/");
    const aliases = [...new Set([shortId, ...(aligned.spellings.get(model.id) ?? [])])]
      .filter((alias) => alias !== model.id)
      .sort();
    return {
      id: model.id,
      name: model.name.replace(/^[^:]{1,40}:\s+/, ""),
      vendor: model.id.split("/")[0] ?? "",
      aliases,
      released: released.get(model.id) ?? null,
      contextWindow: model.contextLength && model.contextLength > 0 ? model.contextLength : null,
      pricing: {
        input: perMillion(model.pricing.prompt),
        output: outputPrice,
        cacheRead: perMillion(model.pricing.cacheRead),
      },
      abilities,
      coverage,
      observations: observations.map((o) => ({
        column: o.column,
        source: o.source ?? "",
        agent: o.agent,
        value: round(o.value, 2),
        effort: o.effort ?? null,
        date: o.date ?? null,
      })),
    };
  });

  const agents: RegistryAgent[] = tables.agents
    .filter((agent) => !agent.reference)
    .map((agent) => {
      const native = result.agent.get(`${agent.id}|native`);
      const foreign = result.agent.get(`${agent.id}|foreign`);
      return {
        id: agent.id,
        name: agent.name,
        nativeVendors: agent.nativeVendors,
        offset: {
          // Without results of its own, a native agent gets the effect native agents share.
          native: offset(
            native ??
              (agent.nativeVendors.length > 0
                ? { mean: result.nativeEffect.mean, sd: Math.hypot(result.nativeEffect.sd, DEFAULT_FIT.agentSd) }
                : { mean: 0, sd: DEFAULT_FIT.agentSd }),
          ),
          foreign: offset(foreign ?? { mean: 0, sd: DEFAULT_FIT.agentSd }),
        },
        evidence: (native?.evidence ?? 0) + (foreign?.evidence ?? 0),
      };
    });

  const generatedAt = [snapshots.openrouter.fetchedAt, ...snapshots.parsed.map((s) => s.fetchedAt)]
    .reduce((a, b) => (a > b ? a : b))
    .slice(0, 19)
    .concat("Z");

  const registry: ModelRegistry = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    generatedAt,
    dataDate,
    sources: snapshots.parsed.map((source) => {
      const count = aligned.counts.get(source.info.id);
      return {
        ...source.info,
        fetchedAt: source.fetchedAt,
        newestEntry: count?.newest ?? null,
        entries: source.entries.length,
        unmatched: count?.unmatched ?? 0,
      };
    }),
    difficulty: {
      bands: difficulty.bands.map((band) => ({
        id: band.id,
        maxScore: band.maxScore,
        difficulty: est(band.mean, band.sd),
        tasks: band.tasks,
      })),
    },
    vendors: tables.vendors.map((vendor) => ({ ...vendor })),
    agents,
    models: models.sort((a, b) => a.id.localeCompare(b.id)),
  };
  return { registry, aligned, result, difficulty, evaluation, priceFallback };
}

/** Least squares of fitted ability on log10 of the output price, for models no leaderboard covers. */
function fitPriceFallback(catalog: OpenRouterModel[], result: FitResult) {
  const points: [number, number][] = [];
  for (const model of catalog) {
    const ability = result.ability.get(model.id);
    const price = model.pricing.completion === null ? 0 : model.pricing.completion * 1e6;
    if (ability && price > 0) points.push([Math.log10(price), ability.mean]);
  }
  const n = points.length;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  const sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const sxy = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const slopeValue = sxx > 0 ? sxy / sxx : 0;
  const interceptValue = my - slopeValue * mx;
  const sd = Math.sqrt(
    points.reduce((s, [x, y]) => s + (y - interceptValue - slopeValue * x) ** 2, 0) / Math.max(1, n - 2),
  );
  return { intercept: interceptValue, slope: slopeValue, sd, models: n };
}

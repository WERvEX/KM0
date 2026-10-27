import {
  type Billing,
  createMatcher,
  type EffectivePrice,
  type Matcher,
  type ModelRegistry,
  nameWords,
  type RegistryModel,
} from "@km0/shared";

/** A model's own price overrides, USD per million tokens. */
export interface PriceOverrides {
  priceInPerMTok: number | null;
  priceOutPerMTok: number | null;
  priceCacheReadPerMTok: number | null;
}

/**
 * What a run on a model costs per million tokens under its provider's billing. Prices the user set
 * on the model win; otherwise the official price from the registry is used. A relay multiplies the
 * price; inside a subscription or for a free model a run costs nothing extra.
 */
export function effectivePrice(
  billing: Billing,
  model: PriceOverrides,
  official: RegistryModel["pricing"] | null,
): EffectivePrice {
  if (billing.mode === "subscription" || billing.mode === "free") {
    return { mode: billing.mode, input: 0, output: 0, cacheRead: 0, source: "billing" };
  }
  const own = model.priceInPerMTok !== null || model.priceOutPerMTok !== null;
  const base = {
    input: model.priceInPerMTok ?? official?.input ?? null,
    output: model.priceOutPerMTok ?? official?.output ?? null,
    cacheRead: model.priceCacheReadPerMTok ?? official?.cacheRead ?? null,
  };
  const source = own
    ? "model"
    : official && (official.input !== null || official.output !== null)
      ? "registry"
      : "none";
  const factor = billing.mode === "relay" ? billing.multiplier : 1;
  const scale = (value: number | null) => (value === null ? null : Number((value * factor).toFixed(6)));
  return {
    mode: billing.mode,
    input: scale(base.input),
    output: scale(base.output),
    cacheRead: scale(base.cacheRead),
    source,
  };
}

export type RegistryMatch =
  | { canonicalId: string; problem: null; candidates: [] }
  | { canonicalId: null; problem: "unmatched" | "ambiguous"; candidates: string[] };

const matchers = new WeakMap<ModelRegistry, Matcher>();

/** The registry model a user's model ID (or display name) is, by the same rules the registry build uses. */
export function matchRegistryModel(registry: ModelRegistry, ...spellings: string[]): RegistryMatch {
  let matcher = matchers.get(registry);
  if (!matcher) {
    // A model's own ID and name decide first. Leaderboard spellings only help when they name one model
    // and do not read as another model's own name ("DeepSeek-V4 Flash [high]" must not claim the
    // dated snapshot when "deepseek-v4-flash" itself is listed).
    const own = new Set(
      registry.models.flatMap((model) => [model.id, model.name].map((name) => nameWords(name).join(" "))),
    );
    const owners = new Map<string, Set<string>>();
    for (const model of registry.models) {
      for (const alias of model.aliases) {
        const key = nameWords(alias).join(" ");
        if (own.has(key)) continue;
        const ids = owners.get(key) ?? new Set<string>();
        ids.add(model.id);
        owners.set(key, ids);
      }
    }
    const aliases: Record<string, string> = {};
    for (const model of registry.models) {
      for (const alias of model.aliases) {
        const ids = owners.get(nameWords(alias).join(" "));
        if (ids?.size === 1) aliases[alias] = model.id;
      }
    }
    matcher = createMatcher(
      registry.models.map((model) => ({ id: model.id, name: model.name })),
      aliases,
    );
    matchers.set(registry, matcher);
  }
  let ambiguous: string[] | null = null;
  for (const spelling of spellings) {
    if (!spelling.trim()) continue;
    const result = matcher.match(spelling);
    if ("id" in result) return { canonicalId: result.id, problem: null, candidates: [] };
    if (result.problem === "ambiguous" && !ambiguous) ambiguous = result.candidates;
  }
  return ambiguous
    ? { canonicalId: null, problem: "ambiguous", candidates: ambiguous }
    : { canonicalId: null, problem: "unmatched", candidates: [] };
}

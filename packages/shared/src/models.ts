import { z } from "zod";
import { ProviderKind, StructuredMode } from "./llm";
import { Estimate } from "./registry";

/** Tier labels; routing.ts re-exports the same enum as `Tier`. */
const TierLabel = z.enum(["T1", "T2", "T3"]);

/**
 * Providers and models. A provider is how models are reached and paid for: an API endpoint with a
 * key, a relay, or a subscription an agent signs in to by itself. Its models serve KM0's own calls
 * (triage, questions, documents) and the coding agents alike.
 */

const Price = z.number().nonnegative().max(10_000).nullable();

/** A usage limit of a subscription. */
export const Quota = z.object({
  amount: z.number().positive(),
  unit: z.enum(["requests", "tokens", "usd"]),
  window: z.enum(["5h", "day", "week", "month"]),
});
export type Quota = z.infer<typeof Quota>;

/**
 * How a provider charges. token: per million tokens, at the model's price or the official one from
 * the registry; relay: official price times a multiplier; subscription: a monthly fee, so a run
 * costs nothing extra until the quota runs out; free: no charge, as with a local model.
 */
export const Billing = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("token") }),
  z.object({ mode: z.literal("relay"), multiplier: z.number().positive().max(100) }),
  z.object({
    mode: z.literal("subscription"),
    monthlyFee: Price,
    quota: Quota.nullable(),
    /** What happens past the quota: pay per token, or the model is unavailable until it resets. */
    overflow: z.enum(["token", "unavailable"]),
  }),
  z.object({ mode: z.literal("free") }),
]);
export type Billing = z.infer<typeof Billing>;
export type BillingMode = Billing["mode"];

export const DEFAULT_BILLING: Billing = { mode: "token" };

export const ProviderInput = z.object({
  name: z.string().trim().min(1).max(80),
  kind: ProviderKind,
  baseUrl: z.url().nullable().default(null),
  /** Plain text key; only ever sent from the renderer when the user types a new one. */
  apiKey: z.string().max(4096).optional(),
  billing: Billing.default(DEFAULT_BILLING),
});
export type ProviderInput = z.input<typeof ProviderInput>;

export const Provider = z.object({
  id: z.number().int(),
  name: z.string(),
  kind: ProviderKind,
  baseUrl: z.string().nullable(),
  hasApiKey: z.boolean(),
  apiKeyHint: z.string().nullable(),
  billing: Billing,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Provider = z.infer<typeof Provider>;

export const ModelInput = z.object({
  providerId: z.number().int().positive(),
  /** As the provider or agent expects it, such as "claude-opus-5-5" or "deepseek-v4-flash". */
  modelId: z.string().trim().min(1).max(200),
  /** How KM0 shows the model; unique. Empty uses the model ID. */
  name: z.string().trim().max(80).default(""),
  /** The registry model it is, chosen by hand; null matches it by its ID. */
  canonicalId: z.string().trim().min(1).max(200).nullable().default(null),
  /** Tokens; null uses the registry's figure. */
  contextWindow: z.number().int().positive().nullable().default(null),
  structuredMode: StructuredMode.default("auto"),
  temperature: z.number().min(0).max(2).nullable().default(null),
  /** USD per million tokens; null uses the official price from the registry. */
  priceInPerMTok: Price.default(null),
  priceOutPerMTok: Price.default(null),
  priceCacheReadPerMTok: Price.default(null),
  /** Tier label chosen by hand; null places it by ability among the user's models. */
  tierLabel: TierLabel.nullable().default(null),
});
export type ModelInput = z.input<typeof ModelInput>;
export type ModelFields = z.output<typeof ModelInput>;

/** What a run on the model costs per million tokens, after the provider's billing is applied. */
export const EffectivePrice = z.object({
  mode: z.enum(["token", "relay", "subscription", "free"]),
  /** USD per million tokens actually paid per run; 0 inside a subscription or for a free model; null when unknown. */
  input: z.number().nullable(),
  output: z.number().nullable(),
  cacheRead: z.number().nullable(),
  /** Where the prices come from. */
  source: z.enum(["model", "registry", "none", "billing"]),
});
export type EffectivePrice = z.infer<typeof EffectivePrice>;

export const ModelEntry = z.object({
  id: z.number().int(),
  providerId: z.number().int(),
  providerName: z.string(),
  providerKind: ProviderKind,
  modelId: z.string(),
  name: z.string(),
  /** The registry model this is, and whether that was matched by its ID or chosen by hand. */
  canonicalId: z.string().nullable(),
  canonicalSource: z.enum(["auto", "manual"]).nullable(),
  /** Why no registry model was matched, when none was: no match, or several. */
  matchProblem: z.enum(["unmatched", "ambiguous"]).nullable(),
  matchCandidates: z.array(z.string()),
  /** The model's vendor, from the registry; decides which agent is its own vendor's. */
  vendor: z.string().nullable(),
  /** Tokens: the user's figure, else the registry's. */
  contextWindow: z.number().int().nullable(),
  contextWindowOverride: z.number().int().nullable(),
  structuredMode: StructuredMode,
  temperature: z.number().nullable(),
  priceInPerMTok: z.number().nullable(),
  priceOutPerMTok: z.number().nullable(),
  priceCacheReadPerMTok: z.number().nullable(),
  effective: EffectivePrice,
  /** Display label: the user's, else where its general ability sits among the user's models. */
  tier: TierLabel,
  tierLabel: TierLabel.nullable(),
  /** General coding ability: from the registry (or guessed from the price), and after this install's own records. */
  ability: z.object({
    prior: Estimate,
    current: Estimate,
    /** Chance of passing a typical 15-minute-to-1-hour task, before and after the records. */
    typical: z.object({ prior: z.number(), current: z.number() }),
    coverage: z.enum(["measured", "inferred", "none", "unmatched"]),
    runs: z.number().int(),
    passed: z.number().int(),
  }),
  /** KM0 can call it for its own work: the provider has a key or the endpoint needs none. */
  callable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ModelEntry = z.infer<typeof ModelEntry>;

/** A registry model, as a choice when matching a model by hand. */
export const RegistryChoice = z.object({ id: z.string(), name: z.string(), vendor: z.string() });
export type RegistryChoice = z.infer<typeof RegistryChoice>;

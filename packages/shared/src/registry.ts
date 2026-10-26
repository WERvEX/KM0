import { z } from "zod";

/**
 * KM0's model registry: which models exist, what they cost, and what public leaderboards say about
 * how well they code, as a prior that each user's own acceptance results later correct. Built by
 * packages/registry from leaderboard snapshots; bundled with the app and refreshable.
 *
 * Abilities and difficulties share one scale, in logits: a model with ability θ (plus its agent's
 * offset) passes a task of difficulty b with probability σ(θ − b). The scale is anchored on
 * SWE-bench Verified, whose tasks carry difficulty labels; see `difficulty`.
 */

export const REGISTRY_SCHEMA_VERSION = 1;

/** Mean and standard deviation of a normal distribution on the ability scale. */
export const Estimate = z.object({ mean: z.number(), sd: z.number().nonnegative() });
export type Estimate = z.infer<typeof Estimate>;

/** The kinds of work an ability is estimated for; they match the routing capabilities plus a general one. */
export const AbilityKind = z.enum(["general", "frontend", "backend", "debugging", "testing", "docs", "devops"]);
export type AbilityKind = z.infer<typeof AbilityKind>;

export const RegistrySource = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  /** What it measures and what it informs, in a sentence. */
  measures: z.string(),
  fetchedAt: z.string(),
  /** Date of the newest entry the snapshot holds. */
  newestEntry: z.string().nullable(),
  entries: z.number().int().nonnegative(),
  /** Entries whose model or agent could not be matched, and were left out. */
  unmatched: z.number().int().nonnegative(),
});
export type RegistrySource = z.infer<typeof RegistrySource>;

/** One leaderboard result behind a model's estimate, kept so the UI can show where a number comes from. */
export const RegistryObservation = z.object({
  column: z.string(),
  source: z.string(),
  /** The agent or harness that ran the model; null for model-only measurements. */
  agent: z.string().nullable(),
  /** As published: a percentage, an index or an Elo rating. */
  value: z.number(),
  effort: z.string().nullable(),
  date: z.string().nullable(),
});
export type RegistryObservation = z.infer<typeof RegistryObservation>;

export const RegistryModel = z.object({
  /** Canonical ID, `vendor/model`, as OpenRouter names it where it lists the model. */
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  /** Other spellings: leaderboard names, provider model IDs, relay names. */
  aliases: z.array(z.string()),
  released: z.string().nullable(),
  contextWindow: z.number().int().positive().nullable(),
  /** USD per million tokens; null when unknown. */
  pricing: z.object({
    input: z.number().nonnegative().nullable(),
    output: z.number().nonnegative().nullable(),
    cacheRead: z.number().nonnegative().nullable(),
  }),
  abilities: z.record(AbilityKind, Estimate),
  /**
   * measured: at least one leaderboard result; inferred: only general indices, completed from how
   * leaderboards relate; none: no data, estimated from models at a similar price.
   */
  coverage: z.enum(["measured", "inferred", "none"]),
  observations: z.array(RegistryObservation),
});
export type RegistryModel = z.infer<typeof RegistryModel>;

export const RegistryAgent = z.object({
  /** KM0's agent ID where KM0 has an adapter for it (claude_code, codex, …), otherwise the leaderboard's. */
  id: z.string(),
  name: z.string(),
  /** Vendors whose models this agent is the official tool for. */
  nativeVendors: z.array(z.string()),
  /** Ability added when the agent runs a model of one of its native vendors, and any other model. */
  offset: z.object({ native: Estimate, foreign: Estimate }),
  /** Leaderboard results that informed the offsets. */
  evidence: z.number().int().nonnegative(),
});
export type RegistryAgent = z.infer<typeof RegistryAgent>;

export const RegistryVendor = z.object({
  id: z.string(),
  name: z.string(),
  /** Model name prefixes that identify the vendor's models, such as "claude" or "gpt". */
  families: z.array(z.string()),
  nativeAgents: z.array(z.string()),
});
export type RegistryVendor = z.infer<typeof RegistryVendor>;

/** A band of task difficulty: SWE-bench Verified tasks with one human time estimate, and the KM0 scores mapped to it. */
export const DifficultyBand = z.object({
  id: z.enum(["lt15m", "15m-1h", "1h-4h", "gt4h"]),
  /** Highest KM0 routing score in the band; null for the last band. */
  maxScore: z.number().int().nullable(),
  difficulty: Estimate,
  /** SWE-bench Verified tasks behind the estimate. */
  tasks: z.number().int().nonnegative(),
});
export type DifficultyBand = z.infer<typeof DifficultyBand>;

export const ModelRegistry = z.object({
  schemaVersion: z.literal(REGISTRY_SCHEMA_VERSION),
  generatedAt: z.string(),
  /** The newest leaderboard entry across sources. */
  dataDate: z.string(),
  sources: z.array(RegistrySource),
  difficulty: z.object({ bands: z.array(DifficultyBand) }),
  vendors: z.array(RegistryVendor),
  agents: z.array(RegistryAgent),
  models: z.array(RegistryModel),
});
export type ModelRegistry = z.infer<typeof ModelRegistry>;

/** Where the app looks for a newer registry; the registry workflow keeps this file current on master. */
export const REGISTRY_UPDATE_URL =
  "https://raw.githubusercontent.com/WERvEX/KM0/master/packages/registry/generated/model-registry.json";

/** What Settings shows about the registry in use. */
export const RegistryInfo = z.object({
  dataDate: z.string(),
  generatedAt: z.string(),
  /** bundled: shipped with this version of KM0; downloaded: from REGISTRY_UPDATE_URL; imported: from a file. */
  origin: z.enum(["bundled", "downloaded", "imported"]),
  importedAt: z.string().nullable(),
  models: z.object({
    total: z.number().int(),
    measured: z.number().int(),
    inferred: z.number().int(),
    none: z.number().int(),
  }),
  sources: z.array(z.object({ name: z.string(), url: z.string(), newestEntry: z.string().nullable() })),
});
export type RegistryInfo = z.infer<typeof RegistryInfo>;

export const RegistryUpdateResult = z.object({
  /** updated: a newer registry is now in use; current: nothing newer was found. */
  status: z.enum(["updated", "current"]),
  info: RegistryInfo,
});
export type RegistryUpdateResult = z.infer<typeof RegistryUpdateResult>;

/** Largest registry file KM0 accepts. */
export const MAX_REGISTRY_BYTES = 20 * 1024 * 1024;

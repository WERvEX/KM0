import { z } from "zod";
import { LlmRole, ProviderKind, StructuredMode } from "./llm";
import { Billing } from "./models";
import { SearchServiceInput } from "./research";
import { AgentId, Capability } from "./routing";
import { Preferences } from "./settings";

export const CONFIG_FORMAT = "km0-config";
export const CONFIG_VERSION = 2;

const Price = z.number().nonnegative().nullable().default(null);

/**
 * Everything in Settings, as a portable JSON file. Keys and secrets are included only when the
 * user asks for them, and then in plain text. Providers and models are referred to by name, so ids
 * never travel.
 */
export const ConfigBundleV2 = z.object({
  format: z.literal(CONFIG_FORMAT),
  version: z.literal(2),
  exportedAt: z.string(),
  includesSecrets: z.boolean(),
  providers: z.array(
    z.object({
      name: z.string().trim().min(1).max(80),
      kind: ProviderKind,
      baseUrl: z.url().nullable().default(null),
      apiKey: z.string().max(4096).optional(),
      billing: Billing,
    }),
  ),
  models: z.array(
    z.object({
      provider: z.string(),
      modelId: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(80),
      canonicalId: z.string().nullable().default(null),
      contextWindow: z.number().int().positive().nullable().default(null),
      structuredMode: StructuredMode.default("auto"),
      temperature: z.number().min(0).max(2).nullable().default(null),
      priceInPerMTok: Price,
      priceOutPerMTok: Price,
      priceCacheReadPerMTok: Price,
    }),
  ),
  /** Model names. */
  roles: z.record(LlmRole, z.string().nullable()),
  preferences: Preferences.partial(),
  agents: z.array(
    z.object({
      id: AgentId,
      name: z.string(),
      kind: z.enum(["preset", "custom"]),
      enabled: z.boolean(),
      /** Model names per tier. */
      models: z.object({ T1: z.string().nullable(), T2: z.string().nullable(), T3: z.string().nullable() }),
      capabilities: z.array(Capability),
      instructionFile: z.string().nullable().default(null),
      launchTemplate: z.string().nullable().default(null),
      apiKinds: z.array(ProviderKind).default([]),
      nativeVendor: z.string().nullable().default(null),
    }),
  ),
  searchServices: z.array(SearchServiceInput),
});
export type ConfigBundleV2 = z.output<typeof ConfigBundleV2>;

/** Files written by KM0 0.1: one profile per model with its own endpoint, and models typed per agent and tier. */
export const ConfigBundleV1 = z.object({
  format: z.literal(CONFIG_FORMAT),
  version: z.literal(1),
  exportedAt: z.string(),
  includesSecrets: z.boolean(),
  profiles: z.array(
    z.object({
      name: z.string().trim().min(1).max(80),
      provider: ProviderKind,
      baseUrl: z.url().nullable().default(null),
      model: z.string().trim().min(1).max(200),
      apiKey: z.string().max(4096).optional(),
      structuredMode: StructuredMode.default("auto"),
      temperature: z.number().min(0).max(2).nullable().default(null),
      priceInPerMTok: Price,
      priceOutPerMTok: Price,
    }),
  ),
  roles: z.object({ router: z.string().nullable(), planner: z.string().nullable() }),
  preferences: Preferences.partial(),
  agents: z.array(
    z.object({
      id: AgentId,
      enabled: z.boolean(),
      models: z.record(
        z.enum(["T1", "T2", "T3"]),
        z.object({ modelId: z.string(), priceInPerMTok: Price, priceOutPerMTok: Price }).nullable(),
      ),
      capabilities: z.array(Capability).optional(),
    }),
  ),
  searchServices: z.array(SearchServiceInput),
});
export type ConfigBundleV1 = z.output<typeof ConfigBundleV1>;

export const ConfigBundle = z.discriminatedUnion("version", [ConfigBundleV2, ConfigBundleV1]);
export type ConfigBundle = z.output<typeof ConfigBundle>;

export const ExportConfigInput = z.object({ includeSecrets: z.boolean().default(false) });

/** What an import changed. Existing providers, models and services are matched by name and updated in place. */
export const ImportSummary = z.object({
  providersCreated: z.number().int(),
  providersUpdated: z.number().int(),
  modelsCreated: z.number().int(),
  modelsUpdated: z.number().int(),
  searchCreated: z.number().int(),
  searchUpdated: z.number().int(),
  agentsUpdated: z.number().int(),
  agentsCreated: z.number().int(),
  /** Imported local MCP servers left disabled: they run a command, so the user enables them by hand. */
  localServersDisabled: z.number().int(),
  rolesSet: z.boolean(),
});
export type ImportSummary = z.infer<typeof ImportSummary>;

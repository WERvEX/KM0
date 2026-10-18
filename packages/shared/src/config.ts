import { z } from "zod";
import { LlmProfileInput } from "./llm";
import { SearchServiceInput } from "./research";
import { AgentId, TierModel } from "./routing";
import { Preferences } from "./settings";

export const CONFIG_FORMAT = "km0-config";
export const CONFIG_VERSION = 1;

/**
 * Everything in Settings, as a portable JSON file. Keys and secrets are included only when the
 * user asks for them, and then in plain text. Roles refer to profiles by name so ids never travel.
 */
export const ConfigBundle = z.object({
  format: z.literal(CONFIG_FORMAT),
  version: z.literal(CONFIG_VERSION),
  exportedAt: z.string(),
  includesSecrets: z.boolean(),
  profiles: z.array(LlmProfileInput),
  roles: z.object({ router: z.string().nullable(), planner: z.string().nullable() }),
  preferences: Preferences.partial(),
  agents: z.array(
    z.object({
      id: AgentId,
      enabled: z.boolean(),
      models: z.object({ T1: TierModel.nullable(), T2: TierModel.nullable(), T3: TierModel.nullable() }),
    }),
  ),
  searchServices: z.array(SearchServiceInput),
});
export type ConfigBundle = z.output<typeof ConfigBundle>;

export const ExportConfigInput = z.object({ includeSecrets: z.boolean().default(false) });

/** What an import changed. Existing profiles and services are matched by name and updated in place. */
export const ImportSummary = z.object({
  profilesCreated: z.number().int(),
  profilesUpdated: z.number().int(),
  searchCreated: z.number().int(),
  searchUpdated: z.number().int(),
  agentsUpdated: z.number().int(),
  /** Imported local MCP servers left disabled: they run a command, so the user enables them by hand. */
  localServersDisabled: z.number().int(),
  rolesSet: z.boolean(),
});
export type ImportSummary = z.infer<typeof ImportSummary>;

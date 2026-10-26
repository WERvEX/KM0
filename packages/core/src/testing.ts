import { AGENT_NAMES, type AgentConfig, isPresetAgent, type Tier, type TierModel } from "@km0/shared";

/** Test helpers: a model with a token price, and an agent config with sensible defaults. */

export function tierModel(
  modelId: string,
  input: number | null = null,
  output: number | null = null,
  extra: Partial<TierModel> = {},
): TierModel {
  return {
    modelRef: 0,
    providerId: 1,
    providerKind: "openai",
    modelId,
    name: modelId,
    canonicalId: null,
    vendor: null,
    native: false,
    price: {
      mode: "token",
      input,
      output,
      cacheRead: null,
      source: input === null && output === null ? "none" : "model",
    },
    priceInPerMTok: input,
    priceOutPerMTok: output,
    tier: "T2" as Tier,
    contextWindow: null,
    ...extra,
  };
}

export function agentConfig(partial: Partial<AgentConfig> & Pick<AgentConfig, "id">): AgentConfig {
  return {
    name: isPresetAgent(partial.id) ? AGENT_NAMES[partial.id] : partial.id,
    kind: "preset",
    enabled: true,
    preference: 0,
    models: [],
    capabilities: [],
    nativeVendors: [],
    apiKinds: [],
    instructionFile: null,
    launchTemplate: null,
    ...partial,
  };
}

import { AGENT_NAMES, type AgentConfig, isPresetAgent, type TierModel } from "@km0/shared";

/** Test helpers: a tier model with a token price, and an agent config with sensible defaults. */

export function tierModel(modelId: string, input: number | null = null, output: number | null = null): TierModel {
  return {
    modelRef: 0,
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
  };
}

export function agentConfig(partial: Partial<AgentConfig> & Pick<AgentConfig, "id">): AgentConfig {
  return {
    name: isPresetAgent(partial.id) ? AGENT_NAMES[partial.id] : partial.id,
    kind: "preset",
    enabled: true,
    preference: 0,
    models: { T1: null, T2: null, T3: null },
    capabilities: [],
    nativeVendors: [],
    apiKinds: [],
    instructionFile: null,
    launchTemplate: null,
    ...partial,
  };
}

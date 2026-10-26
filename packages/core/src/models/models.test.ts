import { AbilityKind, type Estimate, type ModelRegistry, type RegistryModel } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { effectivePrice, matchRegistryModel } from "./models";

const abilities = Object.fromEntries(AbilityKind.options.map((kind) => [kind, { mean: 0, sd: 1 }])) as Record<
  AbilityKind,
  Estimate
>;
const model = (id: string, name: string, aliases: string[] = []): RegistryModel => ({
  id,
  name,
  vendor: id.split("/")[0] ?? "",
  aliases,
  released: null,
  contextWindow: null,
  pricing: { input: 1, output: 4, cacheRead: 0.1 },
  abilities,
  coverage: "measured",
  observations: [],
});
const registry: ModelRegistry = {
  schemaVersion: 1,
  generatedAt: "",
  dataDate: "",
  sources: [],
  difficulty: { bands: [] },
  vendors: [],
  agents: [],
  models: [
    model("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", ["deepseek-v4-flash"]),
    model("deepseek/deepseek-v4-flash-0731", "DeepSeek V4 Flash 0731", ["DeepSeek-V4 Flash [high]"]),
    model("anthropic/claude-opus-5.5", "Claude Opus 5.5", ["Opus 5.5"]),
    model("x/model-a", "Model A", ["shared-name"]),
    model("x/model-b", "Model B", ["shared-name"]),
  ],
};

describe("matchRegistryModel", () => {
  it("prefers a model's own name over another model's leaderboard spelling", () => {
    expect(matchRegistryModel(registry, "deepseek-v4-flash").canonicalId).toBe("deepseek/deepseek-v4-flash");
    expect(matchRegistryModel(registry, "deepseek-v4-flash-0731").canonicalId).toBe("deepseek/deepseek-v4-flash-0731");
  });

  it("matches provider and relay spellings, and tries every spelling given", () => {
    expect(matchRegistryModel(registry, "claude-opus-5-5").canonicalId).toBe("anthropic/claude-opus-5.5");
    expect(matchRegistryModel(registry, "anthropic/claude-opus-5-5-20261001").canonicalId).toBe(
      "anthropic/claude-opus-5.5",
    );
    expect(matchRegistryModel(registry, "my-relay-id", "Opus 5.5").canonicalId).toBe("anthropic/claude-opus-5.5");
  });

  it("ignores spellings that several models share, and reports names it cannot place", () => {
    expect(matchRegistryModel(registry, "shared-name")).toEqual({
      canonicalId: null,
      problem: "unmatched",
      candidates: [],
    });
  });
});

describe("effectivePrice", () => {
  const official = { input: 5, output: 25, cacheRead: 0.5 };
  const none = { priceInPerMTok: null, priceOutPerMTok: null, priceCacheReadPerMTok: null };

  it("uses the model's own price, else the official one", () => {
    expect(effectivePrice({ mode: "token" }, none, official)).toEqual({
      mode: "token",
      input: 5,
      output: 25,
      cacheRead: 0.5,
      source: "registry",
    });
    expect(
      effectivePrice({ mode: "token" }, { ...none, priceInPerMTok: 3, priceOutPerMTok: 15 }, official),
    ).toMatchObject({
      input: 3,
      output: 15,
      cacheRead: 0.5,
      source: "model",
    });
    expect(effectivePrice({ mode: "token" }, none, null)).toMatchObject({ input: null, source: "none" });
  });

  it("multiplies through a relay and costs nothing extra in a subscription or for free models", () => {
    expect(effectivePrice({ mode: "relay", multiplier: 0.6 }, none, official)).toMatchObject({ input: 3, output: 15 });
    expect(
      effectivePrice({ mode: "subscription", monthlyFee: 200, quota: null, overflow: "unavailable" }, none, official),
    ).toMatchObject({ mode: "subscription", input: 0, output: 0 });
    expect(effectivePrice({ mode: "free" }, none, null)).toMatchObject({ mode: "free", input: 0 });
  });
});

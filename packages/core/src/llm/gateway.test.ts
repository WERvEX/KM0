import { AppError } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeProvider, textReply, toolReply } from "./fake-provider";
import { createGateway } from "./gateway";
import { extractJson } from "./json";
import { type LlmCallRecord, ProviderError, type ResolvedProfile } from "./types";

const Answer = z.object({ title: z.string(), score: z.number().int() });

function profile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    id: 1,
    name: "test",
    provider: "openai",
    baseUrl: null,
    model: "test-model",
    apiKey: "sk-test",
    structuredMode: "auto",
    temperature: null,
    priceInPerMTok: null,
    priceOutPerMTok: null,
    ...overrides,
  };
}

function setup(provider: FakeProvider) {
  const calls: LlmCallRecord[] = [];
  let clock = 0;
  const gateway = createGateway({
    providerFor: () => provider,
    recordCall: (record) => calls.push(record),
    now: () => (clock += 100),
  });
  return { gateway, calls };
}

const call = {
  schema: Answer,
  name: "answer",
  description: "An answer",
  prompt: "Give me an answer",
  purpose: "test",
};

describe("structured calls", () => {
  it("uses a forced tool call for auto profiles and parses the tool input", async () => {
    const provider = new FakeProvider([toolReply({ title: "a", score: 1 })]);
    const { gateway } = setup(provider);
    await expect(gateway.structured({ ...call, profile: profile() })).resolves.toEqual({ title: "a", score: 1 });
    expect(provider.requests[0]?.output?.kind).toBe("tool");
    expect(provider.requests[0]?.output?.schema).toMatchObject({ type: "object", required: ["title", "score"] });
  });

  it("sends a JSON schema response format in json_schema mode", async () => {
    const provider = new FakeProvider([textReply('{"title":"a","score":2}')]);
    const { gateway } = setup(provider);
    await gateway.structured({ ...call, profile: profile({ structuredMode: "json_schema" }) });
    expect(provider.requests[0]?.output?.kind).toBe("json_schema");
  });

  it("puts the schema into the system prompt and parses fenced JSON in prompt mode", async () => {
    const provider = new FakeProvider([textReply('Sure:\n```json\n{"title":"a","score":3}\n```')]);
    const { gateway } = setup(provider);
    const result = await gateway.structured({
      ...call,
      system: "Be brief.",
      profile: profile({ structuredMode: "prompt" }),
    });
    expect(result.score).toBe(3);
    expect(provider.requests[0]?.output).toBeUndefined();
    expect(provider.requests[0]?.system).toContain("Be brief.");
    expect(provider.requests[0]?.system).toContain('"score"');
  });

  it("repairs one invalid answer by showing the model its mistake", async () => {
    const provider = new FakeProvider([toolReply({ title: "a", score: "high" }), toolReply({ title: "a", score: 4 })]);
    const { gateway, calls } = setup(provider);
    await expect(gateway.structured({ ...call, profile: profile() })).resolves.toEqual({ title: "a", score: 4 });
    const repair = provider.requests[1];
    expect(repair?.messages).toHaveLength(3);
    expect(repair?.messages[1]).toEqual({ role: "assistant", content: '{"title":"a","score":"high"}' });
    expect(repair?.messages[2]?.content).toContain("score");
    expect(calls.map((record) => record.attempt)).toEqual([1, 2]);
  });

  it("fails with a validation error after a second invalid answer", async () => {
    const provider = new FakeProvider([textReply("not json"), textReply("still not json")]);
    const { gateway } = setup(provider);
    const promise = gateway.structured({ ...call, profile: profile({ structuredMode: "prompt" }) });
    await expect(promise).rejects.toBeInstanceOf(AppError);
    await expect(promise).rejects.toMatchObject({ kind: "validation", retryable: true });
  });

  it("maps provider failures to errors the user can act on", async () => {
    const auth = setup(new FakeProvider([new ProviderError("auth", "bad key", { status: 401 })]));
    await expect(auth.gateway.structured({ ...call, profile: profile() })).rejects.toMatchObject({
      kind: "config",
      retryable: false,
    });
    const limited = setup(new FakeProvider([new ProviderError("rate_limit", "slow down", { status: 429 })]));
    await expect(limited.gateway.structured({ ...call, profile: profile() })).rejects.toMatchObject({
      kind: "upstream",
      retryable: true,
    });
    expect(limited.calls[0]?.error).toEqual({ kind: "upstream", message: "Rate limited: slow down" });
  });

  it("logs tokens, latency and cost when prices are set", async () => {
    const provider = new FakeProvider([toolReply({ title: "a", score: 1 }, { inputTokens: 1000, outputTokens: 500 })]);
    const { gateway, calls } = setup(provider);
    await gateway.structured({
      ...call,
      projectId: 7,
      profile: profile({ priceInPerMTok: 2, priceOutPerMTok: 8 }),
    });
    expect(calls[0]).toMatchObject({
      purpose: "test",
      projectId: 7,
      mode: "tool",
      inputTokens: 1000,
      outputTokens: 500,
      latencyMs: 100,
      error: null,
    });
    expect(calls[0]?.costUsd).toBeCloseTo(0.006);
  });

  it("leaves cost empty when the profile has no prices", async () => {
    const { gateway, calls } = setup(new FakeProvider([toolReply({ title: "a", score: 1 })]));
    await gateway.structured({ ...call, profile: profile() });
    expect(calls[0]?.costUsd).toBeNull();
  });
});

describe("text calls", () => {
  it("returns plain text and logs the call", async () => {
    const { gateway, calls } = setup(new FakeProvider([textReply("hello")]));
    await expect(gateway.text({ profile: profile(), purpose: "doc", prompt: "hi" })).resolves.toBe("hello");
    expect(calls[0]?.mode).toBe("text");
  });
});

describe("connection test", () => {
  it("detects the first structured mode the endpoint supports", async () => {
    const provider = new FakeProvider([
      new ProviderError("bad_request", "response_format json_schema is not supported", { status: 400 }),
      toolReply({ ok: true }),
    ]);
    const { gateway } = setup(provider);
    const result = await gateway.testConnection(profile());
    expect(result).toMatchObject({ ok: true, detectedMode: "tool", error: null });
    expect(provider.requests.map((request) => request.output?.kind)).toEqual(["json_schema", "tool"]);
  });

  it("stops at a rejected key instead of trying other modes", async () => {
    const provider = new FakeProvider([new ProviderError("auth", "invalid key", { status: 401 })]);
    const { gateway } = setup(provider);
    const result = await gateway.testConnection(profile());
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("config");
    expect(provider.requests).toHaveLength(1);
  });

  it("only tries the configured mode for explicit profiles", async () => {
    const provider = new FakeProvider([textReply('{"ok":true}')]);
    const { gateway } = setup(provider);
    const result = await gateway.testConnection(profile({ structuredMode: "prompt" }));
    expect(result).toMatchObject({ ok: true, detectedMode: "prompt" });
  });
});

describe("extractJson", () => {
  it("handles bare, fenced and embedded JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Here you go: {"a":3} done')).toEqual({ a: 3 });
    expect(extractJson("[1,2]")).toEqual([1, 2]);
    expect(() => extractJson("nothing here")).toThrow(SyntaxError);
  });
});

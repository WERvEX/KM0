import { describe, expect, it } from "vitest";
import { AnthropicProvider, strictSchema } from "./anthropic-provider";
import { OpenAIProvider } from "./openai-provider";
import { ProviderError } from "./types";

function capture(responseBody: unknown, status = 200) {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, bodies, urls };
}

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

describe("OpenAIProvider", () => {
  const completion = {
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "t", type: "function", function: { name: "probe", arguments: '{"ok":true}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  };

  it("forces a function call for tool output and uses max_tokens on compatible endpoints", async () => {
    const { fetch, bodies, urls } = capture(completion);
    const provider = new OpenAIProvider({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetch });
    const response = await provider.complete({
      model: "m",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      output: { kind: "tool", name: "probe", description: "d", schema },
    });
    expect(urls[0]).toBe("https://api.deepseek.com/chat/completions");
    expect(bodies[0]).toMatchObject({
      max_tokens: 50,
      tool_choice: { type: "function", function: { name: "probe" } },
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    });
    expect(response).toEqual({ text: "", toolInput: { ok: true }, usage: { inputTokens: 12, outputTokens: 3 } });
  });

  it("uses max_completion_tokens and response_format on api.openai.com", async () => {
    const { fetch, bodies } = capture(completion);
    const provider = new OpenAIProvider({ apiKey: "k", baseUrl: null, fetch });
    await provider.complete({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      output: { kind: "json_schema", name: "probe", description: "d", schema },
    });
    expect(bodies[0]).toMatchObject({
      max_completion_tokens: 50,
      response_format: { type: "json_schema", json_schema: { name: "probe", schema, strict: false } },
    });
    expect(bodies[0]).not.toHaveProperty("max_tokens");
  });

  it("classifies HTTP failures", async () => {
    const { fetch } = capture({ error: { message: "bad key" } }, 401);
    const provider = new OpenAIProvider({ apiKey: "k", baseUrl: "https://example.com/v1", fetch });
    const promise = provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }] });
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
    await expect(promise).rejects.toMatchObject({ kind: "auth", status: 401 });
  });
});

describe("AnthropicProvider", () => {
  const message = {
    id: "m",
    type: "message",
    role: "assistant",
    model: "m",
    stop_reason: "tool_use",
    stop_sequence: null,
    content: [
      { type: "text", text: "thinking aloud" },
      { type: "tool_use", id: "t", name: "probe", input: { ok: true } },
    ],
    usage: { input_tokens: 20, output_tokens: 4 },
  };

  it("forces the tool and returns its input", async () => {
    const { fetch, bodies, urls } = capture(message);
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl: "https://api.deepseek.com/anthropic", fetch });
    const response = await provider.complete({
      model: "m",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      output: { kind: "tool", name: "probe", description: "d", schema },
    });
    expect(urls[0]).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(bodies[0]).toMatchObject({
      system: "sys",
      max_tokens: 4096,
      tool_choice: { type: "tool", name: "probe" },
      tools: [{ name: "probe", input_schema: schema }],
    });
    expect(response).toEqual({
      text: "thinking aloud",
      toolInput: { ok: true },
      usage: { inputTokens: 20, outputTokens: 4 },
    });
  });

  it("sends output_config for json_schema output", async () => {
    const { fetch, bodies } = capture({ ...message, content: [{ type: "text", text: '{"ok":true}' }] });
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl: null, fetch });
    await provider.complete({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      output: { kind: "json_schema", name: "probe", description: "d", schema },
    });
    expect(bodies[0]).toMatchObject({ output_config: { format: { type: "json_schema", schema } } });
  });

  it("on the Claude API, adds effort, room for thinking and server-side fallback", async () => {
    const { fetch, bodies, urls } = capture({ ...message, content: [{ type: "text", text: '{"ok":true}' }] });
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl: null, fetch });
    await provider.complete({
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 800,
      effort: "low",
      output: { kind: "json_schema", name: "probe", description: "d", schema },
    });
    expect(urls[0]).toContain("/v1/messages?beta=true");
    expect(bodies[0]).toMatchObject({
      max_tokens: 16000,
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
  });

  it("does not send Claude-only fields to compatible endpoints", async () => {
    const { fetch, bodies } = capture(message);
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl: "https://api.deepseek.com/anthropic", fetch });
    await provider.complete({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 800,
      effort: "low",
    });
    expect(bodies[0]).not.toHaveProperty("fallbacks");
    expect(bodies[0]).not.toHaveProperty("output_config");
    expect(bodies[0]).toMatchObject({ max_tokens: 800 });
  });

  it("leaves room for thinking when a Claude model is reached through a relay", async () => {
    const { fetch, bodies } = capture(message);
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl: "https://relay.example.com", fetch });
    await provider.complete({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], maxTokens: 2000 });
    expect(bodies[0]).toMatchObject({ max_tokens: 16000 });
    expect(bodies[0]).not.toHaveProperty("fallbacks");
  });

  it("reports a policy decline as a refusal", async () => {
    const { fetch } = capture({
      ...message,
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: null },
    });
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl: null, fetch });
    await expect(
      provider.complete({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({
      kind: "refusal",
    });
  });
});

describe("strictSchema", () => {
  it("closes objects and drops unsupported constraints", () => {
    expect(
      strictSchema({
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 80 },
          tags: { type: "array", maxItems: 5, items: { type: "object", properties: {} } },
        },
        required: ["name"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        tags: { type: "array", items: { type: "object", properties: {}, additionalProperties: false } },
      },
      required: ["name"],
      additionalProperties: false,
    });
  });
});

function sse(events: { event?: string; data: unknown }[]) {
  const bodies: Record<string, unknown>[] = [];
  const text = events
    .map(
      (item) =>
        `${item.event ? `event: ${item.event}\n` : ""}data: ${typeof item.data === "string" ? item.data : JSON.stringify(item.data)}\n\n`,
    )
    .join("");
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return { fetch, bodies };
}

describe("streaming", () => {
  it("passes OpenAI content deltas on, skips reasoning, and reads usage from the last chunk", async () => {
    const chunk = (delta: Record<string, unknown>, usage: unknown = null) => ({
      id: "c",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
      choices: usage ? [] : [{ index: 0, delta, finish_reason: null }],
      ...(usage ? { usage } : {}),
    });
    const { fetch, bodies } = sse([
      { data: chunk({ reasoning_content: "thinking…" }) },
      { data: chunk({ content: "Hello" }) },
      { data: chunk({ content: " world" }) },
      { data: chunk({}, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }) },
      { data: "[DONE]" },
    ]);
    const provider = new OpenAIProvider({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetch });
    const deltas: string[] = [];
    const response = await provider.stream({ model: "m", messages: [{ role: "user", content: "hi" }] }, (text) =>
      deltas.push(text),
    );
    expect(bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(deltas).toEqual(["Hello", " world"]);
    expect(response).toEqual({ text: "Hello world", usage: { inputTokens: 7, outputTokens: 2 } });
  });

  it("streams Anthropic text deltas and ignores thinking", async () => {
    const message = {
      id: "m",
      type: "message",
      role: "assistant",
      model: "glm",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 0 },
    };
    const { fetch, bodies } = sse([
      { event: "message_start", data: { type: "message_start", message } },
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " there" } },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 4 },
        },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl: "https://open.bigmodel.cn/api/anthropic", fetch });
    const deltas: string[] = [];
    const response = await provider.stream(
      { model: "glm", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
      (text) => deltas.push(text),
    );
    expect(bodies[0]).toMatchObject({ stream: true, max_tokens: 100 });
    expect(deltas).toEqual(["Hi", " there"]);
    expect(response).toEqual({ text: "Hi there", usage: { inputTokens: 11, outputTokens: 4 } });
  });
});

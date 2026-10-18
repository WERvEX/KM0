import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "./anthropic-provider";
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
});

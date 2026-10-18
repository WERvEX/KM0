import Anthropic from "@anthropic-ai/sdk";
import { classifyHttpStatus } from "./errors";
import { type ChatProvider, type ChatRequest, type ChatResponse, ProviderError } from "./types";

const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;
/** Thinking counts toward max_tokens on current Claude models, so leave room for it. */
const CLAUDE_MIN_MAX_TOKENS = 16_000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicProviderOptions {
  apiKey: string | null;
  baseUrl: string | null;
  /** Injected in tests to capture requests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Anthropic Messages API; also serves Anthropic-compatible endpoints (DeepSeek, Qwen, GLM…).
 * On the Claude API itself it adds what current models expect: an explicit effort level, room for
 * thinking in max_tokens, and server-side fallback when a model declines for policy reasons.
 */
export class AnthropicProvider implements ChatProvider {
  private readonly client: Anthropic;
  private readonly claudeApi: boolean;

  constructor(options: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey || "not-set",
      baseURL: options.baseUrl ?? undefined,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 2,
      // The browser debug build calls providers straight from the page with the user's own key.
      dangerouslyAllowBrowser: true,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.claudeApi = !options.baseUrl || new URL(options.baseUrl).hostname === "api.anthropic.com";
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const output = request.output;
    const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: this.claudeApi ? Math.max(maxTokens, CLAUDE_MIN_MAX_TOKENS) : maxTokens,
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    };
    if (request.system) params.system = request.system;
    if (request.temperature !== null && request.temperature !== undefined) params.temperature = request.temperature;

    const outputConfig: Anthropic.Beta.BetaOutputConfig = {};
    if (output?.kind === "json_schema") {
      outputConfig.format = { type: "json_schema", schema: strictSchema(output.schema) };
    } else if (output?.kind === "tool") {
      params.tools = [
        {
          name: output.name,
          description: output.description,
          input_schema: output.schema as Anthropic.Beta.BetaTool.InputSchema,
        },
      ];
      // Newer Claude models reject a forced tool choice (400); the gateway then moves on to json_schema.
      params.tool_choice = { type: "tool", name: output.name };
    }
    if (this.claudeApi && request.effort) outputConfig.effort = request.effort;
    if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;

    let message: Anthropic.Beta.BetaMessage;
    try {
      if (this.claudeApi && request.model.startsWith("claude-")) {
        // On a policy decline the API retries on the model's default fallback; a no-op on models without one.
        message = await this.client.beta.messages.create(
          { ...params, betas: [FALLBACK_BETA], fallbacks: "default" },
          { signal: request.signal },
        );
      } else {
        message = (await this.client.messages.create(params as Anthropic.MessageCreateParamsNonStreaming, {
          signal: request.signal,
        })) as unknown as Anthropic.Beta.BetaMessage;
      }
    } catch (error) {
      throw toProviderError(error);
    }

    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category ?? "unspecified";
      throw new ProviderError("refusal", `declined (${category})`);
    }

    let text = "";
    let toolInput: unknown;
    // Read blocks by type: current models may start with (empty) thinking blocks.
    for (const block of message.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use" && toolInput === undefined) toolInput = block.input;
    }
    return {
      text,
      ...(toolInput !== undefined ? { toolInput } : {}),
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    };
  }
}

/**
 * Structured outputs accept a subset of JSON Schema. Close every object and drop length and range
 * constraints; the gateway still validates the answer with the full zod schema.
 */
export function strictSchema(schema: unknown): Record<string, unknown> {
  const DROP = new Set([
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "default",
    "pattern",
    "format",
  ]);
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (DROP.has(key)) continue;
      result[key] =
        key === "properties"
          ? Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, visit(v)]))
          : visit(value);
    }
    if (result.type === "object") result.additionalProperties = false;
    return result;
  };
  return visit(schema) as Record<string, unknown>;
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError("timeout", "The request timed out", { cause: error });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError("network", error.message || "Could not reach the endpoint", { cause: error });
  }
  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    return new ProviderError(classifyHttpStatus(error.status), error.message, { status: error.status, cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError("unknown", message, { cause: error });
}

import Anthropic from "@anthropic-ai/sdk";
import { classifyHttpStatus } from "./errors";
import { type ChatProvider, type ChatRequest, type ChatResponse, ProviderError } from "./types";

const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicProviderOptions {
  apiKey: string | null;
  baseUrl: string | null;
  /** Injected in tests to capture requests. */
  fetch?: typeof globalThis.fetch;
}

/** Anthropic Messages API; also serves Anthropic-compatible endpoints. */
export class AnthropicProvider implements ChatProvider {
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey || "not-set",
      baseURL: options.baseUrl ?? undefined,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 2,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    };
    if (request.system) params.system = request.system;
    if (request.temperature !== null && request.temperature !== undefined) params.temperature = request.temperature;
    const output = request.output;
    if (output?.kind === "json_schema") {
      params.output_config = { format: { type: "json_schema", schema: output.schema } };
    } else if (output?.kind === "tool") {
      params.tools = [
        {
          name: output.name,
          description: output.description,
          input_schema: output.schema as Anthropic.Tool.InputSchema,
        },
      ];
      params.tool_choice = { type: "tool", name: output.name };
    }

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(params, { signal: request.signal });
    } catch (error) {
      throw toProviderError(error);
    }

    let text = "";
    let toolInput: unknown;
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

import OpenAI from "openai";
import { classifyHttpStatus } from "./errors";
import { type ChatProvider, type ChatRequest, type ChatResponse, ProviderError } from "./types";

const REQUEST_TIMEOUT_MS = 120_000;

export interface OpenAIProviderOptions {
  apiKey: string | null;
  baseUrl: string | null;
  /** Injected in tests to capture requests. */
  fetch?: typeof globalThis.fetch;
}

/** OpenAI chat completions; also serves every OpenAI-compatible endpoint (DeepSeek, Qwen, GLM, MiMo…). */
export class OpenAIProvider implements ChatProvider {
  private readonly client: OpenAI;
  private readonly officialEndpoint: boolean;

  constructor(options: OpenAIProviderOptions) {
    this.client = new OpenAI({
      // Some local endpoints accept no key; the SDK still requires a value.
      apiKey: options.apiKey || "not-set",
      baseURL: options.baseUrl ?? undefined,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 2,
      // The browser debug build calls providers straight from the page with the user's own key.
      dangerouslyAllowBrowser: true,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.officialEndpoint = !options.baseUrl || new URL(options.baseUrl).hostname === "api.openai.com";
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (request.system) messages.push({ role: "system", content: request.system });
    for (const message of request.messages) messages.push({ role: message.role, content: message.content });

    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = { model: request.model, messages };
    if (request.temperature !== null && request.temperature !== undefined) params.temperature = request.temperature;
    if (request.maxTokens) {
      // api.openai.com rejects max_tokens on newer models; compatible endpoints mostly only know max_tokens.
      if (this.officialEndpoint) params.max_completion_tokens = request.maxTokens;
      else params.max_tokens = request.maxTokens;
    }
    const output = request.output;
    if (output?.kind === "json_schema") {
      params.response_format = {
        type: "json_schema",
        json_schema: { name: output.name, description: output.description, schema: output.schema, strict: false },
      };
    } else if (output?.kind === "tool") {
      params.tools = [
        {
          type: "function",
          function: { name: output.name, description: output.description, parameters: output.schema },
        },
      ];
      params.tool_choice = { type: "function", function: { name: output.name } };
    }

    let completion: OpenAI.Chat.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(params, { signal: request.signal });
    } catch (error) {
      throw toProviderError(error);
    }

    const message = completion.choices[0]?.message;
    const toolCall = message?.tool_calls?.find((call) => call.type === "function");
    let toolInput: unknown;
    if (toolCall && toolCall.type === "function") {
      try {
        toolInput = JSON.parse(toolCall.function.arguments);
      } catch {
        // Leave malformed arguments as text so the gateway can ask for a repair.
        toolInput = toolCall.function.arguments;
      }
    }
    return {
      text: message?.content ?? "",
      ...(toolInput !== undefined ? { toolInput } : {}),
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
    };
  }
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderError("timeout", "The request timed out", { cause: error });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new ProviderError("network", error.message || "Could not reach the endpoint", { cause: error });
  }
  if (error instanceof OpenAI.APIError && typeof error.status === "number") {
    return new ProviderError(classifyHttpStatus(error.status), error.message, { status: error.status, cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError("unknown", message, { cause: error });
}

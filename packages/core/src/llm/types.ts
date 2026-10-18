import type { ProviderKind, StructuredMode } from "@km0/shared";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Asks the provider to shape its answer; `tool` forces a single function call. */
export interface StructuredOutputRequest {
  kind: "json_schema" | "tool";
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  temperature?: number | null;
  maxTokens?: number;
  output?: StructuredOutputRequest;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  text: string;
  /** Arguments of the forced tool call, when one was requested and returned. */
  toolInput?: unknown;
  usage: TokenUsage;
}

/** One API compatibility format (OpenAI or Anthropic), bound to a base URL and key. */
export interface ChatProvider {
  complete(request: ChatRequest): Promise<ChatResponse>;
}

export type ProviderErrorKind =
  | "auth"
  | "not_found"
  | "bad_request"
  | "rate_limit"
  | "server"
  | "network"
  | "timeout"
  | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;

  constructor(kind: ProviderErrorKind, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.status = options.status;
  }
}

/** Everything the gateway needs to call a model, including the decrypted key. */
export interface ResolvedProfile {
  id: number;
  name: string;
  provider: ProviderKind;
  baseUrl: string | null;
  model: string;
  apiKey: string | null;
  structuredMode: StructuredMode;
  temperature: number | null;
  priceInPerMTok: number | null;
  priceOutPerMTok: number | null;
}

export type ConcreteMode = Exclude<StructuredMode, "auto">;

/** One provider request, as written to the call log. */
export interface LlmCallRecord {
  profileId: number;
  model: string;
  purpose: string;
  projectId: number | null;
  mode: ConcreteMode | "text";
  attempt: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  error: { kind: string; message: string } | null;
}

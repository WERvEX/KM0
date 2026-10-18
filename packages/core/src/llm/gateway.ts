import { AppError, type ConnectionTestResult } from "@km0/shared";
import { z } from "zod";
import { AnthropicProvider } from "./anthropic-provider";
import { callCost } from "./cost";
import { providerErrorToAppError } from "./errors";
import { extractJson } from "./json";
import { OpenAIProvider } from "./openai-provider";
import {
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ConcreteMode,
  type LlmCallRecord,
  ProviderError,
  type ResolvedProfile,
} from "./types";

export interface GatewayDeps {
  /** Builds the SDK adapter for a profile; tests inject a fake. */
  providerFor?: (profile: ResolvedProfile) => ChatProvider;
  /** Persists one row per provider request. */
  recordCall: (record: LlmCallRecord) => void;
  now?: () => number;
}

interface CallContext {
  profile: ResolvedProfile;
  /** Short label for the call log, e.g. "triage" or "questions.tech". */
  purpose: string;
  projectId?: number | null;
  system?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface StructuredCall<S extends z.ZodType> extends CallContext {
  schema: S;
  /** Function/schema name sent to the provider: letters, digits, underscores. */
  name: string;
  description: string;
  prompt: string;
  /** Overrides the profile's mode (used by the connection test). */
  mode?: ConcreteMode;
}

export interface TextCall extends CallContext {
  prompt: string;
}

/** Until a connection test has detected a mode, forced tool calls are the most widely supported. */
const AUTO_DEFAULT_MODE: ConcreteMode = "tool";
const DETECTION_ORDER: ConcreteMode[] = ["json_schema", "tool", "prompt"];

const ConnectionProbe = z.object({ ok: z.boolean() });

export function defaultProviderFor(profile: ResolvedProfile): ChatProvider {
  const options = { apiKey: profile.apiKey, baseUrl: profile.baseUrl };
  return profile.provider === "anthropic" ? new AnthropicProvider(options) : new OpenAIProvider(options);
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  return rest;
}

function describeIssues(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

export type Gateway = ReturnType<typeof createGateway>;

/**
 * The only place that talks to model providers. Every structured call is validated against its
 * zod schema; one invalid answer gets a single repair attempt, a second one fails loudly.
 */
export function createGateway(deps: GatewayDeps) {
  const providerFor = deps.providerFor ?? defaultProviderFor;
  const now = deps.now ?? (() => Date.now());

  async function send(
    ctx: CallContext,
    mode: ConcreteMode | "text",
    attempt: number,
    request: ChatRequest,
  ): Promise<ChatResponse> {
    const started = now();
    try {
      const response = await providerFor(ctx.profile).complete(request);
      deps.recordCall({
        profileId: ctx.profile.id,
        model: ctx.profile.model,
        purpose: ctx.purpose,
        projectId: ctx.projectId ?? null,
        mode,
        attempt,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        costUsd: callCost(ctx.profile, response.usage),
        latencyMs: now() - started,
        error: null,
      });
      return response;
    } catch (error) {
      const appError = providerErrorToAppError(error);
      deps.recordCall({
        profileId: ctx.profile.id,
        model: ctx.profile.model,
        purpose: ctx.purpose,
        projectId: ctx.projectId ?? null,
        mode,
        attempt,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
        latencyMs: now() - started,
        error: { kind: appError.kind, message: appError.message },
      });
      throw appError;
    }
  }

  function buildRequest(call: StructuredCall<z.ZodType>, mode: ConcreteMode, messages: ChatMessage[]): ChatRequest {
    const jsonSchema = toJsonSchema(call.schema);
    let system = call.system;
    const request: ChatRequest = {
      model: call.profile.model,
      messages,
      temperature: call.profile.temperature,
      ...(call.maxTokens ? { maxTokens: call.maxTokens } : {}),
      ...(call.signal ? { signal: call.signal } : {}),
    };
    if (mode === "prompt") {
      const instruction = `Reply with a single JSON value and nothing else. It must match this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
      system = system ? `${system}\n\n${instruction}` : instruction;
    } else {
      request.output = { kind: mode, name: call.name, description: call.description, schema: jsonSchema };
    }
    if (system) request.system = system;
    return request;
  }

  function rawValue(mode: ConcreteMode, response: ChatResponse): unknown {
    if (mode === "tool" && response.toolInput !== undefined) {
      return typeof response.toolInput === "string" ? extractJson(response.toolInput) : response.toolInput;
    }
    return extractJson(response.text);
  }

  function rawText(mode: ConcreteMode, response: ChatResponse): string {
    if (mode === "tool" && response.toolInput !== undefined) {
      return typeof response.toolInput === "string" ? response.toolInput : JSON.stringify(response.toolInput);
    }
    return response.text;
  }

  async function structured<S extends z.ZodType>(call: StructuredCall<S>): Promise<z.output<S>> {
    const configured = call.profile.structuredMode;
    const mode: ConcreteMode = call.mode ?? (configured === "auto" ? AUTO_DEFAULT_MODE : configured);
    const messages: ChatMessage[] = [{ role: "user", content: call.prompt }];

    const first = await send(call, mode, 1, buildRequest(call, mode, messages));
    let failure: unknown;
    try {
      return call.schema.parse(rawValue(mode, first));
    } catch (error) {
      failure = error;
    }

    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: rawText(mode, first) || "(empty response)" },
      {
        role: "user",
        content: `That output is invalid: ${describeIssues(failure)}. Return the complete corrected JSON value only.`,
      },
    ];
    const second = await send(call, mode, 2, buildRequest(call, mode, repairMessages));
    try {
      return call.schema.parse(rawValue(mode, second));
    } catch (error) {
      throw new AppError("validation", "The model's answer did not match the expected structure.", {
        retryable: true,
        detail: describeIssues(error),
        cause: error,
      });
    }
  }

  async function text(call: TextCall): Promise<string> {
    const request: ChatRequest = {
      model: call.profile.model,
      messages: [{ role: "user", content: call.prompt }],
      temperature: call.profile.temperature,
      ...(call.system ? { system: call.system } : {}),
      ...(call.maxTokens ? { maxTokens: call.maxTokens } : {}),
      ...(call.signal ? { signal: call.signal } : {}),
    };
    const response = await send(call, "text", 1, request);
    return response.text;
  }

  /**
   * Checks the key and endpoint and, for `auto` profiles, finds the first structured mode that works.
   * Never throws: failures come back as a result the settings page can show.
   */
  async function testConnection(profile: ResolvedProfile): Promise<ConnectionTestResult> {
    const started = now();
    const candidates = profile.structuredMode === "auto" ? DETECTION_ORDER : [profile.structuredMode];
    let lastError: AppError | null = null;
    for (const mode of candidates) {
      try {
        await structured({
          profile,
          mode,
          purpose: "connection_test",
          schema: ConnectionProbe,
          name: "connection_probe",
          description: "Report that the connection works.",
          prompt: 'Reply with {"ok": true}.',
          maxTokens: 64,
        });
        return { ok: true, latencyMs: now() - started, detectedMode: mode, error: null };
      } catch (error) {
        lastError = providerErrorToAppError(error);
        // Only an unsupported output format is worth retrying in another mode;
        // a rejected key, unknown model or network failure fails the same way in every mode.
        const cause = lastError.cause;
        const unsupportedMode =
          lastError.kind === "validation" || (cause instanceof ProviderError && cause.kind === "bad_request");
        if (!unsupportedMode) break;
      }
    }
    return {
      ok: false,
      latencyMs: now() - started,
      detectedMode: null,
      error: lastError ? { kind: lastError.kind, message: lastError.message } : null,
    };
  }

  return { structured, text, testConnection };
}

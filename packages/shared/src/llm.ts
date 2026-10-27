import { z } from "zod";

/** API compatibility format of a model endpoint. */
export const ProviderKind = z.enum(["openai", "anthropic"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/**
 * How a profile produces structured output.
 * `auto` is resolved by the connection test; until then the gateway uses tool calling.
 */
export const StructuredMode = z.enum(["auto", "json_schema", "tool", "prompt"]);
export type StructuredMode = z.infer<typeof StructuredMode>;

/** router: triage and question generation (cheap). planner: documents and task breakdown (strong). */
export const LlmRole = z.enum(["router", "planner"]);
export type LlmRole = z.infer<typeof LlmRole>;

/** Which model serves each role. A null planner falls back to the router model. */
export const RoleAssignment = z.object({
  router: z.number().int().nullable(),
  planner: z.number().int().nullable(),
});
export type RoleAssignment = z.infer<typeof RoleAssignment>;

export const ConnectionTestResult = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nonnegative(),
  detectedMode: StructuredMode.exclude(["auto"]).nullable(),
  error: z
    .object({
      kind: z.string(),
      message: z.string(),
    })
    .nullable(),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResult>;

export interface ProviderPreset {
  id: string;
  label: string;
  /** Base URL per supported compatibility format. */
  urls: Partial<Record<ProviderKind, string>>;
  defaultProvider: ProviderKind;
  modelHint: string;
}

/** Base URLs are API roots, never a full `/chat/completions` endpoint. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    urls: { openai: "https://api.openai.com/v1" },
    defaultProvider: "openai",
    modelHint: "",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    urls: { anthropic: "https://api.anthropic.com" },
    defaultProvider: "anthropic",
    modelHint: "claude-sonnet-5-5",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    urls: { openai: "https://api.deepseek.com", anthropic: "https://api.deepseek.com/anthropic" },
    defaultProvider: "openai",
    modelHint: "deepseek-v4-flash",
  },
  {
    id: "qwen",
    label: "Alibaba Qwen",
    urls: {
      openai: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      anthropic: "https://dashscope.aliyuncs.com/apps/anthropic",
    },
    defaultProvider: "openai",
    modelHint: "",
  },
  {
    id: "glm",
    label: "Zhipu GLM",
    urls: { openai: "https://open.bigmodel.cn/api/paas/v4", anthropic: "https://open.bigmodel.cn/api/anthropic" },
    defaultProvider: "openai",
    modelHint: "",
  },
  {
    id: "mimo",
    label: "Xiaomi MiMo",
    urls: { openai: "https://api.xiaomimimo.com/v1" },
    defaultProvider: "openai",
    modelHint: "mimo-v2.5-pro",
  },
  { id: "custom", label: "Custom", urls: {}, defaultProvider: "openai", modelHint: "" },
];

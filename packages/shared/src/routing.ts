import { z } from "zod";
import { DocumentKind } from "./documents";
import { ProviderKind } from "./llm";
import { type BillingMode, EffectivePrice } from "./models";

export const Tier = z.enum(["T1", "T2", "T3"]);
export type Tier = z.infer<typeof Tier>;
export const TIERS: readonly Tier[] = ["T1", "T2", "T3"];

/**
 * The coding agents KM0 hands work to: the presets below, which KM0 has adapters for, and agents the
 * user defines. `generic` is a plain Markdown prompt for anything else.
 */
export const AgentId = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,39}$/, "An agent ID is lower-case letters, digits, '-' and '_'.");
export type AgentId = z.infer<typeof AgentId>;

export const PRESET_AGENT_IDS = ["claude_code", "codex", "cursor", "pi", "dsh", "zcode", "generic"] as const;
export type PresetAgentId = (typeof PRESET_AGENT_IDS)[number];

export const AGENT_NAMES: Record<PresetAgentId, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  pi: "Pi",
  dsh: "DSH",
  zcode: "ZCode",
  generic: "Generic",
};

export const isPresetAgent = (id: string): id is PresetAgentId => (PRESET_AGENT_IDS as readonly string[]).includes(id);

/**
 * What each preset is: the vendors whose official tool it is (their models run best in it), and the
 * API formats it can be pointed at (empty: it brings its own models or takes any).
 */
export const PRESET_AGENTS: Record<PresetAgentId, { nativeVendors: string[]; apiKinds: ProviderKind[] }> = {
  claude_code: { nativeVendors: ["anthropic"], apiKinds: ["anthropic"] },
  codex: { nativeVendors: ["openai"], apiKinds: ["openai"] },
  cursor: { nativeVendors: ["cursor"], apiKinds: [] },
  pi: { nativeVendors: [], apiKinds: [] },
  dsh: { nativeVendors: ["deepseek"], apiKinds: [] },
  zcode: { nativeVendors: ["z-ai"], apiKinds: [] },
  generic: { nativeVendors: [], apiKinds: [] },
};

/** What an agent is good at. A task needs at most one of these; see `taskCapability` in core. */
export const Capability = z.enum(["frontend", "backend", "debugging", "testing", "docs", "devops"]);
export type Capability = z.infer<typeof Capability>;
export const CAPABILITIES: readonly Capability[] = Capability.options;

/** What a task touches; the model only describes it, the tier is computed from it by rules. */
export const TaskFeatures = z.object({
  /** single_file: one file · few_files: 2–5 files · many_files: more than 5 · new_subsystem: a new module or service. */
  scope: z.enum(["single_file", "few_files", "many_files", "new_subsystem"]),
  ambiguity: z.enum(["low", "medium", "high"]),
  /** follow: do as written · judgement: some choices · design: needs design decisions. */
  reasoning: z.enum(["follow", "judgement", "design"]),
  context: z.enum(["small", "large"]),
  /** Existing tests can check the result. */
  hasTests: z.boolean(),
  risks: z.array(z.enum(["data_migration", "security", "production"])),
  /** fix: find and fix a bug; the other kinds say what the task mostly produces. */
  kind: z.enum(["code", "fix", "test", "docs", "boilerplate", "config"]),
});
export type TaskFeatures = z.infer<typeof TaskFeatures>;
export type TaskRisk = TaskFeatures["risks"][number];

const Points = z.number().int().min(0).max(20);

/**
 * The tunable part of the tier rules: points per feature value and the highest score for T1 and T2.
 * The hard rules (docs, risks, fixes, design) stay fixed. KM0 Runner's `calibrate` writes this file.
 */
export const RoutingRules = z
  .object({
    featurePoints: z.object({
      scope: z.object({ single_file: Points, few_files: Points, many_files: Points, new_subsystem: Points }),
      ambiguity: z.object({ low: Points, medium: Points, high: Points }),
      reasoning: z.object({ follow: Points, judgement: Points, design: Points }),
      context: z.object({ small: Points, large: Points }),
      hasTests: z.object({ true: Points, false: Points }),
    }),
    tierLimits: z.object({ T1: Points, T2: Points }),
  })
  .refine((rules) => rules.tierLimits.T1 <= rules.tierLimits.T2, {
    message: "The T1 limit must not exceed the T2 limit.",
    path: ["tierLimits"],
  });
export type RoutingRules = z.infer<typeof RoutingRules>;

/** The rules in force, and whether they are imported ones rather than KM0's defaults. */
export const RoutingRulesState = z.object({ rules: RoutingRules, custom: z.boolean() });
export type RoutingRulesState = z.infer<typeof RoutingRulesState>;

/** The model an agent runs on a tier: one of the user's models, with what a run on it costs. */
export const TierModel = z.object({
  /** The model entry (Settings → Models). */
  modelRef: z.number().int(),
  /** As passed to the agent. */
  modelId: z.string(),
  name: z.string(),
  canonicalId: z.string().nullable(),
  vendor: z.string().nullable(),
  /** The agent is the official tool of the model's vendor. */
  native: z.boolean(),
  price: EffectivePrice,
  /** USD per million tokens, kept for cost estimates; null when unknown. */
  priceInPerMTok: z.number().nonnegative().nullable(),
  priceOutPerMTok: z.number().nonnegative().nullable(),
});
export type TierModel = z.infer<typeof TierModel>;

export const AgentConfig = z.object({
  id: AgentId,
  name: z.string(),
  kind: z.enum(["preset", "custom"]),
  enabled: z.boolean(),
  /** Lower comes first. */
  preference: z.number().int(),
  models: z.object({ T1: TierModel.nullable(), T2: TierModel.nullable(), T3: TierModel.nullable() }),
  /** Kinds of work the agent is preferred for, among agents that have a model for the tier. */
  capabilities: z.array(Capability),
  nativeVendors: z.array(z.string()),
  /** API formats the agent can use; empty means any. */
  apiKinds: z.array(ProviderKind),
  /** Custom agents: the project instructions file it reads, and the command that starts it. */
  instructionFile: z.string().nullable(),
  launchTemplate: z.string().nullable(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export type { BillingMode };

export const CostRange = z.object({ low: z.number(), high: z.number() });
export type CostRange = z.infer<typeof CostRange>;

export const TaskOverride = z.object({
  tier: Tier.optional(),
  agent: AgentId.optional(),
  model: z.string().trim().min(1).max(200).optional(),
});
export type TaskOverride = z.infer<typeof TaskOverride>;

/** Failed runs on one tier that move a task to the next tier. */
export const ESCALATE_AFTER = 2;

/**
 * One run that did not pass, on the tier the task ran on. `user`: recorded by hand; enough of them lift the
 * task a tier. `runner`: KM0 Runner already climbed to that tier and KM0's acceptance rejected the work, so the
 * next hand-off starts one tier above it at once.
 */
export const TaskFailure = z.object({
  tier: Tier,
  at: z.string(),
  source: z.enum(["user", "runner"]).default("user"),
  reason: z.string().optional(),
});
export type TaskFailure = z.infer<typeof TaskFailure>;

export const SectionRef = z.object({ kind: DocumentKind, sectionId: z.string() });
export type SectionRef = z.infer<typeof SectionRef>;

export const RoutedTask = z.object({
  id: z.number().int(),
  seq: z.number().int(),
  title: z.string(),
  goal: z.string(),
  /** EARS acceptance criteria. */
  acceptance: z.array(z.string()),
  files: z.array(z.string()),
  /** seq numbers of tasks that must be done first. */
  dependsOn: z.array(z.number().int()),
  decisionKeys: z.array(z.string()),
  sections: z.array(SectionRef),
  /** Checks the task from the repository root; the planner's, else the repository's. Null when unknown. */
  testCommand: z.string().nullable(),
  features: TaskFeatures,
  score: z.number().int(),
  /** Tier from the rules, before any override. */
  ruleTier: Tier,
  tier: Tier,
  /** Why the rules picked the tier, one line per factor, then any lift from failed runs. */
  reasons: z.array(z.string()),
  /** Failed runs, oldest first. Enough of them on one tier lift the task to the next. */
  failures: z.array(TaskFailure),
  /** The tier before failed runs lifted it; null when they did not. */
  escalatedFrom: Tier.nullable(),
  /** Failed often enough on T3 that a person has to decide. */
  needsHuman: z.boolean(),
  /** What the task needs the agent to be good at; null when nothing in particular. */
  capability: Capability.nullable(),
  agent: AgentId,
  agentReason: z.string(),
  /** Null when no model is configured for that agent and tier. */
  model: z.string().nullable(),
  /** Estimated tokens and cost of one run; cost is null when the model has no price. */
  tokens: z.object({ input: CostRange, output: CostRange }),
  cost: CostRange.nullable(),
  /** The same task on the agent's T3 model, for the comparison. */
  costAllT3: CostRange.nullable(),
  /** Large enough that splitting it first is advised. */
  splitSuggested: z.boolean(),
  override: TaskOverride.nullable(),
});
export type RoutedTask = z.infer<typeof RoutedTask>;

export const RoutingPlan = z.object({
  projectId: z.number().int(),
  createdAt: z.string(),
  tasks: z.array(RoutedTask),
  totals: z.object({
    cost: CostRange.nullable(),
    costAllT3: CostRange.nullable(),
    /** Share saved against running everything on T3, from the middle of both ranges. */
    saving: z.number().nullable(),
    /** Tasks left out of the totals because their model has no price. */
    unpriced: z.number().int(),
  }),
  tierCounts: z.object({ T1: z.number().int(), T2: z.number().int(), T3: z.number().int() }),
  /** Document versions the plan was made from; a newer version means it may be out of date. */
  basedOn: z.array(z.object({ kind: DocumentKind, version: z.number().int() })),
  outdated: z.boolean(),
});
export type RoutingPlan = z.infer<typeof RoutingPlan>;

const ProjectId = z.number().int().positive();

export const OverrideTaskInput = z.object({
  projectId: ProjectId,
  taskId: z.number().int().positive(),
  /** null clears every override of the task. */
  override: TaskOverride.nullable(),
});

export const TaskRef = z.object({ projectId: ProjectId, taskId: z.number().int().positive() });

export const UpdateAgentInput = z.object({
  id: AgentId,
  enabled: z.boolean(),
  /** The model entry for each tier, or null for none. */
  models: z.object({
    T1: z.number().int().nullable(),
    T2: z.number().int().nullable(),
    T3: z.number().int().nullable(),
  }),
  /** Left out keeps the stored capabilities. */
  capabilities: z.array(Capability).optional(),
});

/** An agent the user adds: anything that can be started with a command or pasted into. */
export const CustomAgentInput = z.object({
  name: z.string().trim().min(1).max(60),
  /** Project instructions file it reads, such as AGENTS.md; null when none. */
  instructionFile: z.string().trim().min(1).max(200).nullable().default(null),
  /** The command that starts it on a task; {prompt}, {task_file} and {model} are filled in. Null when it is pasted into. */
  launchTemplate: z.string().trim().min(1).max(1000).nullable().default(null),
  apiKinds: z.array(ProviderKind).default([]),
  /** The vendor whose official tool it is, such as "google" for Gemini CLI; null when none. */
  nativeVendor: z.string().trim().min(1).max(60).nullable().default(null),
  capabilities: z.array(Capability).default([]),
});
export type CustomAgentInput = z.input<typeof CustomAgentInput>;

export const MoveAgentInput = z.object({ id: AgentId, direction: z.enum(["up", "down"]) });

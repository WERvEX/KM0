import { z } from "zod";
import { DocumentKind } from "./documents";

export const Tier = z.enum(["T1", "T2", "T3"]);
export type Tier = z.infer<typeof Tier>;
export const TIERS: readonly Tier[] = ["T1", "T2", "T3"];

/** The coding agents KM0 hands work to. `generic` is a plain Markdown prompt for anything else. */
export const AgentId = z.enum(["claude_code", "codex", "cursor", "pi", "dsh", "zcode", "generic"]);
export type AgentId = z.infer<typeof AgentId>;

export const AGENT_NAMES: Record<AgentId, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  pi: "Pi",
  dsh: "DSH",
  zcode: "ZCode",
  generic: "Generic",
};

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
  kind: z.enum(["code", "test", "docs", "boilerplate", "config"]),
});
export type TaskFeatures = z.infer<typeof TaskFeatures>;
export type TaskRisk = TaskFeatures["risks"][number];

/** One tier price list entry: model ID and USD per million tokens. */
export const TierModel = z.object({
  modelId: z.string().trim().min(1).max(200),
  priceInPerMTok: z.number().nonnegative().nullable(),
  priceOutPerMTok: z.number().nonnegative().nullable(),
});
export type TierModel = z.infer<typeof TierModel>;

export const AgentConfig = z.object({
  id: AgentId,
  enabled: z.boolean(),
  /** Lower comes first. */
  preference: z.number().int(),
  models: z.object({ T1: TierModel.nullable(), T2: TierModel.nullable(), T3: TierModel.nullable() }),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const CostRange = z.object({ low: z.number(), high: z.number() });
export type CostRange = z.infer<typeof CostRange>;

export const TaskOverride = z.object({
  tier: Tier.optional(),
  agent: AgentId.optional(),
  model: z.string().trim().min(1).max(200).optional(),
});
export type TaskOverride = z.infer<typeof TaskOverride>;

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
  features: TaskFeatures,
  score: z.number().int(),
  /** Tier from the rules, before any override. */
  ruleTier: Tier,
  tier: Tier,
  /** Why the rules picked the tier, one line per factor. */
  reasons: z.array(z.string()),
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

export const UpdateAgentInput = z.object({
  id: AgentId,
  enabled: z.boolean(),
  models: AgentConfig.shape.models,
});

export const MoveAgentInput = z.object({ id: AgentId, direction: z.enum(["up", "down"]) });

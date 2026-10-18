import { z } from "zod";
import { ProjectPath, ProjectSummary } from "./domain";
import { AppErrorShape } from "./errors";

/** Stages in which questions are asked. Fast uses `confirm`, light uses `brief`, full uses the other four. */
export const DiscussionStage = z.enum(["confirm", "brief", "scale", "requirements", "tech", "implementation"]);
export type DiscussionStage = z.infer<typeof DiscussionStage>;

export const TaskType = z.enum(["new_project", "feature", "bugfix", "small_change", "refactor", "docs", "research"]);
export type TaskType = z.infer<typeof TaskType>;

export const Complexity = z.enum(["S", "M", "L", "XL"]);
export type Complexity = z.infer<typeof Complexity>;

export const Triage = z.object({
  title: z.string(),
  taskType: TaskType,
  complexity: Complexity,
  suggestedPath: ProjectPath,
  hasCodebase: z.boolean(),
  summary: z.string(),
  reasons: z.array(z.string()),
});
export type Triage = z.infer<typeof Triage>;

export const QuestionType = z.enum(["single", "multi", "text"]);
export type QuestionType = z.infer<typeof QuestionType>;

export const QuestionOption = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  recommended: z.boolean(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

/** A decision's value: a readable text plus, for multi-select answers, the chosen items. */
export const DecisionValue = z.object({
  text: z.string().trim().min(1),
  items: z.array(z.string()).optional(),
});
export type DecisionValue = z.infer<typeof DecisionValue>;

export const Question = z.object({
  id: z.string(),
  decisionKey: z.string(),
  prompt: z.string(),
  type: QuestionType,
  options: z.array(QuestionOption),
  allowCustom: z.boolean(),
  /** Shown when the question re-checks an existing decision. */
  currentValue: DecisionValue.optional(),
});
export type Question = z.infer<typeof Question>;

/** One answer: chosen options, a custom text, or "let the AI decide". */
export const Answer = z.object({
  questionId: z.string(),
  optionIds: z.array(z.string()).default([]),
  text: z.string().trim().max(2000).optional(),
  delegate: z.boolean().default(false),
});
export type Answer = z.input<typeof Answer>;

export const RoundStatus = z.enum(["open", "answered", "superseded"]);

export const QuestionRound = z.object({
  id: z.number().int(),
  stage: DiscussionStage,
  roundNo: z.number().int(),
  questions: z.array(Question),
  status: RoundStatus,
  /** True when the round re-checks decisions flagged for review. */
  review: z.boolean(),
});
export type QuestionRound = z.infer<typeof QuestionRound>;

export const DecisionSource = z.enum(["user", "recommended", "ai"]);
export type DecisionSource = z.infer<typeof DecisionSource>;

export const Decision = z.object({
  key: z.string(),
  stage: DiscussionStage,
  value: DecisionValue,
  source: DecisionSource,
  rationale: z.string().nullable(),
  alternatives: z.array(z.string()),
  dependsOn: z.array(z.string()),
  needsReview: z.boolean(),
  updatedAt: z.string(),
});
export type Decision = z.infer<typeof Decision>;

/**
 * pending: not reached yet · active: being discussed · ready: required decisions made, waiting
 * for the user to move on · complete: done.
 */
export const StageStatus = z.enum(["pending", "active", "ready", "complete"]);
export type StageStatus = z.infer<typeof StageStatus>;

export const StageState = z.object({
  stage: DiscussionStage,
  status: StageStatus,
  roundsUsed: z.number().int(),
  maxRounds: z.number().int(),
  requiredKeys: z.array(z.string()),
  missingKeys: z.array(z.string()),
  reviewKeys: z.array(z.string()),
});
export type StageState = z.infer<typeof StageState>;

export const ProjectDetail = ProjectSummary.extend({
  description: z.string(),
  repoPath: z.string().nullable(),
  triage: Triage.nullable(),
  stages: z.array(StageState),
  decisions: z.array(Decision),
  openRound: QuestionRound.nullable(),
  /** Every discussion stage of the path is complete. */
  discussionComplete: z.boolean(),
  /** A failure from the last step (for example question generation), so the UI can offer a retry. */
  error: AppErrorShape.nullable(),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

export const CreateProjectInput = z.object({
  description: z.string().trim().min(4).max(8000),
  repoPath: z.string().trim().min(1).nullable().default(null),
});

export const AnswerRoundInput = z.object({
  projectId: z.number().int().positive(),
  roundId: z.number().int().positive(),
  answers: z.array(Answer).max(10),
});

export const AdvanceStageInput = z.object({
  projectId: z.number().int().positive(),
  /** Fill unanswered questions with their recommended options (and let the AI decide the rest). */
  adoptRecommended: z.boolean().default(false),
});

export const UpdateDecisionInput = z.object({
  projectId: z.number().int().positive(),
  key: z.string().min(1),
  value: DecisionValue,
});

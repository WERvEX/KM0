import type {
  Answer,
  Decision,
  DecisionSource,
  DecisionValue,
  DiscussionStage,
  LlmRole,
  ProjectPath,
  Question,
  QuestionOption,
  Research,
  Triage,
} from "@km0/shared";
import type { z } from "zod";
import type { StructuredCall } from "../llm/gateway";
import { keyDef, MAX_QUESTIONS_PER_ROUND, requiredKeys, SCALE_OPTIONS, stageKeys } from "./catalog";
import {
  fillPrompt,
  fillSystem,
  type Language,
  type RoundPromptInput,
  roundPrompt,
  roundSystem,
  triageSystem,
} from "./prompts";
import { FillOutput, RoundOutput, TriageOutput } from "./schemas";

/** The engine's view of the model gateway: pick a role, get validated output. */
export interface DiscussionLlm {
  structured<S extends z.ZodType>(
    role: LlmRole,
    call: Omit<StructuredCall<S>, "profile" | "projectId">,
  ): Promise<z.output<S>>;
}

/** A decision about to be written to the ledger. */
export interface DecisionDraft {
  key: string;
  value: DecisionValue;
  source: DecisionSource;
  rationale: string | null;
  alternatives: string[];
}

export async function triageTask(llm: DiscussionLlm, description: string, language: Language): Promise<Triage> {
  const output = await llm.structured("router", {
    purpose: "triage",
    name: "triage",
    description: "Classify a software task",
    system: triageSystem(language),
    prompt: description,
    schema: TriageOutput,
    maxTokens: 800,
    effort: "low",
  });
  return {
    title: output.title,
    taskType: output.task_type,
    complexity: output.complexity,
    suggestedPath: choosePath(output.task_type, output.complexity),
    hasCodebase: output.has_codebase,
    summary: output.summary,
    reasons: output.reasons,
  };
}

/** Deterministic mapping from triage to path; the user can override it. */
export function choosePath(taskType: Triage["taskType"], complexity: Triage["complexity"]): ProjectPath {
  if (complexity === "L" || complexity === "XL") return "full";
  if (taskType === "new_project") return complexity === "S" ? "light" : "full";
  if (complexity === "M") return "light";
  return "fast";
}

/** Required keys of a stage that are undecided or flagged for review. */
export function missingKeys(stage: DiscussionStage, decisions: Decision[]): string[] {
  const byKey = new Map(decisions.map((decision) => [decision.key, decision]));
  return requiredKeys(stage).filter((name) => {
    const decision = byKey.get(name);
    return !decision || decision.needsReview;
  });
}

export function reviewKeys(stage: DiscussionStage, decisions: Decision[]): string[] {
  return decisions.filter((decision) => decision.stage === stage && decision.needsReview).map((d) => d.key);
}

export interface RoundContext {
  language: Language;
  path: ProjectPath;
  stage: DiscussionStage;
  description: string;
  triage: Triage | null;
  decisions: Decision[];
  roundNo: number;
  mode: RoundPromptInput["mode"];
  repoSummary?: string | null;
  research?: Research | null;
}

export interface RoundPlan {
  questions: Question[];
  inferred: DecisionDraft[];
}

function targetKeysFor(ctx: RoundContext): string[] {
  if (ctx.mode === "review") return reviewKeys(ctx.stage, ctx.decisions);
  const decided = new Set(ctx.decisions.filter((decision) => !decision.needsReview).map((decision) => decision.key));
  const keys = stageKeys(ctx.stage).filter((def) => !decided.has(def.key));
  if (ctx.mode === "more") return keys.filter((def) => !def.required).map((def) => def.key);
  // Required first, then optional keys the model may cover if it has room.
  return [...keys.filter((def) => def.required), ...keys.filter((def) => !def.required)].map((def) => def.key);
}

/** Ask the router model for the next round of questions in a stage. */
export async function planRound(llm: DiscussionLlm, ctx: RoundContext): Promise<RoundPlan> {
  const targetKeys = targetKeysFor(ctx);
  if (targetKeys.length === 0) return { questions: [], inferred: [] };
  const promptInput: RoundPromptInput = {
    language: ctx.language,
    path: ctx.path,
    stage: ctx.stage,
    description: ctx.description,
    triage: ctx.triage,
    decisions: ctx.decisions,
    targetKeys,
    maxQuestions: MAX_QUESTIONS_PER_ROUND,
    mode: ctx.mode,
    repoSummary: ctx.repoSummary ?? null,
    research: ctx.research ?? null,
  };
  const output = await llm.structured("router", {
    purpose: `questions.${ctx.stage}`,
    name: "question_round",
    description: "The next questions to ask the user, and decisions already implied by the context",
    system: roundSystem(promptInput),
    prompt: roundPrompt(promptInput),
    schema: RoundOutput,
    maxTokens: 2500,
    effort: "low",
  });

  const allowed = new Set(targetKeys);
  const inferred: DecisionDraft[] = [];
  for (const item of output.inferred) {
    if (!allowed.has(item.key) || ctx.mode === "review") continue;
    if (inferred.some((draft) => draft.key === item.key)) continue;
    inferred.push({
      key: item.key,
      value: { text: item.value, ...(item.items?.length ? { items: item.items } : {}) },
      source: "ai",
      rationale: item.rationale || null,
      alternatives: [],
    });
  }
  const inferredKeys = new Set(inferred.map((draft) => draft.key));
  const current = new Map(ctx.decisions.map((decision) => [decision.key, decision.value]));
  let optionalSeen = 0;
  // While required keys are open, a round carries at most one optional question.
  const raw = output.questions.filter((item) => {
    if (ctx.mode !== "required" || keyDef(item.key)?.required) return true;
    optionalSeen += 1;
    return optionalSeen <= 1;
  });
  const questions = normalizeQuestions(raw, {
    allowed: new Set(targetKeys.filter((name) => !inferredKeys.has(name))),
    roundNo: ctx.roundNo,
    language: ctx.language,
    currentValues: ctx.mode === "review" ? current : new Map(),
  });
  return { questions, inferred };
}

interface NormalizeOptions {
  allowed: Set<string>;
  roundNo: number;
  language: Language;
  currentValues: Map<string, DecisionValue>;
}

/** Make model-written questions safe to show: known keys only, sane options, one recommendation. */
export function normalizeQuestions(
  raw: z.output<typeof RoundOutput>["questions"],
  options: NormalizeOptions,
): Question[] {
  const seen = new Set<string>();
  const questions: Question[] = [];
  for (const item of raw) {
    if (!options.allowed.has(item.key) || seen.has(item.key)) continue;
    if (questions.length >= MAX_QUESTIONS_PER_ROUND) break;
    seen.add(item.key);

    let type = item.type;
    let choices: QuestionOption[] = item.options.slice(0, 5).map((option, index) => ({
      id: `o${index + 1}`,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      recommended: option.recommended,
    }));

    if (item.key === "scale") {
      // Keep the four delivery forms fixed; carry over the model's recommendation when it matches.
      const recommended = choices.find((choice) => choice.recommended)?.label ?? "";
      choices = SCALE_OPTIONS.map((option) => ({
        id: option.id,
        label: option[options.language],
        recommended: recommended.includes(option[options.language]) || recommended.includes(option.id),
      }));
      type = "single";
    }

    const current = options.currentValues.get(item.key);
    if (current && type !== "text") {
      // A review question always offers "keep it as it is" first.
      choices = [
        { id: "keep", label: current.text, recommended: true },
        ...choices.map((c) => ({ ...c, recommended: false })),
      ];
    }

    if (type !== "text" && choices.length < 2) {
      type = "text";
      choices = [];
    }
    if (type === "single" && choices.length > 0) {
      const first = choices.findIndex((choice) => choice.recommended);
      const pick = first === -1 ? 0 : first;
      choices = choices.map((choice, index) => ({ ...choice, recommended: index === pick }));
    }

    questions.push({
      id: `r${options.roundNo}q${questions.length + 1}`,
      decisionKey: item.key,
      prompt: item.prompt,
      type,
      options: choices,
      allowCustom: type === "text" ? true : item.allow_custom,
      ...(current ? { currentValue: current } : {}),
    });
  }
  return questions;
}

export interface ResolvedAnswers {
  decided: DecisionDraft[];
  /** Keys the user handed to the AI. */
  delegated: string[];
}

/** Turn the user's answers into ledger entries. Unanswered questions are left out. */
export function resolveAnswers(questions: Question[], answers: Answer[]): ResolvedAnswers {
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  const decided: DecisionDraft[] = [];
  const delegated: string[] = [];
  for (const question of questions) {
    const answer = byQuestion.get(question.id);
    if (!answer) continue;
    if (answer.delegate) {
      delegated.push(question.decisionKey);
      continue;
    }
    const chosen = question.options.filter((option) => (answer.optionIds ?? []).includes(option.id));
    const custom = answer.text?.trim();
    const labels = [...chosen.map((option) => option.label), ...(custom ? [custom] : [])];
    if (labels.length === 0) continue;
    if (question.type === "single" && chosen.length > 1) continue;

    const onlyRecommended = !custom && chosen.length > 0 && chosen.every((option) => option.recommended);
    const source: DecisionSource = onlyRecommended ? "recommended" : "user";
    const alternatives = question.options
      .filter((option) => !chosen.includes(option) && option.id !== "keep")
      .map((option) => option.label);
    const keptCurrent = chosen.length === 1 && chosen[0]?.id === "keep" && question.currentValue;
    const value: DecisionValue = keptCurrent
      ? (question.currentValue as DecisionValue)
      : {
          text: labels.join(question.type === "multi" ? "、" : "；"),
          ...(question.type === "multi" ? { items: labels } : {}),
        };
    decided.push({ key: question.decisionKey, value, source, rationale: null, alternatives });
  }
  return { decided, delegated };
}

/** Answers that pick each question's recommended options, used by "adopt the recommendations". */
export function recommendedAnswers(questions: Question[], answered: Set<string> = new Set()): Answer[] {
  return questions
    .filter((question) => !answered.has(question.id))
    .map((question) => {
      const recommended = question.options.filter((option) => option.recommended).map((option) => option.id);
      return recommended.length > 0
        ? { questionId: question.id, optionIds: recommended, delegate: false }
        : { questionId: question.id, optionIds: [], delegate: true };
    });
}

/** Let the planner decide keys the user delegated or that are still open when a stage closes. */
export async function fillDecisions(
  llm: DiscussionLlm,
  ctx: Omit<RoundContext, "roundNo" | "mode">,
  keys: string[],
): Promise<DecisionDraft[]> {
  if (keys.length === 0) return [];
  const input = {
    language: ctx.language,
    path: ctx.path,
    stage: ctx.stage,
    description: ctx.description,
    triage: ctx.triage,
    decisions: ctx.decisions,
    targetKeys: keys,
    repoSummary: ctx.repoSummary ?? null,
    research: ctx.research ?? null,
  };
  const output = await llm.structured("planner", {
    purpose: `fill.${ctx.stage}`,
    name: "decisions",
    description: "Decisions made on the user's behalf",
    system: fillSystem(ctx.language),
    prompt: fillPrompt(input),
    schema: FillOutput,
    maxTokens: 2000,
    effort: "medium",
  });
  const wanted = new Set(keys);
  const drafts: DecisionDraft[] = [];
  for (const item of output.decisions) {
    if (!wanted.has(item.key) || drafts.some((draft) => draft.key === item.key)) continue;
    drafts.push({
      key: item.key,
      value: { text: item.value, ...(item.items?.length ? { items: item.items } : {}) },
      source: "ai",
      rationale: item.rationale || null,
      alternatives: [],
    });
  }
  // A key the model skipped still needs a value so the stage can close; the user can revise it.
  for (const name of keys) {
    if (drafts.some((draft) => draft.key === name)) continue;
    drafts.push({
      key: name,
      value: { text: ctx.language === "zh-CN" ? "待定，由实现时决定" : "Open; decide during implementation" },
      source: "ai",
      rationale: null,
      alternatives: [],
    });
  }
  return drafts;
}

export function labelOf(name: string, language: Language): string {
  return keyDef(name)?.label[language] ?? name;
}

import type { Decision, DiscussionStage, ProjectPath, Triage } from "@km0/shared";
import { keyDef, SCALE_DEFAULTS, SCALE_OPTIONS, scaleIdFromText, stageKeys } from "./catalog";

export type Language = "zh-CN" | "en";

export function languageRule(language: Language): string {
  return language === "zh-CN"
    ? "Write every user-facing string (titles, questions, options, descriptions, values, rationales, reasons) in Simplified Chinese."
    : "Write every user-facing string in English.";
}

export function triageSystem(language: Language): string {
  return [
    "You are the triage step of KM0, a tool that prepares software tasks before they go to coding agents.",
    "Classify the user's task. Do not plan or solve it.",
    "task_type: new_project (build something new from scratch), feature (add capability to an existing system), bugfix, small_change (copy, config, styling, tiny tweak), refactor, docs, research (investigate or compare, no code yet).",
    "complexity: S = one clear change touching about one file; M = a feature or fix across a few files in one area; L = several modules or a small new application; XL = a new product or system with many parts.",
    "has_codebase: true when the task clearly modifies an existing codebase.",
    "title: a short name for the task (at most 20 Chinese characters or 8 English words).",
    "summary: one sentence restating the task. reasons: 1-3 short reasons for the complexity.",
    languageRule(language),
  ].join("\n");
}

const STAGE_PURPOSE: Record<DiscussionStage, string> = {
  confirm: "Confirm the exact scope of a small task and how to tell it is done.",
  brief: "Settle scope, approach and acceptance of a medium-sized task in as few questions as possible.",
  scale: "Stage A: positioning and scale. These answers set defaults for everything after.",
  requirements: "Stage B: product requirements: who uses it, what they do, and what the first release contains.",
  tech: "Stage C: technology choices, layer by layer, consistent with the delivery form and requirements already decided.",
  implementation:
    "Stage D: implementation plan. Offer 2-3 complete, concrete alternatives per key (for example a named architecture with its components, or an ordered milestone list) and let the user pick or adjust.",
};

function describeDecision(decision: Decision): string {
  const def = keyDef(decision.key);
  const review = decision.needsReview ? " (flagged for review)" : "";
  return `- ${decision.key} (${def?.brief ?? ""}): ${decision.value.text}${review}`;
}

export interface RoundPromptInput {
  language: Language;
  path: ProjectPath;
  stage: DiscussionStage;
  description: string;
  triage: Triage | null;
  decisions: Decision[];
  /** Keys this round should settle, in priority order. */
  targetKeys: string[];
  maxQuestions: number;
  mode: "required" | "more" | "review";
}

export function roundSystem(input: RoundPromptInput): string {
  const rules = [
    "You are KM0's requirements interviewer. You help the user settle decisions before any code is written.",
    "Infer first, ask second. Whenever the task description, the triage or earlier decisions make a key reasonably clear, put it in `inferred` with the value and a one-sentence rationale instead of asking. The user can correct inferred decisions later, so lean towards inferring.",
    `Ask at most ${input.maxQuestions} questions, only the ones whose answer changes the outcome most. Fewer is better; zero is fine.`,
    "Ask required keys first. Ask at most one optional key per round, and only when it clearly matters for this task.",
    "Each question settles exactly one decision key from the list you are given, and uses that key in `key`.",
    "Write for someone who may not be a developer: plain words, no jargon without a short explanation, one idea per question.",
    "Options must be concrete and specific to this task: real technology names (for example 'PostgreSQL', 'Next.js', 'Electron'), real features and real user groups taken from the description. Never offer generic placeholders such as 'option A', 'simple approach' or 'other'; the user can always type their own answer.",
    "Prefer `single` with 2-4 meaningfully different options. Use `multi` for lists such as scenarios, features or integrations, drawing candidates from the description plus the obvious additions. Use `text` only when options make no sense.",
    "Mark as `recommended` what you would actually choose for this task (exactly one for single questions; the sensible defaults for multi questions), and start that option's `description` with the reason. Every other description states its trade-off in one sentence.",
    "Option labels are short (at most 16 Chinese characters or 6 English words).",
    "Never ask about keys that are already decided unless they are flagged for review.",
    "Write prompts as direct questions to the user.",
  ];
  if (input.stage === "scale") {
    rules.push(
      `For the key \`scale\`, the options must be exactly: ${SCALE_OPTIONS.map((option) => option[input.language]).join(" / ")}.`,
    );
  }
  if (input.mode === "more") {
    rules.push(
      "All required decisions of this stage are made. Ask only about optional keys or refinements that clearly add value; return no questions if nothing does.",
    );
  }
  if (input.mode === "review") {
    rules.push(
      "These decisions were flagged because something they depend on changed. Ask whether each still holds, offering adjusted alternatives.",
    );
  }
  rules.push(languageRule(input.language));
  return rules.join("\n");
}

export function roundPrompt(input: RoundPromptInput): string {
  const decided = input.decisions.length > 0 ? input.decisions.map(describeDecision).join("\n") : "(none yet)";
  const targets = input.targetKeys
    .map((name) => {
      const def = keyDef(name);
      return `- ${name}${def?.required ? " (required)" : ""}: ${def?.brief ?? ""}`;
    })
    .join("\n");
  const optional = stageKeys(input.stage)
    .filter((def) => !def.required && !input.targetKeys.includes(def.key))
    .map((def) => def.key);
  const parts = [
    `Task description:\n${input.description}`,
    input.triage
      ? `Triage: ${input.triage.taskType}, complexity ${input.triage.complexity}. ${input.triage.summary}`
      : "",
    `Path: ${input.path}. Current stage: ${input.stage}. ${STAGE_PURPOSE[input.stage]}`,
    `Decisions so far:\n${decided}`,
    `Keys to settle now:\n${targets || "(none)"}`,
    optional.length > 0 ? `Optional keys you may also cover if worthwhile: ${optional.join(", ")}` : "",
  ];
  if (input.stage === "tech") {
    const scale = input.decisions.find((decision) => decision.key === "scale");
    const scaleId = scale ? scaleIdFromText(scale.value.text) : null;
    if (scaleId) parts.push(`Default recommendations for this delivery form: ${SCALE_DEFAULTS[scaleId]}`);
  }
  return parts.filter(Boolean).join("\n\n");
}

export function fillSystem(language: Language): string {
  return [
    "You are KM0. The user asked you to make some decisions for them.",
    "Decide every listed key with a concrete value that fits the task and the decisions already made: name real technologies, features or steps, never a vague placeholder.",
    "Prefer the simplest choice that satisfies the requirements. Give a one-sentence rationale for each.",
    languageRule(language),
  ].join("\n");
}

export function fillPrompt(input: Omit<RoundPromptInput, "maxQuestions" | "mode">): string {
  return roundPrompt({ ...input, maxQuestions: 0, mode: "required" }).replace("Keys to settle now:", "Keys to decide:");
}

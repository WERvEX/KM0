import { z } from "zod";
import type { DiscussionLlm } from "../discussion/engine";
import { type Language, languageRule } from "../discussion/prompts";

export const AcceptanceOutput = z.object({
  accepted: z.boolean(),
  /** One or two sentences: what is missing or wrong, or why the change meets the criteria. */
  reason: z.string().trim().min(1).max(2000),
});
export type AcceptanceOutput = z.infer<typeof AcceptanceOutput>;

export interface AcceptanceInput {
  language: Language;
  title: string;
  goal: string;
  /** The task's EARS criteria. */
  acceptance: string[];
  /**
   * The decisions the task's hand-off listed, as `label: value`. A condition stated only there still binds
   * the change, so the reviewer checks them too.
   */
  decisions: string[];
  /** The task's change as a unified diff; null when the Runner changed nothing. */
  diff: string | null;
  testCommand: string | null;
  /** The Runner's own test run: passed is null when it had no command to run. */
  testResult: { passed: boolean | null; detail: string } | null;
  /** The Runner gave up on the task (failed tests on the top tier, a spent budget, an error). */
  failure: string | null;
}

/** Longer diffs keep their start and end, so the model still sees the shape of the change. */
export const MAX_DIFF_CHARS = 60_000;

export function acceptanceSystem(input: AcceptanceInput): string {
  return [
    "You are KM0's reviewer. A coding agent worked on one task in its own branch; decide whether the change meets the task's acceptance criteria.",
    "Judge only from the goal, the criteria, the decisions, the diff and the test run shown. Any condition a listed decision sets for this change (a done-when condition, a rule, an order of steps) counts as a criterion too. Accept when every criterion is met by the change, or is clearly not applicable to it. Reject when a criterion is not met, the change does something else, breaks existing behaviour, or is empty.",
    "A passing test run is evidence, not proof: tests can miss criteria. A failing test run is a strong reason to reject unless the failure is unrelated to the task.",
    "`reason`: one or two sentences. On a rejection, say what is missing or wrong so the next attempt can fix it.",
    languageRule(input.language),
  ].join("\n");
}

export function acceptancePrompt(input: AcceptanceInput): string {
  const diff = input.diff?.trim() ? truncate(input.diff, MAX_DIFF_CHARS) : "(no changes)";
  const test = !input.testResult
    ? "Not run."
    : input.testResult.passed === null
      ? "No test command for this task."
      : `${input.testResult.passed ? "Passed" : "Failed"}${input.testCommand ? ` (\`${input.testCommand}\`)` : ""}.\n${truncate(input.testResult.detail, 4000)}`;
  return [
    `Task: ${input.title}`,
    `Goal:\n${input.goal}`,
    `Acceptance criteria:\n${input.acceptance.map((item) => `- ${item}`).join("\n") || "- (none listed: judge against the goal)"}`,
    input.decisions.length > 0
      ? `Decisions the task relies on:\n${input.decisions.map((item) => `- ${item}`).join("\n")}`
      : "",
    input.failure ? `The agent gave up: ${input.failure}` : "",
    `Test run:\n${test}`,
    `Diff:\n\`\`\`diff\n${diff}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… (${text.length - max} characters left out) …\n${text.slice(-half)}`;
}

/** KM0's acceptance of one Runner task: the planner's model checks the change against the EARS criteria. */
export async function judgeTask(llm: DiscussionLlm, input: AcceptanceInput): Promise<AcceptanceOutput> {
  return llm.structured("planner", {
    purpose: "acceptance",
    name: "acceptance_verdict",
    description: "Whether the change meets the task's acceptance criteria",
    system: acceptanceSystem(input),
    prompt: acceptancePrompt(input),
    schema: AcceptanceOutput,
    maxTokens: 2_000,
    effort: "high",
  });
}

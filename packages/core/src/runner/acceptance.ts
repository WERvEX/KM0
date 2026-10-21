import { z } from "zod";
import type { DiscussionLlm } from "../discussion/engine";
import { type Language, languageRule } from "../discussion/prompts";
import { clipRequest, fence } from "../handoff/build";

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
  /**
   * The changes of the earlier tasks this one depends on, already on its branch. A criterion they meet is met
   * for this task too, so an empty diff can still pass.
   */
  upstream?: { title: string; diff: string | null }[];
  /** Titles of the request's other tasks that are not upstream of this one; work they own is not this task's. */
  others?: string[];
  /** The user's request as written; its examples and exact formats bind the change where the task covers them. */
  request?: string | null;
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
    "Judge only from the goal, the criteria, the decisions, the diff and the test run shown. Any condition a listed decision sets for this change (a done-when condition, a rule, an order of steps) counts as a criterion too. Accept when every criterion is met by the change, or is clearly not applicable to it. Reject when a criterion is not met, the change does something else or breaks existing behaviour.",
    "The task's branch starts from its upstream tasks' changes, shown separately when there are any. Judge the code as it stands with them: a criterion an upstream change already meets is met here too (an earlier task often writes the tests a later task asks for), so an empty diff passes when the upstream changes meet every criterion. Reject an empty diff otherwise.",
    "Where a criterion or the request gives an exact format or an example (sample output, input and expected result), compare the change against it literally: line breaks and blank lines, order, what is left out. Tests the agent wrote itself may share its misreading.",
    "Judge the result, not where it is done: when the behaviour a criterion asks for holds in the code as it stands, accept it even if the step sits in another function than you would expect. Work that another listed task of the request owns, or a chore for the whole request (such as regenerating docs), is not a reason to reject this task unless its own criteria ask for it.",
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
    input.request?.trim()
      ? `The request as written (this task covers only part of it when the work was split):\n${fence(clipRequest(input.request, "… (cut)"), "markdown")}`
      : "",
    input.others && input.others.length > 0
      ? `Other tasks of this request, judged separately:\n${input.others.map((title) => `- ${title}`).join("\n")}`
      : "",
    input.failure ? `The agent gave up: ${input.failure}` : "",
    `Test run:\n${test}`,
    `Diff:\n\`\`\`diff\n${diff}\n\`\`\``,
    upstreamSection(input.upstream ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Upstream changes share one budget, so a long chain of tasks cannot crowd out the task's own diff. */
export const MAX_UPSTREAM_CHARS = 40_000;

function upstreamSection(upstream: { title: string; diff: string | null }[]): string {
  const changed = upstream.filter((item) => item.diff?.trim());
  if (changed.length === 0) return "";
  const share = Math.floor(MAX_UPSTREAM_CHARS / changed.length);
  return [
    "Upstream changes already on this branch:",
    ...changed.map((item) => `### ${item.title}\n\`\`\`diff\n${truncate(item.diff ?? "", share)}\n\`\`\``),
  ].join("\n\n");
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

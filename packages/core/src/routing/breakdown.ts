import {
  type Decision,
  DOCUMENT_TEMPLATES,
  type DocumentKind,
  type ProjectPath,
  type SectionRef,
  type TaskFeatures,
  type Triage,
} from "@km0/shared";
import { z } from "zod";
import { keyDef } from "../discussion/catalog";
import type { DiscussionLlm } from "../discussion/engine";
import { type Language, languageRule } from "../discussion/prompts";

const Features = z.object({
  scope: z.enum(["single_file", "few_files", "many_files", "new_subsystem"]),
  ambiguity: z.enum(["low", "medium", "high"]),
  reasoning: z.enum(["follow", "judgement", "design"]),
  context: z.enum(["small", "large"]),
  has_tests: z.boolean(),
  risks: z.array(z.enum(["data_migration", "security", "production"])).default([]),
  kind: z.enum(["code", "fix", "test", "docs", "boilerplate", "config"]),
});

export const BreakdownOutput = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(120),
        goal: z.string().trim().min(1),
        acceptance: z.array(z.string().trim().min(1)).default([]),
        files: z.array(z.string()).default([]),
        depends_on: z.array(z.number().int()).default([]),
        decision_keys: z.array(z.string()).default([]),
        sections: z.array(z.string()).default([]),
        test_command: z.string().trim().min(1).nullable().default(null),
        features: Features,
      }),
    )
    .min(1)
    .max(20),
});

export interface BreakdownInput {
  language: Language;
  path: ProjectPath;
  title: string;
  description: string;
  triage: Triage | null;
  decisions: Decision[];
  /** Latest version of each document of the path, as Markdown with section markers. */
  documents: { kind: DocumentKind; sections: { id: string; title: string; body: string }[] }[];
}

/** A task as the planner proposed it, cleaned up, before routing. */
export interface PlannedTask {
  seq: number;
  title: string;
  goal: string;
  acceptance: string[];
  files: string[];
  dependsOn: number[];
  decisionKeys: string[];
  sections: SectionRef[];
  /** A command that checks this task, when the planner named one. */
  testCommand: string | null;
  features: TaskFeatures;
}

const TASK_COUNT: Record<ProjectPath, string> = { fast: "1-2", light: "2-5", full: "4-12" };

export function breakdownSystem(input: BreakdownInput): string {
  return [
    "You are KM0's planner. Split the agreed work into tasks for coding agents. You describe each task; KM0 picks the model tier and agent from your description with fixed rules, so describe honestly and do not mention models or agents.",
    `Return ${TASK_COUNT[input.path]} tasks. Each task must fit in one agent session and be checkable on its own.`,
    "Order tasks so that prerequisites come first. `depends_on` lists the 1-based numbers of earlier tasks it needs.",
    "Keep a change and its tests in the same task: the agent writing the code writes or updates its tests too. Do not make a task that only adds tests for another task's change; a test-only task is right only for code that already exists and is not changed by another task.",
    "Keep risky work (data migrations, authentication and permissions, production configuration), bug fixes, and pure documentation or boilerplate in tasks of their own, so they can be routed differently.",
    "For each task: `title` is a short imperative; `goal` is one or two sentences; `acceptance` holds the task's criteria in EARS form (see below); `files` lists paths or globs likely touched (planned paths for new code); `decision_keys` are ledger keys the task relies on; `sections` are document sections it implements, written as `<kind>.<section id>` (for example `prd.functional`).",
    "`acceptance`: carry over every acceptance criterion or done-when condition stated in the task description, the decision ledger or the documents to the task it applies to, one EARS criterion each. Do not drop, merge or soften any of them, and do not leave one only in a referenced decision: the reviewer checks the `acceptance` list. Add your own criteria only so that every task has at least two.",
    "Write each criterion as behaviour that can be observed from outside the code: what a user, an API client or a caller of an interface the request names sees (responses, output, stored data, errors). Do not prescribe internal structure (which function does a step, where sorting or validation happens, private helpers) unless the description or the documents require it: the agent may meet a criterion any way it likes.",
    "When the description or the documents give a concrete example (sample output, an exact format, an input and its expected result), copy it verbatim into the criterion it illustrates, line breaks included; never paraphrase a format.",
    "`test_command`: a shell command, run from the repository root, that checks this task (for example the repository's test command, or a narrower one for the task's tests); null when nothing can check it automatically.",
    "features.scope: single_file = one file; few_files = 2-5 files; many_files = more than 5; new_subsystem = a new module, service or app.",
    "features.ambiguity: how much is still unclear after the decisions and documents. features.reasoning: follow = do as written; judgement = some local choices; design = needs design decisions about structure or interfaces.",
    "features.context: large when the agent must read much existing code or many documents. features.has_tests: true only if existing tests already cover the area. features.risks: only real risks. features.kind: what the task mostly produces; fix = finding and fixing a bug in existing code.",
    languageRule(input.language),
  ].join("\n");
}

export function breakdownPrompt(input: BreakdownInput): string {
  const ledger =
    input.decisions
      .map(
        (decision) => `- ${keyDef(decision.key)?.label.en ?? decision.key} (${decision.key}): ${decision.value.text}`,
      )
      .join("\n") || "(empty)";
  const documents = input.documents
    .map(
      (doc) =>
        `## Document: ${doc.kind}\n${doc.sections.map((section) => `@@section:${doc.kind}.${section.id} — ${section.title}\n${section.body}`).join("\n\n")}`,
    )
    .join("\n\n");
  return [
    `Project: ${input.title}`,
    `Task description:\n${input.description}`,
    input.triage
      ? `Triage: ${input.triage.taskType}, complexity ${input.triage.complexity}, ${input.triage.hasCodebase ? "changes an existing codebase" : "new codebase"}. ${input.triage.summary}`
      : "",
    `Path: ${input.path}`,
    `Decision ledger:\n${ledger}`,
    documents || "No documents were written for this path; work from the decisions.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Ask the planner for tasks and keep only references that point at something real. */
export async function breakDown(llm: DiscussionLlm, input: BreakdownInput): Promise<PlannedTask[]> {
  const output = await llm.structured("planner", {
    purpose: "breakdown",
    name: "task_breakdown",
    description: "Tasks for coding agents, in dependency order",
    system: breakdownSystem(input),
    prompt: breakdownPrompt(input),
    schema: BreakdownOutput,
    maxTokens: 12_000,
    effort: "medium",
  });
  const known = new Set(input.decisions.map((decision) => decision.key));
  const sectionIds = new Set(
    input.documents.flatMap((doc) =>
      DOCUMENT_TEMPLATES[doc.kind].sections.map((section) => `${doc.kind}.${section.id}`),
    ),
  );
  return output.tasks.map((task, index) => {
    const seq = index + 1;
    return {
      seq,
      title: task.title,
      goal: task.goal,
      acceptance: task.acceptance,
      files: [...new Set(task.files.map((file) => file.trim()).filter(Boolean))],
      // Only earlier tasks can be prerequisites, which also rules out cycles.
      dependsOn: [...new Set(task.depends_on)].filter((dep) => dep >= 1 && dep < seq),
      decisionKeys: [...new Set(task.decision_keys)].filter((key) => known.has(key)),
      sections: [...new Set(task.sections)]
        .filter((ref) => sectionIds.has(ref))
        .map((ref) => {
          const [kind, sectionId] = ref.split(".") as [DocumentKind, string];
          return { kind, sectionId };
        }),
      testCommand: task.test_command,
      features: {
        scope: task.features.scope,
        ambiguity: task.features.ambiguity,
        reasoning: task.features.reasoning,
        context: task.features.context,
        hasTests: task.features.has_tests,
        risks: [...new Set(task.features.risks)],
        kind: task.features.kind,
      },
    };
  });
}

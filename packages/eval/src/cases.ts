import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Decision, ProjectPath } from "@km0/shared";
import { z } from "zod";

/**
 * The eval set. Two kinds of case, each a JSON file under `cases/`:
 *
 * - breakdown: a request (with its decisions and documents) and the acceptance criteria it states. The
 *   planner's tasks must carry every one of them; a criterion counts as kept when one task criterion
 *   mentions every word of one of its `match` alternatives (case and width insensitive).
 * - judge: a task, the change an agent made, and what hidden tests said about it. KM0's verdict should
 *   agree with the hidden tests.
 */

const Language = z.enum(["zh-CN", "en"]);

export const BreakdownCase = z.object({
  id: z.string(),
  /** What this case guards against, in a sentence. */
  why: z.string(),
  language: Language,
  path: ProjectPath,
  title: z.string(),
  description: z.string(),
  decisions: z.array(Decision.partial().extend({ key: z.string(), value: z.object({ text: z.string() }) })).default([]),
  documents: z
    .array(
      z.object({
        kind: z.enum(["prd", "tech_design", "brief"]),
        sections: z.array(z.object({ id: z.string(), title: z.string(), body: z.string() })),
      }),
    )
    .default([]),
  criteria: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      /** Alternatives; each is a list of words that must all appear in one task criterion. */
      match: z.array(z.array(z.string().min(1)).min(1)).min(1),
    }),
  ),
});
export type BreakdownCase = z.infer<typeof BreakdownCase>;

export const JudgeCase = z.object({
  id: z.string(),
  why: z.string(),
  language: Language,
  request: z.string().nullable().default(null),
  task: z.object({
    title: z.string(),
    goal: z.string(),
    acceptance: z.array(z.string()),
    decisions: z.array(z.string()).default([]),
  }),
  diff: z.string().nullable(),
  upstream: z.array(z.object({ title: z.string(), diff: z.string().nullable() })).default([]),
  others: z.array(z.string()).default([]),
  testCommand: z.string().nullable().default(null),
  /** What the Runner's own test run reported, as the reviewer sees it. */
  testResult: z.object({ passed: z.boolean().nullable(), detail: z.string() }).nullable().default(null),
  /** The hidden tests: never shown to the reviewer; the verdict should match them. */
  hidden: z.object({ passed: z.boolean(), detail: z.string() }),
});
export type JudgeCase = z.infer<typeof JudgeCase>;

export interface EvalSet {
  breakdown: BreakdownCase[];
  judge: JudgeCase[];
}

function readDir<T>(dir: string, schema: z.ZodType<T>): T[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const parsed = schema.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (!parsed.success) throw new Error(`${name}: ${parsed.error.message}`);
      return parsed.data;
    });
}

export function loadCases(root: string): EvalSet {
  return {
    breakdown: readDir(join(root, "breakdown"), BreakdownCase),
    judge: readDir(join(root, "judge"), JudgeCase),
  };
}

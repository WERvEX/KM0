import { z } from "zod";
import { Tier } from "./routing";

/**
 * KM0 Runner's execution report (report_version 2), as far as KM0 reads it. The Runner writes one per task to
 * `runs/<run_id>/reports/NN.json`; unknown fields are kept so nothing is lost when the Runner adds more.
 */
export const RunnerReport = z
  .object({
    report_version: z.literal(2),
    run_id: z.string(),
    project_id: z.union([z.number(), z.string()]).nullable().optional(),
    task_id: z.string(),
    title: z.string().default(""),
    predicted_tier: z.string().nullable(),
    start_tier: z.string().nullable(),
    explored: z.boolean().default(false),
    /** Tier on which the Runner's test command passed. */
    solved_tier: z.string().nullable(),
    escalations: z
      .array(
        z.object({ from_tier: z.string(), to_tier: z.string(), signal: z.string(), detail: z.string() }).passthrough(),
      )
      .default([]),
    cost: z.number().default(0),
    steps: z.number().int().default(0),
    test_command: z.string().nullable().optional(),
    test_result: z.object({ passed: z.boolean().nullable(), judge: z.string(), detail: z.string() }).nullable(),
    failure_category: z.string().nullable(),
    failure_detail: z.string().default(""),
    branch: z.string().nullable(),
    commit: z.string().nullable(),
    diff: z.string().nullable(),
    acceptance: z.array(z.string()).default([]),
    attempts: z.array(z.object({ tier: z.string(), model: z.string(), cost: z.number() }).passthrough()).default([]),
  })
  .passthrough();
export type RunnerReport = z.infer<typeof RunnerReport>;

/** KM0's verdict on one task of a run, one line of `runs/<run_id>/acceptance.jsonl`. */
export const RunnerVerdict = z.object({
  run_id: z.string(),
  task_id: z.string(),
  accepted: z.boolean(),
  reason: z.string(),
  /** The model that judged. */
  judged_by: z.string(),
  /** The user's verdict after a spot check; null when they did not change it. */
  user_override: z.boolean().nullable(),
  judged_at: z.string(),
});
export type RunnerVerdict = z.infer<typeof RunnerVerdict>;

export const RunnerTaskResult = z.object({
  id: z.number().int(),
  seq: z.number().int(),
  title: z.string(),
  /** The tier the Runner finished on: where the work was done. */
  tier: Tier.nullable(),
  report: RunnerReport,
  /** Lines added and removed by the change. */
  diffStat: z.object({ files: z.number().int(), added: z.number().int(), removed: z.number().int() }),
  verdict: RunnerVerdict.nullable(),
  /** The verdict that counts: the user's override, else KM0's. Null until judged. */
  accepted: z.boolean().nullable(),
});
export type RunnerTaskResult = z.infer<typeof RunnerTaskResult>;

export const RunnerRun = z.object({
  id: z.number().int(),
  projectId: z.number().int(),
  runId: z.string(),
  /** Where the run directory is; on the web build, a label for the picked folder. */
  path: z.string(),
  importedAt: z.string(),
  cost: z.number(),
  results: z.array(RunnerTaskResult),
  /** acceptance.jsonl could not be written back (the folder is no longer open); verdicts are kept in KM0. */
  writeBackPending: z.boolean(),
});
export type RunnerRun = z.infer<typeof RunnerRun>;

const ProjectId = z.number().int().positive();
/** A run by its id in KM0 (RunnerRun.id), not the Runner's run_id. */
export const RunnerRunRef = z.object({ projectId: ProjectId, runRef: z.number().int().positive() });
export const RunnerOverrideInput = z.object({
  projectId: ProjectId,
  resultId: z.number().int().positive(),
  /** null drops the override and goes back to KM0's verdict. */
  accepted: z.boolean().nullable(),
});

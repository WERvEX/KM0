import { Complexity, TaskType } from "@km0/shared";
import { z } from "zod";

/** What the router model returns for triage. The path itself is derived by rules. */
export const TriageOutput = z.object({
  title: z.string().trim().min(1).max(80),
  task_type: TaskType,
  complexity: Complexity,
  has_codebase: z.boolean(),
  summary: z.string().trim().min(1),
  reasons: z.array(z.string()).max(5),
});
export type TriageOutput = z.infer<typeof TriageOutput>;

const DraftDecision = z.object({
  key: z.string(),
  value: z.string().trim().min(1),
  items: z.array(z.string()).optional(),
  rationale: z.string().default(""),
});

export const RoundOutput = z.object({
  inferred: z.array(DraftDecision).default([]),
  questions: z
    .array(
      z.object({
        key: z.string(),
        prompt: z.string().trim().min(1),
        type: z.enum(["single", "multi", "text"]),
        options: z
          .array(
            z.object({
              label: z.string().trim().min(1),
              description: z.string().optional(),
              recommended: z.boolean().default(false),
            }),
          )
          .default([]),
        allow_custom: z.boolean().default(true),
      }),
    )
    .default([]),
});
export type RoundOutput = z.infer<typeof RoundOutput>;

export const FillOutput = z.object({ decisions: z.array(DraftDecision) });
export type FillOutput = z.infer<typeof FillOutput>;

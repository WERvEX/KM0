import { z } from "zod";

/** Technology layers a scan can recognise; they match the stage C decision keys. */
export const StackLayer = z.enum(["frontend", "backend", "storage", "deployment"]);
export type StackLayer = z.infer<typeof StackLayer>;

/** One recognised technology and the file that shows it. */
export const StackItem = z.object({
  layer: StackLayer,
  name: z.string(),
  file: z.string(),
});
export type StackItem = z.infer<typeof StackItem>;

/** What a read-only scan of a local repository found. */
export const RepoScan = z.object({
  /** The path the user picked (on the web build, a label for the picked folder). */
  root: z.string(),
  name: z.string(),
  fileCount: z.number().int().nonnegative(),
  /** The walk stopped at its file limit, so counts are a lower bound. */
  truncated: z.boolean(),
  /** Languages by file count, largest first. */
  languages: z.array(z.object({ name: z.string(), files: z.number().int() })),
  stack: z.array(StackItem),
  packageManagers: z.array(z.string()),
  hasTests: z.boolean(),
  /** The command that runs the repository's tests, from its manifests; null when none is evident. */
  testCommand: z.string().nullable().default(null),
  hasCi: z.boolean(),
  /** Top-level entries, for the model's orientation. */
  topLevel: z.array(z.string()),
  readme: z.string().nullable(),
  scannedAt: z.string(),
});
export type RepoScan = z.infer<typeof RepoScan>;

export const ScanRepoInput = z.object({ path: z.string().trim().min(1).max(1000) });

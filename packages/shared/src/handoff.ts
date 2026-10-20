import { z } from "zod";
import { AgentId, Tier } from "./routing";

/** Who runs the package: coding agents driven by hand, or KM0 Runner, which escalates tiers itself. */
export const HandoffTarget = z.enum(["agents", "runner"]);
export type HandoffTarget = z.infer<typeof HandoffTarget>;

export const HandoffFile = z.object({ path: z.string(), content: z.string() });
export type HandoffFile = z.infer<typeof HandoffFile>;

export const HandoffTask = z.object({
  taskId: z.number().int(),
  seq: z.number().int(),
  title: z.string(),
  tier: Tier,
  agent: AgentId,
  model: z.string().nullable(),
  /** Where the task prompt sits inside the package. */
  promptPath: z.string(),
  prompt: z.string(),
  /** A command that starts the agent on this task; null when the agent is driven from its own UI. */
  command: z.string().nullable(),
});
export type HandoffTask = z.infer<typeof HandoffTask>;

export const HandoffAgent = z.object({
  id: AgentId,
  /** Project instructions file the agent reads by itself, as placed in the package. */
  instructionsPath: z.string().nullable(),
  /** How to start the agent and what is still unverified about it. */
  howTo: z.string(),
});
export type HandoffAgent = z.infer<typeof HandoffAgent>;

/** Everything a coding agent needs, laid out to be unpacked at the root of the target repository. */
export const HandoffPackage = z.object({
  projectId: z.number().int(),
  createdAt: z.string(),
  target: HandoffTarget.default("agents"),
  /** Folder every file lives in, so unpacking never overwrites the repository's own files. */
  root: z.string(),
  files: z.array(HandoffFile),
  tasks: z.array(HandoffTask),
  agents: z.array(HandoffAgent),
});
export type HandoffPackage = z.infer<typeof HandoffPackage>;

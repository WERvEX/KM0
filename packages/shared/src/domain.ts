import { z } from "zod";

/** How deep the discussion goes, decided by triage and overridable by the user. */
export const ProjectPath = z.enum(["fast", "light", "full"]);
export type ProjectPath = z.infer<typeof ProjectPath>;

/** Where a project currently is. Discussion stages A–D only apply to the full path. */
export const ProjectStage = z.enum([
  "triage",
  "scale",
  "requirements",
  "tech",
  "implementation",
  "documents",
  "routing",
  "handoff",
]);
export type ProjectStage = z.infer<typeof ProjectStage>;

export const ProjectStatus = z.enum(["active", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const ProjectSummary = z.object({
  id: z.number().int(),
  title: z.string(),
  path: ProjectPath.nullable(),
  stage: ProjectStage,
  status: ProjectStatus,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

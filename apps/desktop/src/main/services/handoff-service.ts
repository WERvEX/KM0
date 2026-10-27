import { buildHandoff, type Language } from "@km0/core";
import {
  AppError,
  type HandoffPackage,
  type HandoffTarget,
  PATH_DOCUMENTS,
  type ProjectPath,
  RepoScan,
} from "@km0/shared";
import { type Database, nowIso, transaction } from "../db/sql";
import { latestDocument } from "./document-service";
import { readDecisions } from "./project-service";
import type { RoutingService } from "./routing-service";

/** Packages the routed tasks with their context for the coding agents. Export only: nothing is written to the target repository. */
export class HandoffService {
  constructor(
    private readonly db: Database,
    private readonly routing: RoutingService,
    private readonly language: () => Language,
  ) {}

  build(projectId: number, target: HandoffTarget = "agents"): HandoffPackage {
    const plan = this.routing.get(projectId);
    if (!plan || plan.tasks.length === 0) {
      throw new AppError("conflict", "Break the work into tasks before building the hand-off package.");
    }
    const project = this.db
      .prepare("SELECT title, description, path, repo_scan_json FROM projects WHERE id = ?")
      .get(projectId) as {
      title: string;
      description: string;
      path: ProjectPath | null;
      repo_scan_json: string | null;
    };
    const scan = project.repo_scan_json ? RepoScan.safeParse(JSON.parse(project.repo_scan_json)) : null;
    const path = project.path ?? "full";
    const documents = PATH_DOCUMENTS[path].flatMap((kind) => {
      const doc = latestDocument(this.db, projectId, kind);
      return doc ? [{ kind, markdown: doc.markdown, sections: doc.sections }] : [];
    });
    const createdAt = nowIso();
    const result = buildHandoff({
      language: this.language(),
      projectId,
      createdAt,
      title: project.title,
      description: project.description,
      path,
      decisions: readDecisions(this.db, projectId),
      documents,
      plan,
      target,
      testCommand: scan?.success ? scan.data.testCommand : null,
      agents: this.routing.agentConfigs(),
    });
    transaction(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO handoffs (project_id, task_ids_json, agent, files_json, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          projectId,
          JSON.stringify(result.tasks.map((task) => task.taskId)),
          [...new Set(result.tasks.map((task) => task.agent))].join(","),
          JSON.stringify(result.files.map((file) => file.path)),
          createdAt,
        );
      this.db.prepare("UPDATE projects SET stage = 'handoff', updated_at = ? WHERE id = ?").run(createdAt, projectId);
    });
    return result;
  }
}

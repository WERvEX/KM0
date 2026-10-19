import { breakDown, type DiscussionLlm, type Language, PATH_STAGES, planTotals, routeTask } from "@km0/core";
import {
  AppError,
  type DocumentKind,
  PATH_DOCUMENTS,
  type ProjectPath,
  type ProjectStage,
  type RoutingPlan,
  SectionRef,
  TaskFailure,
  TaskFeatures,
  TaskOverride,
  Triage,
} from "@km0/shared";
import { z } from "zod";
import { type Database, nowIso, transaction } from "../db/sql";
import type { AgentStore } from "./agent-store";
import { latestDocument } from "./document-service";
import { KeyedLock } from "./lock";
import { describeProject, readDecisions } from "./project-service";

interface ProjectRow {
  title: string;
  description: string;
  path: ProjectPath | null;
  stage: ProjectStage;
  triage_json: string | null;
  repo_scan_json: string | null;
}

interface TaskRow {
  id: number;
  seq: number;
  title: string;
  spec_json: string;
  features_json: string;
  depends_on_json: string;
  override_json: string | null;
  failures_json: string;
}

const TaskSpec = z.object({
  goal: z.string(),
  acceptance: z.array(z.string()),
  files: z.array(z.string()),
  decisionKeys: z.array(z.string()),
  sections: z.array(SectionRef),
});
const BasedOn = z.array(z.object({ kind: z.enum(["prd", "tech_design", "brief"]), version: z.number().int() }));
const Seqs = z.array(z.number().int());
const Failures = z.array(TaskFailure);

/**
 * Task breakdown and routing. The planner proposes tasks and describes them; tiers, agents, models
 * and costs are computed by rules each time the plan is read, so changes to the agent catalog, the
 * user's overrides and recorded failures apply at once.
 */
export class RoutingService {
  private readonly locks = new KeyedLock<number>();

  constructor(
    private readonly db: Database,
    private readonly llmFor: (projectId: number) => DiscussionLlm,
    private readonly language: () => Language,
    private readonly agents: AgentStore,
  ) {}

  get(projectId: number): RoutingPlan | null {
    const project = this.project(projectId);
    const plan = this.db.prepare("SELECT * FROM routing_plans WHERE project_id = ?").get(projectId) as
      | { based_on_json: string; created_at: string }
      | undefined;
    if (!plan) return null;
    const agents = this.agents.list();
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY seq")
      .all(projectId) as unknown as TaskRow[];
    const tasks = rows.map((row) => {
      const spec = TaskSpec.parse(JSON.parse(row.spec_json));
      return routeTask(
        {
          id: row.id,
          seq: row.seq,
          title: row.title,
          ...spec,
          dependsOn: Seqs.parse(JSON.parse(row.depends_on_json)),
          features: TaskFeatures.parse(JSON.parse(row.features_json)),
          override: row.override_json ? TaskOverride.parse(JSON.parse(row.override_json)) : null,
          failures: Failures.parse(JSON.parse(row.failures_json)),
        },
        agents,
        this.language(),
      );
    });
    const basedOn = BasedOn.parse(JSON.parse(plan.based_on_json));
    const current = this.documentVersions(projectId, project.path ?? "full");
    const outdated =
      current.length !== basedOn.length ||
      current.some((doc) => basedOn.find((item) => item.kind === doc.kind)?.version !== doc.version);
    return { projectId, createdAt: plan.created_at, tasks, ...planTotals(tasks), basedOn, outdated };
  }

  /** Break the work into tasks with the planner, replacing any earlier plan and its overrides. */
  plan(projectId: number): Promise<RoutingPlan> {
    return this.locks.run(projectId, async () => {
      const project = this.project(projectId);
      const path = project.path ?? "full";
      const discussing = project.stage === "triage" || (PATH_STAGES[path] as string[]).includes(project.stage);
      if (discussing) throw new AppError("conflict", "Finish the discussion before breaking the work into tasks.");
      const documents = PATH_DOCUMENTS[path].map((kind) => ({ kind, doc: latestDocument(this.db, projectId, kind) }));
      if (documents.some((item) => !item.doc)) {
        throw new AppError("conflict", "Write the documents before breaking the work into tasks.");
      }

      const planned = await breakDown(this.llmFor(projectId), {
        language: this.language(),
        path,
        title: project.title,
        description: describeProject(project.description, project.repo_scan_json),
        triage: project.triage_json ? Triage.parse(JSON.parse(project.triage_json)) : null,
        decisions: readDecisions(this.db, projectId),
        documents: documents.map(({ kind, doc }) => ({ kind, sections: doc?.sections ?? [] })),
      });

      transaction(this.db, () => {
        const now = nowIso();
        this.db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
        for (const task of planned) {
          const spec = {
            goal: task.goal,
            acceptance: task.acceptance,
            files: task.files,
            decisionKeys: task.decisionKeys,
            sections: task.sections,
          };
          this.db
            .prepare(
              `INSERT INTO tasks (project_id, doc_version, seq, title, spec_json, features_json, depends_on_json, created_at, updated_at)
               VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              projectId,
              task.seq,
              task.title,
              JSON.stringify(spec),
              JSON.stringify(task.features),
              JSON.stringify(task.dependsOn),
              now,
              now,
            );
        }
        this.db
          .prepare(
            `INSERT INTO routing_plans (project_id, based_on_json, created_at) VALUES (?, ?, ?)
             ON CONFLICT (project_id) DO UPDATE SET based_on_json = excluded.based_on_json, created_at = excluded.created_at`,
          )
          .run(projectId, JSON.stringify(this.documentVersions(projectId, path)), now);
        this.db.prepare("UPDATE projects SET stage = 'routing', updated_at = ? WHERE id = ?").run(now, projectId);
      });
      return this.get(projectId) as RoutingPlan;
    });
  }

  /** Set or clear the user's choice of tier, agent or model for one task. */
  override(projectId: number, taskId: number, override: TaskOverride | null): Promise<RoutingPlan> {
    return this.locks.run(projectId, async () => {
      this.project(projectId);
      const owned = this.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND project_id = ?").get(taskId, projectId);
      if (!owned) throw new AppError("not_found", `Task ${taskId} does not exist.`);
      const empty = !override || Object.values(override).every((value) => value === undefined);
      this.db
        .prepare("UPDATE tasks SET override_json = ?, updated_at = ? WHERE id = ?")
        .run(empty ? null : JSON.stringify(override), nowIso(), taskId);
      return this.get(projectId) as RoutingPlan;
    });
  }

  /** Record one failed run on the tier the task is routed to now; enough of them lift it a tier. */
  recordFailure(projectId: number, taskId: number): Promise<RoutingPlan> {
    return this.locks.run(projectId, async () => {
      const failures = this.failures(projectId, taskId);
      const task = this.get(projectId)?.tasks.find((item) => item.id === taskId);
      if (!task) throw new AppError("not_found", `Task ${taskId} does not exist.`);
      failures.push({ tier: task.tier, at: nowIso() });
      this.saveFailures(taskId, failures);
      return this.get(projectId) as RoutingPlan;
    });
  }

  /** Forget a task's failed runs, which also undoes any lift they caused. */
  clearFailures(projectId: number, taskId: number): Promise<RoutingPlan> {
    return this.locks.run(projectId, async () => {
      this.failures(projectId, taskId);
      this.saveFailures(taskId, []);
      return this.get(projectId) as RoutingPlan;
    });
  }

  private failures(projectId: number, taskId: number): TaskFailure[] {
    this.project(projectId);
    const row = this.db
      .prepare("SELECT failures_json FROM tasks WHERE id = ? AND project_id = ?")
      .get(taskId, projectId) as { failures_json: string } | undefined;
    if (!row) throw new AppError("not_found", `Task ${taskId} does not exist.`);
    return Failures.parse(JSON.parse(row.failures_json));
  }

  private saveFailures(taskId: number, failures: TaskFailure[]): void {
    this.db
      .prepare("UPDATE tasks SET failures_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(failures), nowIso(), taskId);
  }

  private project(projectId: number): ProjectRow {
    const row = this.db
      .prepare("SELECT title, description, path, stage, triage_json, repo_scan_json FROM projects WHERE id = ?")
      .get(projectId) as ProjectRow | undefined;
    if (!row) throw new AppError("not_found", `Project ${projectId} does not exist.`);
    return row;
  }

  private documentVersions(projectId: number, path: ProjectPath): { kind: DocumentKind; version: number }[] {
    return PATH_DOCUMENTS[path].flatMap((kind) => {
      const doc = latestDocument(this.db, projectId, kind);
      return doc ? [{ kind, version: doc.version }] : [];
    });
  }
}

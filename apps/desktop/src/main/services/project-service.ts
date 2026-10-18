import {
  type DecisionDraft,
  type DiscussionLlm,
  dependentsOf,
  fillDecisions,
  keyDef,
  type Language,
  MAX_ROUNDS,
  missingKeys,
  PATH_STAGES,
  planRound,
  type RoundContext,
  recommendedAnswers,
  requiredKeys,
  resolveAnswers,
  reviewKeys,
  triageTask,
} from "@km0/core";
import {
  type Answer,
  AppError,
  type AppErrorShape,
  type Decision,
  type DecisionValue,
  type DiscussionStage,
  type ProjectDetail,
  type ProjectPath,
  type ProjectSummary,
  Question,
  type QuestionRound,
  type StageState,
  type StageStatus,
  Triage,
  toAppError,
} from "@km0/shared";
import { z } from "zod";
import { type Database, nowIso, transaction } from "../db/sql";
import { documentSummaries } from "./document-service";
import { KeyedLock } from "./lock";

interface ProjectRow {
  id: number;
  title: string;
  description: string;
  path: ProjectPath | null;
  stage: ProjectDetail["stage"];
  status: ProjectDetail["status"];
  repo_path: string | null;
  triage_json: string | null;
  created_at: string;
  updated_at: string;
}

interface RoundRow {
  id: number;
  stage: DiscussionStage;
  round_no: number;
  questions_json: string;
  status: QuestionRound["status"];
  review: number;
}

interface DecisionRow {
  key: string;
  stage: DiscussionStage;
  value_json: string;
  source: Decision["source"];
  rationale: string | null;
  alternatives_json: string;
  depends_on_json: string;
  needs_review: number;
  updated_at: string;
}

interface StageRow {
  stage: DiscussionStage;
  status: StageStatus;
  rounds_used: number;
}

const Questions = z.array(Question);
const Strings = z.array(z.string());

/**
 * Runs the discussion: triage, question rounds, the decision ledger and stage transitions.
 * Every mutating call for a project runs under that project's lock, so a double click cannot
 * answer the same round twice or race a stage transition.
 */
export class ProjectService {
  private readonly locks = new KeyedLock<number>();

  /**
   * @param llmFor gives the model port for a project, so calls are logged against it
   *   (null while triaging, before the project exists).
   */
  constructor(
    private readonly db: Database,
    private readonly llmFor: (projectId: number | null) => DiscussionLlm,
    private readonly language: () => Language,
  ) {}

  list(): ProjectSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY updated_at DESC, id DESC")
      .all() as unknown as ProjectRow[];
    return rows.map((row) => this.summary(row));
  }

  get(id: number): ProjectDetail {
    return this.detail(id, null);
  }

  async create(description: string, repoPath: string | null): Promise<ProjectDetail> {
    const triage = await triageTask(this.llmFor(null), description, this.language());
    const path = triage.suggestedPath;
    const id = transaction(this.db, () => {
      const now = nowIso();
      const result = this.db
        .prepare(
          `INSERT INTO projects (title, description, path, stage, status, repo_path, triage_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        )
        .run(
          triage.title,
          description,
          path,
          PATH_STAGES[path][0] as string,
          repoPath,
          JSON.stringify(triage),
          now,
          now,
        );
      const projectId = Number(result.lastInsertRowid);
      this.resetStages(projectId, path);
      return projectId;
    });
    return this.withLock(id, () => this.advanceDiscussion(id));
  }

  rename(id: number, title: string): ProjectSummary {
    this.row(id);
    this.db.prepare("UPDATE projects SET title = ?, updated_at = ? WHERE id = ?").run(title, nowIso(), id);
    return this.summary(this.row(id));
  }

  delete(id: number): void {
    this.row(id);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  /** Switch fast / light / full. Decisions are kept; the new path starts at its first stage. */
  setPath(id: number, path: ProjectPath): Promise<ProjectDetail> {
    return this.withLock(id, async () => {
      const project = this.row(id);
      if (project.path === path) return this.detail(id, null);
      transaction(this.db, () => {
        this.supersedeOpenRound(id);
        this.db.prepare("DELETE FROM stage_states WHERE project_id = ?").run(id);
        this.resetStages(id, path);
        this.db
          .prepare("UPDATE projects SET path = ?, stage = ?, updated_at = ? WHERE id = ?")
          .run(path, PATH_STAGES[path][0] as string, nowIso(), id);
      });
      return this.advanceDiscussion(id);
    });
  }

  answer(projectId: number, roundId: number, answers: Answer[]): Promise<ProjectDetail> {
    return this.withLock(projectId, async () => {
      const round = this.openRoundRow(projectId);
      if (!round || round.id !== roundId) {
        throw new AppError("conflict", "This question round is no longer open. The page has been refreshed.");
      }
      const questions = Questions.parse(JSON.parse(round.questions_json));
      const { decided, delegated } = resolveAnswers(questions, answers);
      transaction(this.db, () => {
        for (const draft of decided) this.upsertDecision(projectId, draft);
        this.db
          .prepare("UPDATE question_rounds SET status = 'answered', answers_json = ?, answered_at = ? WHERE id = ?")
          .run(JSON.stringify(answers), nowIso(), round.id);
      });
      return this.afterRound(projectId, round.stage, delegated, round.review === 1);
    });
  }

  /** Close the current stage and open the next. Optionally take the recommended answers for what is left. */
  advance(projectId: number, adoptRecommended: boolean): Promise<ProjectDetail> {
    return this.withLock(projectId, async () => {
      const project = this.row(projectId);
      const stage = this.currentDiscussionStage(project);
      const open = this.openRoundRow(projectId);
      if (open && adoptRecommended) {
        const questions = Questions.parse(JSON.parse(open.questions_json));
        const { decided, delegated } = resolveAnswers(questions, recommendedAnswers(questions));
        transaction(this.db, () => {
          for (const draft of decided) this.upsertDecision(projectId, draft);
          this.db
            .prepare("UPDATE question_rounds SET status = 'answered', answers_json = ?, answered_at = ? WHERE id = ?")
            .run(JSON.stringify(recommendedAnswers(questions)), nowIso(), open.id);
        });
        await this.fill(projectId, open.stage, delegated);
      }
      const missing = missingKeys(stage, this.decisions(projectId));
      if (missing.length > 0) {
        if (!adoptRecommended) {
          throw new AppError("conflict", "Some required questions in this stage are still unanswered.");
        }
        await this.fill(projectId, stage, missing);
      }
      transaction(this.db, () => {
        this.supersedeOpenRound(projectId);
        this.setStageStatus(projectId, stage, "complete");
        const stages = PATH_STAGES[project.path ?? "full"];
        const next = stages[stages.indexOf(stage) + 1];
        if (next) {
          this.setStageStatus(projectId, next, "active");
          this.setProjectStage(projectId, next);
        } else {
          // The fast path writes no documents and goes straight to task routing.
          this.setProjectStage(projectId, project.path === "fast" ? "routing" : "documents");
        }
      });
      return this.advanceDiscussion(projectId);
    });
  }

  /** Ask optional follow-up questions in a stage whose required decisions are made. */
  askMore(projectId: number): Promise<ProjectDetail> {
    return this.withLock(projectId, async () => {
      const project = this.row(projectId);
      const stage = this.currentDiscussionStage(project);
      const state = this.stageRow(projectId, stage);
      if (this.openRoundRow(projectId)) throw new AppError("conflict", "Answer the open questions first.");
      if (state.rounds_used >= MAX_ROUNDS[stage]) {
        throw new AppError("conflict", "This stage has used all of its question rounds.");
      }
      return this.openRound(projectId, stage, "more");
    });
  }

  /**
   * Re-check decisions flagged after something they depend on changed. An unanswered round of the
   * current stage is set aside (and its round refunded); it is asked again after the review.
   */
  review(projectId: number, stage: DiscussionStage): Promise<ProjectDetail> {
    return this.withLock(projectId, async () => {
      this.row(projectId);
      if (reviewKeys(stage, this.decisions(projectId)).length === 0) return this.detail(projectId, null);
      const open = this.openRoundRow(projectId);
      if (open?.review === 1) throw new AppError("conflict", "Answer the open review questions first.");
      if (open) {
        transaction(this.db, () => {
          this.supersedeOpenRound(projectId);
          this.db
            .prepare("UPDATE stage_states SET rounds_used = MAX(rounds_used - 1, 0) WHERE project_id = ? AND stage = ?")
            .run(projectId, open.stage);
        });
      }
      return this.openRound(projectId, stage, "review");
    });
  }

  /** Generate the next round again after a failure. */
  retry(projectId: number): Promise<ProjectDetail> {
    return this.withLock(projectId, () => this.advanceDiscussion(projectId));
  }

  updateDecision(projectId: number, key: string, value: DecisionValue): Promise<ProjectDetail> {
    return this.withLock(projectId, async () => {
      const project = this.row(projectId);
      const def = keyDef(key);
      if (!def) throw new AppError("validation", `Unknown decision: ${key}`);
      transaction(this.db, () => {
        this.upsertDecision(projectId, { key, value, source: "user", rationale: null, alternatives: [] });
        // A ready stage may become incomplete again, and an active one may become ready.
        const stage = this.currentDiscussionStage(project, false);
        if (stage) this.refreshStageStatus(projectId, stage);
      });
      return this.detail(projectId, null);
    });
  }

  // --- discussion flow -------------------------------------------------------------------

  /** Open the next round for the current stage when one is needed. Errors are returned, not thrown. */
  private async advanceDiscussion(projectId: number): Promise<ProjectDetail> {
    const project = this.row(projectId);
    const stage = this.currentDiscussionStage(project, false);
    if (!stage || this.openRoundRow(projectId)) return this.detail(projectId, null);
    try {
      return await this.continueStage(projectId, stage);
    } catch (error) {
      return this.detail(projectId, toAppError(error).toShape());
    }
  }

  private async afterRound(
    projectId: number,
    stage: DiscussionStage,
    delegated: string[],
    wasReview: boolean,
  ): Promise<ProjectDetail> {
    try {
      await this.fill(projectId, stage, delegated);
      // A review can flag more keys than fit in one round; keep going until the stage is clear.
      if (wasReview && reviewKeys(stage, this.decisions(projectId)).length > 0) {
        return await this.openRound(projectId, stage, "review");
      }
      const current = this.currentDiscussionStage(this.row(projectId), false);
      // After a review of an earlier stage, pick the current stage up where it was.
      if (!current) return this.detail(projectId, null);
      return await this.continueStage(projectId, current);
    } catch (error) {
      return this.detail(projectId, toAppError(error).toShape());
    }
  }

  /** Ask the next round, or mark the stage ready when its required decisions are made. */
  private async continueStage(projectId: number, stage: DiscussionStage): Promise<ProjectDetail> {
    if (missingKeys(stage, this.decisions(projectId)).length === 0) {
      this.setStageStatus(projectId, stage, "ready");
      return this.detail(projectId, null);
    }
    if (this.stageRow(projectId, stage).rounds_used >= MAX_ROUNDS[stage]) {
      // Out of rounds: decide what is left so the stage can close.
      await this.fill(projectId, stage, missingKeys(stage, this.decisions(projectId)));
      this.setStageStatus(projectId, stage, "ready");
      return this.detail(projectId, null);
    }
    return this.openRound(projectId, stage, "required");
  }

  private async openRound(
    projectId: number,
    stage: DiscussionStage,
    mode: RoundContext["mode"],
  ): Promise<ProjectDetail> {
    const plan = await planRound(this.llmFor(projectId), {
      ...this.context(projectId, stage),
      roundNo: this.nextRoundNo(projectId, stage),
      mode,
    });
    transaction(this.db, () => {
      for (const draft of plan.inferred) this.upsertDecision(projectId, draft);
      if (plan.questions.length > 0) {
        this.db
          .prepare(
            `INSERT INTO question_rounds (project_id, stage, round_no, questions_json, status, created_at, review)
             VALUES (?, ?, ?, ?, 'open', ?, ?)`,
          )
          .run(
            projectId,
            stage,
            this.nextRoundNo(projectId, stage),
            JSON.stringify(plan.questions),
            nowIso(),
            mode === "review" ? 1 : 0,
          );
        if (mode !== "review") {
          this.db
            .prepare("UPDATE stage_states SET rounds_used = rounds_used + 1 WHERE project_id = ? AND stage = ?")
            .run(projectId, stage);
          this.setStageStatus(projectId, stage, "active");
        }
      }
    });
    if (plan.questions.length === 0 && mode !== "review") {
      const missing = missingKeys(stage, this.decisions(projectId));
      // The model found nothing worth asking; decide whatever is still required.
      if (missing.length > 0) await this.fill(projectId, stage, missing);
      this.setStageStatus(projectId, stage, "ready");
    }
    return this.detail(projectId, null);
  }

  private async fill(projectId: number, stage: DiscussionStage, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const drafts = await fillDecisions(this.llmFor(projectId), this.context(projectId, stage), keys);
    transaction(this.db, () => {
      for (const draft of drafts) this.upsertDecision(projectId, draft);
    });
  }

  private context(projectId: number, stage: DiscussionStage): Omit<RoundContext, "roundNo" | "mode"> {
    const project = this.row(projectId);
    return {
      language: this.language(),
      path: project.path ?? "full",
      stage,
      description: project.description,
      triage: project.triage_json ? Triage.parse(JSON.parse(project.triage_json)) : null,
      decisions: this.decisions(projectId),
    };
  }

  // --- persistence ---------------------------------------------------------------------------

  private withLock<T>(projectId: number, work: () => Promise<T>): Promise<T> {
    return this.locks.run(projectId, work);
  }

  private row(id: number): ProjectRow {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    if (!row) throw new AppError("not_found", `Project ${id} does not exist.`);
    return row;
  }

  private summary(row: ProjectRow): ProjectSummary {
    return {
      id: row.id,
      title: row.title,
      path: row.path,
      stage: row.stage,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private currentDiscussionStage(project: ProjectRow): DiscussionStage;
  private currentDiscussionStage(project: ProjectRow, strict: false): DiscussionStage | null;
  private currentDiscussionStage(project: ProjectRow, strict = true): DiscussionStage | null {
    const stages: string[] = PATH_STAGES[project.path ?? "full"];
    if (stages.includes(project.stage)) return project.stage as DiscussionStage;
    if (strict) throw new AppError("conflict", "The discussion for this project is already complete.");
    return null;
  }

  private resetStages(projectId: number, path: ProjectPath): void {
    PATH_STAGES[path].forEach((stage, index) => {
      this.db
        .prepare(
          `INSERT INTO stage_states (project_id, stage, status, rounds_used) VALUES (?, ?, ?, 0)
           ON CONFLICT (project_id, stage) DO UPDATE SET status = excluded.status, rounds_used = 0`,
        )
        .run(projectId, stage, index === 0 ? "active" : "pending");
    });
  }

  private stageRow(projectId: number, stage: DiscussionStage): StageRow {
    const row = this.db
      .prepare("SELECT stage, status, rounds_used FROM stage_states WHERE project_id = ? AND stage = ?")
      .get(projectId, stage) as StageRow | undefined;
    if (!row) throw new AppError("conflict", `Stage ${stage} is not part of this project's path.`);
    return row;
  }

  private setStageStatus(projectId: number, stage: DiscussionStage, status: StageStatus): void {
    this.db
      .prepare("UPDATE stage_states SET status = ? WHERE project_id = ? AND stage = ?")
      .run(status, projectId, stage);
    this.touch(projectId);
  }

  private refreshStageStatus(projectId: number, stage: DiscussionStage): void {
    const state = this.stageRow(projectId, stage);
    if (state.status !== "active" && state.status !== "ready") return;
    const missing = missingKeys(stage, this.decisions(projectId));
    const open = this.openRoundRow(projectId);
    this.setStageStatus(projectId, stage, missing.length === 0 && !open ? "ready" : "active");
  }

  private setProjectStage(projectId: number, stage: ProjectDetail["stage"]): void {
    this.db.prepare("UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?").run(stage, nowIso(), projectId);
  }

  private touch(projectId: number): void {
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(nowIso(), projectId);
  }

  private openRoundRow(projectId: number): RoundRow | undefined {
    return this.db
      .prepare("SELECT * FROM question_rounds WHERE project_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
      .get(projectId) as RoundRow | undefined;
  }

  private supersedeOpenRound(projectId: number): void {
    this.db
      .prepare("UPDATE question_rounds SET status = 'superseded' WHERE project_id = ? AND status = 'open'")
      .run(projectId);
  }

  private nextRoundNo(projectId: number, stage: DiscussionStage): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(round_no), 0) AS n FROM question_rounds WHERE project_id = ? AND stage = ?")
      .get(projectId, stage) as { n: number };
    return row.n + 1;
  }

  private decisions(projectId: number): Decision[] {
    return readDecisions(this.db, projectId);
  }

  /** Write a decision; when an existing value changes, flag the decisions that depend on it. */
  private upsertDecision(projectId: number, draft: DecisionDraft): void {
    const def = keyDef(draft.key);
    if (!def) return;
    const existing = this.db
      .prepare("SELECT value_json FROM decisions WHERE project_id = ? AND key = ?")
      .get(projectId, draft.key) as { value_json: string } | undefined;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO decisions (project_id, key, value_json, stage, source, rationale, alternatives_json, depends_on_json, needs_review, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (project_id, key) DO UPDATE SET value_json = excluded.value_json, source = excluded.source,
           rationale = excluded.rationale, alternatives_json = excluded.alternatives_json, needs_review = 0,
           updated_at = excluded.updated_at`,
      )
      .run(
        projectId,
        draft.key,
        JSON.stringify(draft.value),
        def.stage,
        draft.source,
        draft.rationale,
        JSON.stringify(draft.alternatives),
        JSON.stringify(def.dependsOn),
        now,
      );
    const changed = existing && (JSON.parse(existing.value_json) as DecisionValue).text !== draft.value.text;
    if (changed) {
      const dependents = dependentsOf(draft.key);
      if (dependents.length > 0) {
        const placeholders = dependents.map(() => "?").join(", ");
        this.db
          .prepare(`UPDATE decisions SET needs_review = 1 WHERE project_id = ? AND key IN (${placeholders})`)
          .run(projectId, ...dependents);
      }
    }
    this.touch(projectId);
  }

  private detail(id: number, error: AppErrorShape | null): ProjectDetail {
    const row = this.row(id);
    const path = row.path ?? "full";
    const pathStages = PATH_STAGES[path];
    const allDecisions = this.decisions(id);
    const decisions = allDecisions.filter((decision) => pathStages.includes(decision.stage));
    const stageRows = this.db
      .prepare("SELECT stage, status, rounds_used FROM stage_states WHERE project_id = ?")
      .all(id) as unknown as StageRow[];
    const stages: StageState[] = pathStages.map((stage) => {
      const state = stageRows.find((item) => item.stage === stage);
      return {
        stage,
        status: state?.status ?? "pending",
        roundsUsed: state?.rounds_used ?? 0,
        maxRounds: MAX_ROUNDS[stage],
        requiredKeys: requiredKeys(stage),
        missingKeys: missingKeys(stage, decisions),
        reviewKeys: reviewKeys(stage, decisions),
      };
    });
    const open = this.openRoundRow(id);
    return {
      ...this.summary(row),
      description: row.description,
      repoPath: row.repo_path,
      triage: row.triage_json ? Triage.parse(JSON.parse(row.triage_json)) : null,
      stages,
      decisions,
      openRound: open
        ? {
            id: open.id,
            stage: open.stage,
            roundNo: open.round_no,
            questions: Questions.parse(JSON.parse(open.questions_json)),
            status: open.status,
            review: open.review === 1,
          }
        : null,
      discussionComplete: stages.every((stage) => stage.status === "complete"),
      documents: documentSummaries(this.db, id, path, allDecisions),
      error,
    };
  }
}

/** The project's decision ledger, oldest first. */
export function readDecisions(db: Database, projectId: number): Decision[] {
  const rows = db
    .prepare("SELECT * FROM decisions WHERE project_id = ? ORDER BY id")
    .all(projectId) as unknown as DecisionRow[];
  return rows.map((row) => ({
    key: row.key,
    stage: row.stage,
    value: JSON.parse(row.value_json) as DecisionValue,
    source: row.source,
    rationale: row.rationale,
    alternatives: Strings.parse(JSON.parse(row.alternatives_json)),
    dependsOn: Strings.parse(JSON.parse(row.depends_on_json)),
    needsReview: row.needs_review === 1,
    updatedAt: row.updated_at,
  }));
}

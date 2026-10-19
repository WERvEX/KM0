import { type DiscussionLlm, judgeTask, type Language } from "@km0/core";
import { AppError, RunnerReport, type RunnerRun, type RunnerTaskResult, RunnerVerdict, Tier } from "@km0/shared";
import { type Database, nowIso, transaction } from "../db/sql";
import { KeyedLock } from "./lock";
import type { RoutingService } from "./routing-service";
import type { RunAccess, RunFs } from "./run-access";

const MAX_REPORT_BYTES = 4_000_000;
const MAX_DIFF_BYTES = 2_000_000;
const ACCEPTANCE_FILE = "acceptance.jsonl";

interface RunRow {
  id: number;
  project_id: number;
  run_id: string;
  path: string;
  imported_at: string;
  write_back_pending: number;
}

interface ResultRow {
  id: number;
  seq: number;
  report_json: string;
  diff: string | null;
  verdict_json: string | null;
}

/**
 * KM0's side of KM0 Runner: import a run's reports, judge each change against its task's acceptance
 * criteria, and write the verdicts back as `acceptance.jsonl`, which the Runner's calibration learns from.
 * A rejection is also recorded on the task, so its next hand-off starts one tier higher.
 */
export class RunnerService {
  private readonly locks = new KeyedLock<number>();

  constructor(
    private readonly db: Database,
    private readonly access: RunAccess,
    private readonly routing: RoutingService,
    private readonly llmFor: (projectId: number) => DiscussionLlm,
    private readonly language: () => Language,
    /** The model that judges, as recorded in each verdict. */
    private readonly judgedBy: () => string,
  ) {}

  list(projectId: number): RunnerRun[] {
    this.project(projectId);
    const rows = this.db
      .prepare("SELECT * FROM runner_runs WHERE project_id = ? ORDER BY imported_at DESC, id DESC")
      .all(projectId) as unknown as RunRow[];
    return rows.map((row) => this.read(row));
  }

  /** Pick a run directory and read its reports; importing the same run again refreshes it and keeps its verdicts. */
  import(projectId: number): Promise<RunnerRun | null> {
    return this.locks.run(projectId, async () => {
      this.project(projectId);
      const path = await this.access.pick();
      if (!path) return null;
      const fs = await this.access.open(path);
      const { runId, reports } = await readReports(fs, projectId);
      const verdicts = await readVerdicts(fs);
      const diffs = new Map<number, string | null>();
      for (const { seq, report } of reports) {
        diffs.set(seq, report.diff ? await fs.read(report.diff, MAX_DIFF_BYTES) : null);
      }
      const ref = transaction(this.db, () => {
        const now = nowIso();
        this.db
          .prepare(
            `INSERT INTO runner_runs (project_id, run_id, path, imported_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (project_id, run_id) DO UPDATE SET path = excluded.path, imported_at = excluded.imported_at`,
          )
          .run(projectId, runId, path, now);
        const run = this.db
          .prepare("SELECT id FROM runner_runs WHERE project_id = ? AND run_id = ?")
          .get(projectId, runId) as { id: number };
        for (const { seq, report } of reports) {
          const verdict = verdicts.get(report.task_id);
          this.db
            .prepare(
              `INSERT INTO runner_results (run_ref, seq, report_json, diff, verdict_json) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (run_ref, seq) DO UPDATE SET report_json = excluded.report_json, diff = excluded.diff,
                 verdict_json = COALESCE(runner_results.verdict_json, excluded.verdict_json)`,
            )
            .run(run.id, seq, JSON.stringify(report), diffs.get(seq) ?? null, verdict ? JSON.stringify(verdict) : null);
        }
        return run.id;
      });
      return this.read(this.run(projectId, ref));
    });
  }

  /** Judge every task of the run that has a report and no verdict yet, one after another. */
  judge(projectId: number, runRef: number): Promise<RunnerRun> {
    return this.locks.run(projectId, async () => {
      const run = this.run(projectId, runRef);
      const plan = this.routing.get(projectId);
      const llm = this.llmFor(projectId);
      for (const row of this.results(run.id)) {
        if (row.verdict_json) continue;
        const report = RunnerReport.parse(JSON.parse(row.report_json));
        // A blocked task never ran: there is nothing to judge until its upstream tasks pass.
        if (report.failure_category === "blocked") continue;
        const task = plan?.tasks.find((item) => item.seq === row.seq);
        const output = await judgeTask(llm, {
          language: this.language(),
          title: task?.title ?? report.title,
          goal: task?.goal ?? report.title,
          acceptance: task?.acceptance ?? report.acceptance,
          diff: row.diff,
          testCommand: report.test_command ?? null,
          testResult: report.test_result,
          failure: report.failure_category
            ? `${report.failure_category}${report.failure_detail ? `: ${report.failure_detail}` : ""}`
            : null,
        });
        const verdict: RunnerVerdict = {
          run_id: run.run_id,
          task_id: report.task_id,
          accepted: output.accepted,
          reason: output.reason,
          judged_by: this.judgedBy(),
          user_override: null,
          judged_at: nowIso(),
        };
        this.saveVerdict(row.id, verdict);
        await this.routing.setRunnerRejection(
          projectId,
          row.seq,
          verdict.judged_at,
          verdict.accepted ? null : { tier: finishedTier(report), reason: verdict.reason },
        );
      }
      await this.tryWriteBack(run);
      return this.read(this.run(projectId, runRef));
    });
  }

  /** The user's spot check: overrule KM0's verdict on one task, or drop the override with null. */
  override(projectId: number, resultId: number, accepted: boolean | null): Promise<RunnerRun> {
    return this.locks.run(projectId, async () => {
      const row = this.db
        .prepare(
          `SELECT r.id, r.seq, r.report_json, r.verdict_json, r.run_ref FROM runner_results r
           JOIN runner_runs u ON u.id = r.run_ref WHERE r.id = ? AND u.project_id = ?`,
        )
        .get(resultId, projectId) as (ResultRow & { run_ref: number }) | undefined;
      if (!row) throw new AppError("not_found", `Result ${resultId} does not exist.`);
      if (!row.verdict_json) throw new AppError("conflict", "Judge the run before overruling a verdict.");
      const verdict = { ...RunnerVerdict.parse(JSON.parse(row.verdict_json)), user_override: accepted };
      this.saveVerdict(row.id, verdict);
      const report = RunnerReport.parse(JSON.parse(row.report_json));
      const final = verdict.user_override ?? verdict.accepted;
      await this.routing.setRunnerRejection(
        projectId,
        row.seq,
        verdict.judged_at,
        final ? null : { tier: finishedTier(report), reason: verdict.reason },
      );
      const run = this.run(projectId, row.run_ref);
      await this.tryWriteBack(run);
      return this.read(this.run(projectId, row.run_ref));
    });
  }

  /** Write acceptance.jsonl again; when the folder can no longer be opened, ask for it and check it is the same run. */
  writeBack(projectId: number, runRef: number): Promise<RunnerRun> {
    return this.locks.run(projectId, async () => {
      const run = this.run(projectId, runRef);
      let fs = await this.access.open(run.path).catch(() => null);
      if (!fs) {
        const path = await this.access.pick();
        if (!path) return this.read(run);
        fs = await this.access.open(path);
        const { runId } = await readReports(fs, projectId);
        if (runId !== run.run_id) {
          throw new AppError("validation", `That folder holds run ${runId}, not ${run.run_id}.`);
        }
        this.db.prepare("UPDATE runner_runs SET path = ? WHERE id = ?").run(path, run.id);
      }
      await fs.write(ACCEPTANCE_FILE, this.acceptanceFile(run.id));
      this.db.prepare("UPDATE runner_runs SET write_back_pending = 0 WHERE id = ?").run(run.id);
      return this.read(this.run(projectId, runRef));
    });
  }

  private async tryWriteBack(run: RunRow): Promise<void> {
    let pending = 0;
    try {
      const fs = await this.access.open(run.path);
      await fs.write(ACCEPTANCE_FILE, this.acceptanceFile(run.id));
    } catch {
      pending = 1;
    }
    this.db.prepare("UPDATE runner_runs SET write_back_pending = ? WHERE id = ?").run(pending, run.id);
  }

  private acceptanceFile(runRef: number): string {
    return this.results(runRef)
      .flatMap((row) =>
        row.verdict_json ? [`${JSON.stringify(RunnerVerdict.parse(JSON.parse(row.verdict_json)))}\n`] : [],
      )
      .join("");
  }

  private saveVerdict(resultId: number, verdict: RunnerVerdict): void {
    this.db.prepare("UPDATE runner_results SET verdict_json = ? WHERE id = ?").run(JSON.stringify(verdict), resultId);
  }

  private read(row: RunRow): RunnerRun {
    const results: RunnerTaskResult[] = this.results(row.id).map((result) => {
      const report = RunnerReport.parse(JSON.parse(result.report_json));
      const verdict = result.verdict_json ? RunnerVerdict.parse(JSON.parse(result.verdict_json)) : null;
      return {
        id: result.id,
        seq: result.seq,
        title: report.title,
        tier: finishedTier(report),
        report,
        diffStat: diffStat(result.diff),
        verdict,
        accepted: verdict ? (verdict.user_override ?? verdict.accepted) : null,
      };
    });
    return {
      id: row.id,
      projectId: row.project_id,
      runId: row.run_id,
      path: row.path,
      importedAt: row.imported_at,
      cost: results.reduce((sum, result) => sum + result.report.cost, 0),
      results,
      writeBackPending: row.write_back_pending === 1,
    };
  }

  private results(runRef: number): ResultRow[] {
    return this.db
      .prepare("SELECT id, seq, report_json, diff, verdict_json FROM runner_results WHERE run_ref = ? ORDER BY seq")
      .all(runRef) as unknown as ResultRow[];
  }

  private run(projectId: number, runRef: number): RunRow {
    const row = this.db.prepare("SELECT * FROM runner_runs WHERE id = ? AND project_id = ?").get(runRef, projectId) as
      | RunRow
      | undefined;
    if (!row) throw new AppError("not_found", `Run ${runRef} does not exist.`);
    return row;
  }

  private project(projectId: number): void {
    if (!this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new AppError("not_found", `Project ${projectId} does not exist.`);
    }
  }
}

async function readReports(
  fs: RunFs,
  projectId: number,
): Promise<{ runId: string; reports: { seq: number; report: RunnerReport }[] }> {
  const names = (await fs.list("reports")).filter((name) => name.endsWith(".json")).sort();
  const reports: { seq: number; report: RunnerReport }[] = [];
  for (const name of names) {
    const text = await fs.read(`reports/${name}`, MAX_REPORT_BYTES);
    const parsed = text ? RunnerReport.safeParse(safeJson(text)) : null;
    if (!parsed?.success) throw new AppError("validation", `reports/${name} is not a KM0 Runner report (version 2).`);
    const seq = Number.parseInt(parsed.data.task_id, 10);
    // SWE-bench instances and other non-KM0 tasks have no seq; they are not KM0's to judge.
    if (Number.isInteger(seq)) reports.push({ seq, report: parsed.data });
  }
  if (reports.length === 0) {
    throw new AppError("validation", "No KM0 task reports in this folder. Choose a run folder, runs/<run_id>.");
  }
  const runIds = new Set(reports.map(({ report }) => report.run_id));
  if (runIds.size > 1) throw new AppError("validation", "The reports in this folder come from different runs.");
  const owner = reports[0]?.report.project_id;
  if (owner !== null && owner !== undefined && String(owner) !== String(projectId)) {
    throw new AppError("validation", `This run was handed off from project ${owner}, not this one.`);
  }
  return { runId: [...runIds][0] as string, reports };
}

async function readVerdicts(fs: RunFs): Promise<Map<string, RunnerVerdict>> {
  const verdicts = new Map<string, RunnerVerdict>();
  const text = await fs.read(ACCEPTANCE_FILE, MAX_REPORT_BYTES);
  for (const line of text?.split("\n") ?? []) {
    const parsed = RunnerVerdict.safeParse(safeJson(line));
    if (parsed.success) verdicts.set(parsed.data.task_id, parsed.data);
  }
  return verdicts;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The KM0 tier the Runner finished the task on: its last attempt's rung, when that is a KM0 tier; null when it never ran. */
function finishedTier(report: RunnerReport): Tier | null {
  const parsed = Tier.safeParse(report.attempts.at(-1)?.tier ?? report.solved_tier);
  return parsed.success ? parsed.data : null;
}

function diffStat(diff: string | null): RunnerTaskResult["diffStat"] {
  const stat = { files: 0, added: 0, removed: 0 };
  for (const line of diff?.split("\n") ?? []) {
    if (line.startsWith("diff --git ")) stat.files += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) stat.added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) stat.removed += 1;
  }
  return stat;
}

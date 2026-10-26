import type { RunRecord } from "@km0/core";
import type { AbilityKind, AgentId, DifficultyBand } from "@km0/shared";
import { type Database, nowIso, transaction } from "../db/sql";

interface RecordRow {
  model_key: string;
  agent_id: string;
  native: number;
  kind: AbilityKind;
  band: DifficultyBand["id"];
  passed: number;
  weight: number;
}

export interface NewRecord extends RunRecord {
  /** user: recorded by hand; acceptance: KM0's (or the user's) verdict on KM0 Runner's work. */
  source: "user" | "acceptance";
  projectId: number | null;
  taskId: number | null;
  /** Groups records that are replaced together, such as every attempt behind one Runner verdict. */
  ref: string | null;
}

/** This install's records of runs, which correct the registry's abilities. They never leave the device. */
export class RunRecordStore {
  constructor(private readonly db: Database) {}

  all(): RunRecord[] {
    const rows = this.db
      .prepare("SELECT model_key, agent_id, native, kind, band, passed, weight FROM run_records")
      .all() as unknown as RecordRow[];
    return rows.map((row) => ({
      modelKey: row.model_key,
      agent: row.agent_id as AgentId,
      native: row.native === 1,
      kind: row.kind,
      band: row.band,
      passed: row.passed === 1,
      weight: row.weight,
    }));
  }

  add(record: NewRecord): void {
    this.db
      .prepare(
        `INSERT INTO run_records (model_key, agent_id, native, kind, band, passed, weight, source, project_id, task_id,
           ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.modelKey,
        record.agent,
        record.native ? 1 : 0,
        record.kind,
        record.band,
        record.passed ? 1 : 0,
        record.weight,
        record.source,
        record.projectId,
        record.taskId,
        record.ref,
        nowIso(),
      );
  }

  /** Put these records in place of any with the same ref. */
  replace(ref: string, records: NewRecord[]): void {
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM run_records WHERE ref = ?").run(ref);
      for (const record of records) this.add({ ...record, ref });
    });
  }

  /** Forget what was recorded by hand for one task. */
  clearTask(projectId: number, taskId: number): void {
    this.db
      .prepare("DELETE FROM run_records WHERE source = 'user' AND project_id = ? AND task_id = ?")
      .run(projectId, taskId);
  }

  clearModel(modelKey: string): void {
    this.db.prepare("DELETE FROM run_records WHERE model_key = ?").run(modelKey);
  }
}

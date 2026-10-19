import { createSimulatedLlm } from "@km0/core";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database";
import { AgentStore } from "./agent-store";
import { DocumentService } from "./document-service";
import { HandoffService } from "./handoff-service";
import { ProjectService } from "./project-service";
import { RoutingService } from "./routing-service";
import type { RunAccess } from "./run-access";
import { RunnerService } from "./runner-service";

/** A run folder in memory; `gone` makes it unreachable, like a web folder after a reload. */
function memoryRun(files: Record<string, string>) {
  const state = { gone: false, picks: ["/runs/r1"] as (string | null)[] };
  const access: RunAccess = {
    pick: async () => state.picks.shift() ?? null,
    open: async () => {
      if (state.gone) throw new Error("gone");
      return {
        list: async (dir) =>
          Object.keys(files)
            .filter((path) => path.startsWith(`${dir}/`))
            .map((path) => path.slice(dir.length + 1)),
        read: async (file) => files[file] ?? null,
        write: async (file, content) => {
          files[file] = content;
        },
      };
    },
  };
  return { access, files, state };
}

function report(projectId: number, seq: number, overrides: Record<string, unknown> = {}) {
  const taskId = String(seq).padStart(2, "0");
  return JSON.stringify({
    report_version: 2,
    run_id: "r1",
    project_id: projectId,
    task_id: taskId,
    title: `task ${seq}`,
    predicted_tier: "T1",
    start_tier: "T1",
    solved_tier: "T1",
    escalations: [],
    cost: 0.25,
    steps: 4,
    test_command: "pytest -q",
    test_result: { passed: true, judge: "test_command", detail: "1 passed" },
    failure_category: null,
    branch: `km0/r1/${taskId}`,
    commit: "abc",
    diff: `diffs/${taskId}.diff`,
    acceptance: [],
    attempts: [{ tier: "T1", model: "relay/cheap", cost: 0.25 }],
    ...overrides,
  });
}

const DIFF = "diff --git a/calc.py b/calc.py\n--- a/calc.py\n+++ b/calc.py\n-    return a - b\n+    return a + b\n";

async function setup() {
  const db = openDatabase(":memory:");
  const llm = createSimulatedLlm();
  const language = () => "zh-CN" as const;
  const routing = new RoutingService(db, () => llm, language, new AgentStore(db));
  const projects = new ProjectService(db, () => llm, language);
  const documents = new DocumentService(
    db,
    () => llm,
    language,
    () => undefined,
  );
  let project = await projects.create("给现有的博客加上评论功能", null);
  project = await projects.advance(project.id, true);
  await documents.generate(project.id, "brief", false);
  await routing.plan(project.id);
  const run = memoryRun({
    "reports/01.json": report(project.id, 1),
    "diffs/01.diff": DIFF,
    // T1 failed its tests and the Runner moved the task to T2, where the tests still failed.
    "reports/02.json": report(project.id, 2, {
      solved_tier: null,
      test_result: { passed: false, judge: "test_command", detail: "1 failed" },
      failure_category: "tests_failed",
      attempts: [
        { tier: "T1", model: "relay/cheap", cost: 0.1 },
        { tier: "T2", model: "relay/mid", cost: 0.3 },
      ],
    }),
    "diffs/02.diff": DIFF,
    "reports/03.json": report(project.id, 3, {
      failure_category: "blocked",
      solved_tier: null,
      diff: null,
      attempts: [],
    }),
  });
  const runner = new RunnerService(
    db,
    run.access,
    routing,
    () => llm,
    language,
    () => "simulated",
  );
  return { db, project, routing, runner, run, handoff: new HandoffService(db, routing, language) };
}

describe("KM0 Runner runs", () => {
  it("imports a run's reports with their diffs", async () => {
    const { project, runner } = await setup();
    const run = await runner.import(project.id);
    expect(run).toMatchObject({ runId: "r1", path: "/runs/r1", cost: 0.75, writeBackPending: false });
    expect(run?.results.map((result) => [result.seq, result.tier, result.accepted])).toEqual([
      [1, "T1", null],
      [2, "T2", null],
      [3, null, null],
    ]);
    expect(run?.results[0]?.diffStat).toEqual({ files: 1, added: 1, removed: 1 });
    expect(runner.list(project.id)).toHaveLength(1);
  });

  it("refuses a run handed off from another project", async () => {
    const { project, runner, run } = await setup();
    run.files["reports/01.json"] = report(project.id + 1, 1);
    await expect(runner.import(project.id)).rejects.toMatchObject({ kind: "validation" });
  });

  it("judges each task, writes acceptance.jsonl and sends a rejected task one tier up", async () => {
    const { project, routing, runner, run, handoff } = await setup();
    const imported = await runner.import(project.id);
    if (!imported) throw new Error("not imported");
    const judged = await runner.judge(project.id, imported.id);
    expect(judged.results.map((result) => result.accepted)).toEqual([true, false, null]);
    const lines = (run.files["acceptance.jsonl"] ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => [line.run_id, line.task_id, line.accepted, line.judged_by])).toEqual([
      ["r1", "01", true, "simulated"],
      ["r1", "02", false, "simulated"],
    ]);

    // Rejected after the Runner finished on T2: the next hand-off starts on T3 and says why.
    const task = routing.get(project.id)?.tasks.find((item) => item.seq === 2);
    expect(task?.tier).toBe("T3");
    expect(task?.failures).toMatchObject([{ tier: "T2", source: "runner" }]);
    const prompt = handoff.build(project.id, "runner").tasks.find((item) => item.seq === 2)?.prompt ?? "";
    expect(prompt).toContain("没有通过验收");
    expect(prompt).not.toContain("## 失败升级");

    // Judging again leaves verdicts alone; a spot check overrules one and undoes its lift.
    await runner.judge(project.id, imported.id);
    const overruled = await runner.override(project.id, judged.results[1]?.id ?? 0, true);
    expect(overruled.results[1]).toMatchObject({ accepted: true, verdict: { accepted: false, user_override: true } });
    expect(routing.get(project.id)?.tasks.find((item) => item.seq === 2)?.failures).toEqual([]);
    expect(run.files["acceptance.jsonl"]).toContain('"user_override":true');
  });

  it("keeps verdicts when the folder is gone and writes them once it is chosen again", async () => {
    const { project, runner, run } = await setup();
    const imported = await runner.import(project.id);
    if (!imported) throw new Error("not imported");
    run.state.gone = true;
    expect((await runner.judge(project.id, imported.id)).writeBackPending).toBe(true);
    expect(run.files["acceptance.jsonl"]).toBeUndefined();
    run.state.gone = false;
    run.state.picks.push("/runs/r1");
    const written = await runner.writeBack(project.id, imported.id);
    expect(written.writeBackPending).toBe(false);
    expect(run.files["acceptance.jsonl"]?.trim().split("\n")).toHaveLength(2);
  });
});

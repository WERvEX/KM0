#!/usr/bin/env node
// A stand-in for `km0-runner` that speaks the same protocol KM0 relies on, without pi or a model:
// `--version`; `run <package> --repo R -c CONFIG --runs DIR --run-id ID [--tasks N...] [--reuse ID]`, which
// writes progress.jsonl, one report and diff per task and summary.json, stops on SIGTERM or a STOP file
// (exit 3), and exits 0 when every task passed, 1 otherwise.
//
// A task in the config's `task_ladders` climbs that ladder of its own, else the run's `ladder` from T1.
// FAKE_RUNNER_STEP_MS sets the pause between events (default 150). FAKE_RUNNER_FAIL lists task seqs that
// escalate from their first rung to the next and still fail their tests. The arguments and the KM0_KEY_*
// variable names it was given are written to fake-runner.json in the run directory.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log(`km0-runner ${process.env.FAKE_RUNNER_VERSION ?? "0.3.0"}`);
  process.exit(0);
}
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};
const many = (name) => {
  const index = argv.indexOf(name);
  if (index < 0) return [];
  const values = [];
  for (const value of argv.slice(index + 1)) {
    if (value.startsWith("--")) break;
    values.push(value);
  }
  return values;
};
if (argv[0] !== "run") {
  console.error(`unsupported command ${argv[0]}`);
  process.exit(2);
}

const packageDir = argv[1];
const runDir = join(option("--runs"), option("--run-id"));
const step = Number(process.env.FAKE_RUNNER_STEP_MS ?? 150);
const failing = (process.env.FAKE_RUNNER_FAIL ?? "").split(",").filter(Boolean).map(Number);
const only = many("--tasks").map(Number);
const config = JSON.parse(readFileSync(option("-c"), "utf8"));
const ladder = config.ladder ?? [];
mkdirSync(join(runDir, "reports"), { recursive: true });
mkdirSync(join(runDir, "diffs"), { recursive: true });
writeFileSync(
  join(runDir, "fake-runner.json"),
  JSON.stringify({
    argv,
    config,
    keys: Object.keys(process.env).filter((name) => name.startsWith("KM0_KEY_")),
    modelsJsonExists: config.pi?.models_json ? existsSync(config.pi.models_json) : null,
  }),
);

let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});
const stopRequested = () => stopped || existsSync(join(runDir, "STOP"));

let seq = 0;
const emit = (event, fields = {}) =>
  appendFileSync(
    join(runDir, "progress.jsonl"),
    `${JSON.stringify({ seq: ++seq, at: new Date().toISOString(), event, ...fields })}\n`,
  );
const pause = () => new Promise((resolve) => setTimeout(resolve, step));

const tasks = JSON.parse(readFileSync(join(packageDir, "km0", "tasks.json"), "utf8")).filter(
  (task) => only.length === 0 || only.includes(task.seq),
);
const id = (task) => String(task.seq).padStart(2, "0");
const ladderOf = (task) => config.task_ladders?.[id(task)] ?? null;
const model = (task, tier) => (ladderOf(task) ?? ladder).find((rung) => rung.name === tier)?.model ?? `fake/${tier}`;
console.log(`fake runner: ${tasks.length} tasks in ${runDir}`);
emit("run_started", {
  run_id: option("--run-id"),
  project_id: null,
  tasks: tasks.map((task) => ({ task_id: id(task), title: task.title })),
  ladder,
});

const totals = { passed: 0, failed: 0, cancelled: 0, cost: 0 };
for (const task of tasks) {
  const taskId = id(task);
  const report = (fields) =>
    writeFileSync(
      join(runDir, "reports", `${taskId}.json`),
      JSON.stringify({
        report_version: 2,
        run_id: option("--run-id"),
        project_id: null,
        task_id: taskId,
        title: task.title,
        predicted_tier: task.tier,
        start_tier: ladderOf(task)?.[0]?.name ?? task.tier,
        ladder: ladderOf(task),
        solved_tier: null,
        escalations: [],
        cost: 0,
        steps: 0,
        test_command: task.testCommand ?? null,
        test_result: null,
        failure_category: null,
        failure_detail: "",
        branch: `km0/${option("--run-id")}/${taskId}`,
        commit: null,
        diff: null,
        acceptance: task.acceptance ?? [],
        attempts: [],
        ...fields,
      }),
    );
  if (stopRequested()) {
    report({ start_tier: null, failure_category: "cancelled", failure_detail: "the run was stopped first" });
    emit("task_finished", {
      task_id: taskId,
      status: "cancelled",
      solved_tier: null,
      cost: 0,
      failure_category: "cancelled",
      failure_detail: "the run was stopped first",
    });
    totals.cancelled += 1;
    continue;
  }
  const fails = failing.includes(task.seq);
  const own = ladderOf(task)?.map((rung) => rung.name);
  const tiers = own ? own.slice(0, fails ? 2 : 1) : fails ? ["T1", "T2"] : [task.tier ?? "T1"];
  emit("task_started", { task_id: taskId, title: task.title, tier: tiers[0], explored: false });
  const attempts = [];
  let cancelled = false;
  for (const [index, tier] of tiers.entries()) {
    emit("attempt_started", { task_id: taskId, tier, model: model(task, tier), purpose: "task" });
    // A long attempt, cut short by a stop request.
    for (let i = 0; i < 4 && !stopRequested(); i += 1) await pause();
    const cost = 0.01 * (index + 1);
    attempts.push({ tier, model: model(task, tier), cost });
    if (stopRequested()) {
      emit("attempt_finished", {
        task_id: taskId,
        tier,
        model: model(task, tier),
        purpose: "task",
        cost,
        steps: 1,
        stop_reason: "cancelled",
      });
      cancelled = true;
      break;
    }
    emit("attempt_finished", {
      task_id: taskId,
      tier,
      model: model(task, tier),
      purpose: "task",
      cost,
      steps: 3,
      stop_reason: "settled",
    });
    const passed = !fails;
    emit("test_result", { task_id: taskId, passed, detail: passed ? "1 passed" : "1 failed" });
    if (fails && index === 0 && tiers[1]) {
      emit("escalation", {
        task_id: taskId,
        from_tier: tiers[0],
        to_tier: tiers[1],
        signal: "tests_failed",
        detail: "1 failed",
      });
    }
  }
  const cost = attempts.reduce((sum, attempt) => sum + attempt.cost, 0);
  totals.cost += cost;
  const diff = `diff --git a/app.txt b/app.txt\n+task ${task.seq}\n`;
  writeFileSync(join(runDir, "diffs", `${taskId}.diff`), diff);
  const status = cancelled ? "cancelled" : fails ? "failed" : "passed";
  const failure = cancelled ? "cancelled" : fails ? "tests_failed" : null;
  report({
    solved_tier: status === "passed" ? tiers.at(-1) : null,
    escalations:
      fails && tiers[1] ? [{ from_tier: tiers[0], to_tier: tiers[1], signal: "tests_failed", detail: "1 failed" }] : [],
    cost,
    steps: 3 * attempts.length,
    test_result: cancelled ? null : { passed: !fails, judge: "test_command", detail: fails ? "1 failed" : "1 passed" },
    failure_category: failure,
    failure_detail: cancelled ? "the run was stopped" : fails ? "1 failed" : "",
    commit: "abc123",
    diff: `diffs/${taskId}.diff`,
    attempts,
  });
  emit("task_finished", {
    task_id: taskId,
    status,
    solved_tier: status === "passed" ? tiers.at(-1) : null,
    cost,
    failure_category: failure,
    failure_detail: "",
  });
  if (status === "passed") totals.passed += 1;
  else if (status === "failed") totals.failed += 1;
  else totals.cancelled += 1;
  console.log(`${taskId}: ${status}`);
}
const finished = stopRequested() ? "cancelled" : "completed";
writeFileSync(join(runDir, "summary.json"), JSON.stringify({ run_id: option("--run-id"), ...totals }));
emit("run_finished", {
  status: finished,
  passed: totals.passed,
  unjudged: 0,
  failed: totals.failed,
  blocked: 0,
  cancelled: totals.cancelled,
  cost: totals.cost,
});
// Not process.exit: output to a pipe would be cut off before it is flushed.
process.exitCode = finished === "cancelled" ? 3 : totals.failed > 0 ? 1 : 0;

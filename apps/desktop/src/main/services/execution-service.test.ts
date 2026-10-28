import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createSimulatedLlm } from "@km0/core";
import bundledRegistry from "@km0/registry/model-registry.json";
import { type ExecutionRun, type ModelEntry, ModelRegistry, type RoutingPlan } from "@km0/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../db/database";
import { nodeExec } from "../node-exec";
import { nodeRunAccess } from "../node-run-access";
import { AgentStore } from "./agent-store";
import { applyProgress, ExecutionService, splitCommand, taskLadder } from "./execution-service";
import { HandoffService } from "./handoff-service";
import { ProjectService } from "./project-service";
import { RoutingService } from "./routing-service";
import { RunRecordStore } from "./run-records";
import { RunnerService } from "./runner-service";
import { PlainSecretStore } from "./secrets";
import { SettingsStore } from "./settings-store";

const fixtures = join(import.meta.dirname, "../../../../../e2e/fixtures");
const FAKE_RUNNER = `${process.execPath} ${join(fixtures, "fake-runner.mjs")}`;
const PATH = process.env.PATH;

beforeAll(() => {
  // The fixtures folder holds a `pi` that reports the pinned version.
  process.env.PATH = `${fixtures}${delimiter}${PATH}`;
  process.env.FAKE_RUNNER_STEP_MS = "20";
});
afterAll(() => {
  process.env.PATH = PATH;
  delete process.env.FAKE_RUNNER_STEP_MS;
  delete process.env.FAKE_RUNNER_FAIL;
});

function gitRepo(): string {
  const path = mkdtempSync(join(tmpdir(), "km0-exec-repo-"));
  writeFileSync(join(path, "app.txt"), "hello\n");
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: path });
  return path;
}

async function setup({ port = nodeExec() as ReturnType<typeof nodeExec> | null } = {}) {
  const db = openDatabase(":memory:");
  const registry = ModelRegistry.parse(bundledRegistry);
  const records = new RunRecordStore(db);
  const settings = new SettingsStore(
    db,
    new PlainSecretStore(),
    () => registry,
    () => records.all(),
  );
  const agents = new AgentStore(db, () => settings.listModels());
  const llm = createSimulatedLlm();
  const language = () => "zh-CN" as const;
  const routing = new RoutingService(db, () => llm, language, agents, undefined, {
    registry: () => registry,
    records,
    pastQuota: () => undefined,
  });
  const handoff = new HandoffService(db, routing, language);
  const runner = new RunnerService(
    db,
    nodeRunAccess(async () => null),
    routing,
    () => llm,
    language,
    () => "simulated",
  );
  const updates: ExecutionRun[] = [];
  const runsDir = mkdtempSync(join(tmpdir(), "km0-exec-runs-"));
  const execution = new ExecutionService(db, port, settings, routing, handoff, runner, language, runsDir, (run) =>
    updates.push(run),
  );
  execution.setSettings({ ...execution.getSettings(), runnerCommand: FAKE_RUNNER });
  const projects = new ProjectService(db, () => llm, language);
  let project = await projects.create("修复登录页按钮上的错别字", null);
  project = await projects.advance(project.id, true);
  await routing.plan(project.id);
  return { db, settings, execution, runner, routing, handoff, updates, runsDir, projectId: project.id };
}

const linkRepo = (db: ReturnType<typeof openDatabase>, projectId: number, path = gitRepo()) => {
  db.prepare("UPDATE projects SET repo_path = ? WHERE id = ?").run(path, projectId);
  return path;
};

const giveKey = (settings: SettingsStore) => {
  const provider = settings.listProviders()[0];
  if (!provider) throw new Error("no seeded provider");
  settings.updateProvider(provider.id, { ...provider, apiKey: "sk-test-123456" });
  return provider.id;
};

async function until(execution: ExecutionService, projectId: number, done: (run: ExecutionRun) => boolean) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const [run] = await execution.list(projectId);
    if (run && done(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for the run");
}

describe("execution", () => {
  it("finds KM0 Runner and pi, and says why the browser build cannot run anything", async () => {
    const { execution } = await setup();
    const status = await execution.status();
    expect(status.runner).toMatchObject({ found: true, version: "0.3.0", ok: true });
    expect(status.pi).toMatchObject({ found: true, version: "1.3.0", ok: true });
    // 0.2 follows progress and stops, but runs every task on the run's one ladder.
    process.env.FAKE_RUNNER_VERSION = "0.2.1";
    try {
      expect((await execution.status()).runner).toMatchObject({
        found: true,
        ok: false,
        problem: expect.stringMatching(/太旧/),
      });
    } finally {
      delete process.env.FAKE_RUNNER_VERSION;
    }

    const web = await setup({ port: null });
    expect(await web.execution.status()).toMatchObject({
      available: false,
      reason: expect.stringMatching(/网页调试版/),
    });
    expect((await web.execution.precheck(web.projectId)).ok).toBe(false);
  });

  it("checks the repository, the tools, the models and their keys before a run", async () => {
    const { db, settings, execution, projectId } = await setup();
    let check = await execution.precheck(projectId);
    expect(check.ok).toBe(false);
    expect(check.items.find((item) => item.id === "repo")).toMatchObject({ ok: false, fix: "project" });
    linkRepo(db, projectId, mkdtempSync(join(tmpdir(), "km0-not-git-")));
    check = await execution.precheck(projectId);
    expect(check.items.find((item) => item.id === "repo")?.detail).toMatch(/不是 git 仓库/);
    linkRepo(db, projectId);
    check = await execution.precheck(projectId);
    expect(check.items.find((item) => item.id === "keys")).toMatchObject({ ok: false, fix: "settings.models" });
    expect(check.items.find((item) => item.id === "ladder")?.detail).toMatch(/^T\d claude-/);
    giveKey(settings);
    check = await execution.precheck(projectId);
    expect(check.ok).toBe(true);
    expect(check.items.map((item) => item.id)).toEqual(["repo", "runner", "pi", "ladder", "keys", "budget"]);
    await expect(execution.precheck(projectId, [9])).resolves.toMatchObject({ ok: false });
  });

  it("starts KM0 Runner with a generated config, follows its progress, then imports and judges the results", async () => {
    const { db, settings, execution, runner, routing, updates, runsDir, projectId } = await setup();
    const repo = linkRepo(db, projectId);
    const providerId = giveKey(settings);
    const started = await execution.start(projectId);
    expect(started).toMatchObject({ status: "running", executor: "runner", seqs: [] });

    const done = await until(execution, projectId, (run) => run.status !== "running" && run.importedRunRef !== null);
    expect(done).toMatchObject({ status: "finished", exitCode: 0, error: null });
    expect(done.tasks).toEqual([expect.objectContaining({ seq: 1, status: "passed", cost: 0.01 })]);
    expect(done.log.some((line) => line.startsWith("fake runner:"))).toBe(true);
    // Updates are pushed while it runs and again once the results are in.
    expect(updates.some((run) => run.status === "running")).toBe(true);
    expect(updates.at(-1)?.importedRunRef).toBe(done.importedRunRef);

    // The key reaches the Runner only through its environment, never a file.
    const seen = JSON.parse(readFileSync(join(started.runDir, "fake-runner.json"), "utf8"));
    expect(seen.keys).toEqual([`KM0_KEY_${providerId}`]);
    expect(seen.argv).toEqual(expect.arrayContaining(["--repo", repo, "--runs", runsDir, "--run-id", started.runId]));
    expect(seen.modelsJsonExists).toBe(true);
    const models = readFileSync(seen.config.pi.models_json, "utf8");
    expect(models).toContain(`"apiKey": "$KM0_KEY_${providerId}"`);
    expect(models).not.toContain("sk-test");
    expect(seen.config.ladder[0].model).toMatch(new RegExp(`^km0-${providerId}/claude-`));
    // The task climbs its own escalation chain, from the combination it was routed to.
    const [task] = (routing.get(projectId) as RoutingPlan).tasks;
    const own = seen.config.task_ladders["01"] as { name: string; model: string }[];
    expect(own[0]).toEqual({ name: task?.choice?.tier, model: `km0-${providerId}/${task?.choice?.modelId}` });
    expect(own.map((rung) => rung.model.split("/")[1])).toEqual(
      [task?.choice, ...(task?.chain ?? [])].map((step) => step?.modelId),
    );
    for (const rung of own) expect(models).toContain(`"id": "${rung.model.split("/")[1]}"`);
    expect(done.tasks[0]?.model).toBe(own[0]?.model);

    // The simulated judge accepts it, and the verdict is recorded.
    const [imported] = runner.list(projectId);
    expect(imported?.results[0]?.accepted).toBe(true);
  });

  it("stops a run on request: the Runner cancels what is left and KM0 records it", async () => {
    process.env.FAKE_RUNNER_STEP_MS = "250";
    try {
      const { db, settings, execution, projectId } = await setup();
      linkRepo(db, projectId);
      giveKey(settings);
      const started = await execution.start(projectId);
      await until(execution, projectId, (run) => run.tasks.some((task) => task.status === "running"));
      const stopping = await execution.stop(projectId, started.id);
      expect(stopping.status).toBe("stopping");
      const done = await until(execution, projectId, (run) => run.status === "cancelled");
      expect(done).toMatchObject({ exitCode: 3, tasks: [expect.objectContaining({ status: "cancelled" })] });
      expect(execution.runningCount()).toBe(0);
    } finally {
      process.env.FAKE_RUNNER_STEP_MS = "20";
    }
  });

  it("redoes failed tasks on top of an earlier run, and runs a custom command marked unverified", async () => {
    process.env.FAKE_RUNNER_FAIL = "1";
    const { db, settings, execution, projectId } = await setup();
    linkRepo(db, projectId);
    giveKey(settings);
    const first = await execution.start(projectId);
    const failed = await until(execution, projectId, (run) => run.status !== "running" && run.importedRunRef !== null);
    expect(failed).toMatchObject({ status: "finished", exitCode: 1 });
    expect(failed.tasks[0]).toMatchObject({
      status: "failed",
      escalations: [expect.objectContaining({ from: "T1", to: "T2" })],
    });
    delete process.env.FAKE_RUNNER_FAIL;

    const redo = await execution.start(projectId, [1], first.runId);
    expect(redo).toMatchObject({ seqs: [1], reuse: first.runId });
    await until(execution, projectId, (run) => run.id === redo.id && run.status === "finished");
    const seen = JSON.parse(readFileSync(join(redo.runDir, "fake-runner.json"), "utf8"));
    expect(seen.argv).toEqual(expect.arrayContaining(["--tasks", "1", "--reuse", first.runId]));

    execution.setSettings({
      ...execution.getSettings(),
      kind: "custom",
      customTemplate: `echo running {tasks} in {repo}`,
      customEnv: { GREETING: "hi" },
    });
    const check = await execution.precheck(projectId);
    expect(check.items.find((item) => item.id === "custom")?.detail).toMatch(/未验证/);
    const custom = await execution.start(projectId);
    const ended = await until(execution, projectId, (run) => run.id === custom.id && run.status !== "running");
    expect(ended).toMatchObject({ status: "finished", executor: "custom", exitCode: 0 });
    expect(ended.log.join("\n")).toMatch(/running 1 in /);
    // No Runner results to import: KM0 says so instead of guessing.
    const noted = await until(execution, projectId, (run) => run.id === custom.id && run.error !== null);
    expect(noted.error).toMatch(/手动导入/);
  });

  it("marks a run left going when KM0 closed as interrupted, or finished when its progress says so", async () => {
    const { db, settings, routing, handoff, runner, projectId } = await setup();
    const runDir = mkdtempSync(join(tmpdir(), "km0-exec-stale-"));
    writeFileSync(join(runDir, "progress.jsonl"), `${JSON.stringify({ event: "run_started", tasks: [] })}\n`);
    db.prepare(
      `INSERT INTO runs (project_id, run_id, executor, status, run_dir, started_at) VALUES (?, 'old', 'runner', 'running', ?, ?)`,
    ).run(projectId, runDir, new Date().toISOString());
    // A new service, as on the next start, settles stale rows by itself.
    const again = new ExecutionService(db, nodeExec(), settings, routing, handoff, runner, () => "zh-CN", "runs");
    const run = await until(again, projectId, (item) => item.status !== "running");
    expect(run).toMatchObject({ status: "interrupted", error: expect.stringMatching(/还没有结束/) });
  });
});

/**
 * Against the real KM0 Runner, with the scripted pi from its own tests. Set KM0_RUNNER_REAL to a KM0-runner
 * checkout with its virtualenv (`python -m venv .venv && .venv/bin/pip install -e .`) to run it.
 */
describe.runIf(process.env.KM0_RUNNER_REAL)("execution with the real KM0 Runner", () => {
  it("runs, reports progress and is imported", async () => {
    const checkout = process.env.KM0_RUNNER_REAL as string;
    const bin = mkdtempSync(join(tmpdir(), "km0-real-bin-"));
    const script = join(bin, "script.json");
    const write = { tools: [{ name: "write", args: { path: "done.txt", content: "ok\n" } }] };
    writeFileSync(
      script,
      JSON.stringify({
        runs: Object.fromEntries(
          ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"].map((m) => [m, [[write, { text: "done" }]]]),
        ),
      }),
    );
    // `pi` answers the version check itself and hands everything else to the scripted fake.
    writeFileSync(
      join(bin, "pi"),
      `#!/bin/sh\ncase "$1" in --version) echo 1.3.0; exit 0;; esac\nFAKE_PI_SCRIPT=${script} FAKE_PI_LOG=${join(bin, "log.jsonl")} exec ${join(checkout, ".venv/bin/python")} ${join(checkout, "tests/fake_pi.py")} "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${delimiter}${PATH}`;
    try {
      const { db, settings, execution, projectId } = await setup();
      execution.setSettings({ ...execution.getSettings(), runnerCommand: join(checkout, ".venv/bin/km0-runner") });
      linkRepo(db, projectId);
      giveKey(settings);
      expect((await execution.precheck(projectId)).ok).toBe(true);
      await execution.start(projectId);
      const done = await until(execution, projectId, (run) => run.status !== "running" && run.importedRunRef !== null);
      expect(done).toMatchObject({ status: "finished", error: null });
      expect(done.tasks).toEqual([
        expect.objectContaining({ seq: 1, status: expect.stringMatching(/passed|unjudged/) }),
      ]);
      expect(done.tasks[0]?.model).toMatch(/^km0-\d+\/claude-/);
    } finally {
      process.env.PATH = `${fixtures}${delimiter}${PATH}`;
    }
  }, 60_000);
});

describe("progress", () => {
  it("folds events into tasks and skips what it cannot read", () => {
    const lines = [
      {
        event: "run_started",
        tasks: [
          { task_id: "01", title: "a" },
          { task_id: "02", title: "b" },
        ],
      },
      { event: "task_started", task_id: "01", tier: "T1" },
      { event: "attempt_started", task_id: "01", tier: "T1", model: "p/cheap", purpose: "task" },
      { event: "attempt_finished", task_id: "01", cost: 0.5 },
      { event: "escalation", task_id: "01", from_tier: "T1", to_tier: "T2", signal: "s", detail: "d" },
      { event: "attempt_started", task_id: "01", tier: "T2", model: "p/mid", purpose: "task" },
      { event: "task_finished", task_id: "01", status: "passed" },
    ].map((event) => JSON.stringify(event));
    const state = applyProgress({ tasks: new Map(), finished: null, cost: 0 }, [...lines, "{not json"]);
    expect([...state.tasks.values()]).toMatchObject([
      { seq: 1, status: "passed", tier: "T2", model: "p/mid", cost: 0.5, escalations: [{ from: "T1", to: "T2" }] },
      { seq: 2, status: "waiting" },
    ]);
    expect(state.cost).toBe(0.5);
  });

  it("names a task's rungs by tier label and skips a model already on its ladder", () => {
    const model = (id: number) => ({ id, modelId: `m${id}` }) as ModelEntry;
    const byRef = new Map([1, 2, 3].map((id) => [id, model(id)]));
    const step = (tier: string, modelRef: number) =>
      ({ tier, modelRef }) as RoutingPlan["tasks"][number]["chain"][number];
    // The same model through another agent, and a model no longer in Settings, add no rung.
    const chain = [step("T2", 2), step("T2", 1), step("T3", 9), step("T3", 3)];
    expect(taskLadder({ choice: step("T2", 1), chain }, byRef)).toEqual([
      { name: "T2", model: model(1) },
      { name: "T2-2", model: model(2) },
      { name: "T3", model: model(3) },
    ]);
    expect(taskLadder({ choice: null, chain: [] }, byRef)).toEqual([]);
  });

  it("splits a command with quoted parts", () => {
    expect(splitCommand(`"C:\\Program Files\\py\\python.exe" -m km0_runner`)).toEqual([
      "C:\\Program Files\\py\\python.exe",
      "-m",
      "km0_runner",
    ]);
  });
});

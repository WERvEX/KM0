import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createKm0McpServer, insideWorktree } from "../../mcp/server";
import { nodeExec } from "../node-exec";
import { DirectRun, type DirectTask, dependencyOrder } from "./direct-run";
import { readInbox } from "./inbox";

const FAKE_CLAUDE = [process.execPath, join(import.meta.dirname, "../../../../../e2e/fixtures/fake-claude.mjs")];
const FAKE_CODEX = [process.execPath, join(import.meta.dirname, "../../../../../e2e/fixtures/fake-codex.mjs")];
/** A test command that passes when every named file is in the worktree; quoted for sh and cmd alike. */
const has = (...files: string[]) =>
  `node -e "process.exit([${files.map((file) => `'${file}'`).join(",")}].every((f) => require('fs').existsSync(f)) ? 0 : 1)"`;

function gitRepo(): string {
  const path = mkdtempSync(join(tmpdir(), "km0-direct-repo-"));
  writeFileSync(join(path, "app.txt"), "hello\n");
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: path });
  return path;
}

function packageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "km0-direct-pkg-"));
  mkdirSync(join(dir, "tasks"));
  writeFileSync(join(dir, "tasks.json"), "[]\n");
  writeFileSync(join(dir, "tasks", "01.md"), "# Task 01\n");
  return dir;
}

const task = (seq: number, agent: string, dependsOn: number[], testCommand: string | null): DirectTask => ({
  seq,
  title: `Task ${seq}`,
  dependsOn,
  agent,
  model: "claude-sonnet-5-5",
  modelRef: "km0-1/claude-sonnet-5-5",
  tier: "T2",
  prompt: `Do task ${seq}.`,
  testCommand,
  acceptance: [`When task ${seq} is done, the file exists.`],
  env: {},
});

const runs: DirectRun[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) run.kill();
});

function start(repo: string, tasks: DirectTask[], overrides: Partial<ConstructorParameters<typeof DirectRun>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "km0-direct-runs-"));
  const runId = "20261101-120000";
  const lines: string[] = [];
  const run = new DirectRun({
    runId,
    runDir: join(root, runId),
    repo,
    projectId: 7,
    projectTitle: "Demo",
    packageDir: packageDir(),
    tasks,
    seqs: [],
    reuse: null,
    inboxDir: join(root, "dispatch"),
    claudeCommand: FAKE_CLAUDE,
    budget: null,
    language: "en",
    version: "1.1.0",
    onLine: (line) => lines.push(line),
    pollMs: 20,
    ...overrides,
  });
  runs.push(run);
  return { run, runDir: join(root, runId), inboxDir: join(root, "dispatch"), lines, runId };
}

async function desktop(inboxDir: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createKm0McpServer(inboxDir).connect(serverSide);
  const client = new Client({ name: "scripted-claude-desktop", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError === true };
  };
  return { call, close: () => client.close() };
}

const progress = (runDir: string) =>
  readFileSync(join(runDir, "progress.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const report = (runDir: string, seq: string) =>
  JSON.parse(readFileSync(join(runDir, "reports", `${seq}.json`), "utf8")) as Record<string, unknown>;

describe("dependency order", () => {
  it("puts every task after the tasks it depends on", () => {
    const order = dependencyOrder([
      { seq: 1, dependsOn: [3] },
      { seq: 2, dependsOn: [] },
      { seq: 3, dependsOn: [2] },
    ]);
    expect(order.map((item) => item.seq)).toEqual([2, 3, 1]);
  });
});

describe("Claude Code and Claude Desktop finish a project together", () => {
  it("hands 01 to Claude Code, 02 to Claude Desktop over MCP and 03 to Claude Code, each on top of the last", async () => {
    const repo = gitRepo();
    const { run, runDir, inboxDir, runId } = start(repo, [
      task(1, "claude_code", [], has("claude-01.txt")),
      task(2, "claude_desktop", [1], has("claude-01.txt", "desktop-02.txt")),
      task(3, "claude_code", [2], has("claude-01.txt", "desktop-02.txt", "claude-03.txt")),
    ]);

    // Claude Desktop, scripted: wait for the task, look around, write a file, run the tests and report.
    const agent = await desktop(inboxDir);
    let taken = await agent.call("km0_next_task");
    for (let i = 0; !/Took task/.test(taken.text) && i < 500; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      taken = await agent.call("km0_next_task");
    }
    const ref = `${runId}/02`;
    expect(taken.text).toContain(`Took task ${ref}`);
    expect(taken.text).toContain("Do task 2.");
    expect(progress(runDir).some((event) => event.event === "task_waiting" && event.task_id === "02")).toBe(true);

    const files = await agent.call("km0_list_files", { task_ref: ref });
    expect(files.text.split("\n")).toEqual(expect.arrayContaining(["app.txt", "claude-01.txt", "km0/tasks/01.md"]));
    expect((await agent.call("km0_read_file", { task_ref: ref, path: "claude-01.txt" })).text).toMatch(/task 01/);
    expect((await agent.call("km0_run_tests", { task_ref: ref })).isError).toBe(true);
    await agent.call("km0_write_file", {
      task_ref: ref,
      path: "desktop-02.txt",
      content: "task 02 by Claude Desktop\n",
    });
    expect((await agent.call("km0_run_tests", { task_ref: ref })).text).toMatch(/exit code 0/);
    // Nothing outside the worktree, and not its .git.
    expect((await agent.call("km0_read_file", { task_ref: ref, path: "../../../etc/hosts" })).isError).toBe(true);
    expect((await agent.call("km0_write_file", { task_ref: ref, path: ".git/config", content: "x" })).isError).toBe(
      true,
    );
    await agent.call("km0_report", { task_ref: ref, status: "done", summary: "Added desktop-02.txt." });
    expect((await agent.call("km0_write_file", { task_ref: ref, path: "late.txt", content: "x" })).isError).toBe(true);

    expect(await run.exited).toEqual({ code: 0, signal: null });
    await agent.close();

    for (const seq of ["01", "02", "03"]) {
      expect(report(runDir, seq)).toMatchObject({
        report_version: 2,
        run_id: runId,
        project_id: 7,
        task_id: seq,
        branch: `km0/${runId}/${seq}`,
        test_result: { passed: true },
        failure_category: null,
      });
    }
    expect(report(runDir, "01")).toMatchObject({
      agent: "claude_code",
      cost: 0.0125,
      steps: 1,
      solved_tier: "T2",
      attempts: [expect.objectContaining({ agent: "claude_code", model: "km0-1/claude-sonnet-5-5", cost: 0.0125 })],
    });
    expect(report(runDir, "02")).toMatchObject({ agent: "claude_desktop", depends_on: ["01"] });
    // Each branch carries the work of the tasks before it; the user's checkout and km0/ are untouched.
    const show = (ref: string) =>
      execSync(`git show ${ref}`, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(show(`km0/${runId}/03:desktop-02.txt`)).toBe("task 02 by Claude Desktop\n");
    expect(show(`km0/${runId}/03:claude-01.txt`)).toMatch(/task 01/);
    expect(() => show(`km0/${runId}/03:km0/tasks.json`)).toThrow();
    expect(execSync("git status --porcelain", { cwd: repo, encoding: "utf8" })).toBe("");
    expect(execSync("git branch --show-current", { cwd: repo, encoding: "utf8" }).trim()).not.toContain("km0/");
    expect(readFileSync(join(runDir, "diffs", "02.diff"), "utf8")).toContain("+task 02 by Claude Desktop");
    expect(JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"))).toMatchObject({ passed: 3, failed: 0 });
    expect(progress(runDir).at(-1)).toMatchObject({ event: "run_finished", status: "completed" });
    expect(existsSync(join(runDir, "worktrees", "02"))).toBe(false);
    expect(await readInbox(inboxDir)).toEqual([]);
  });

  it("blocks the tasks after a failed one, and gives Claude Code the model and budget", async () => {
    const repo = gitRepo();
    const argsFile = join(mkdtempSync(join(tmpdir(), "km0-args-")), "args.jsonl");
    process.env.FAKE_CLAUDE_FAIL = "01";
    process.env.FAKE_CLAUDE_ARGS = argsFile;
    try {
      const { run, runDir } = start(repo, [task(1, "claude_code", [], null), task(2, "claude_code", [1], null)], {
        budget: 5,
      });
      expect((await run.exited).code).toBe(1);
      expect(report(runDir, "01")).toMatchObject({
        failure_category: "error",
        failure_detail: "The fake model gave up.",
      });
      expect(report(runDir, "02")).toMatchObject({ failure_category: "blocked", branch: null });
      const call = JSON.parse(readFileSync(argsFile, "utf8").split("\n")[0] as string) as { args: string[] };
      expect(call.args).toEqual(
        expect.arrayContaining([
          "-p",
          "--output-format",
          "stream-json",
          "--model",
          "claude-sonnet-5-5",
          "--max-budget-usd",
          "5.00",
        ]),
      );
    } finally {
      delete process.env.FAKE_CLAUDE_FAIL;
      delete process.env.FAKE_CLAUDE_ARGS;
    }
  });

  it("stops: a task waiting for Claude Desktop and everything after it are cancelled", async () => {
    const repo = gitRepo();
    const { run, runDir, inboxDir } = start(repo, [
      task(1, "claude_desktop", [], null),
      task(2, "claude_code", [1], null),
    ]);
    for (let i = 0; (await readInbox(inboxDir)).length === 0 && i < 500; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await readInbox(inboxDir))[0]).toMatchObject({ state: "waiting", taskId: "01" });
    run.terminate();
    expect((await run.exited).code).toBe(3);
    expect(report(runDir, "01")).toMatchObject({ failure_category: "cancelled" });
    expect(report(runDir, "02")).toMatchObject({ failure_category: "cancelled" });
    expect(progress(runDir).at(-1)).toMatchObject({ event: "run_finished", status: "cancelled" });
    expect(await readInbox(inboxDir)).toEqual([]);
    expect(readdirSync(join(runDir, "worktrees"))).toEqual([]);
  });

  it("refuses an agent it cannot hand a task to", async () => {
    const { run, runDir } = start(gitRepo(), [task(1, "cursor", [], null)]);
    expect((await run.exited).code).toBe(1);
    expect(report(runDir, "01")).toMatchObject({
      failure_detail: expect.stringMatching(/cannot hand a task to cursor/),
    });
  });
});

describe("the MCP server's file tools stay in the worktree", () => {
  it("rejects paths outside it, .git, and links that lead out", async () => {
    const root = mkdtempSync(join(tmpdir(), "km0-worktree-"));
    const outside = mkdtempSync(join(tmpdir(), "km0-outside-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".git"));
    if (process.platform !== "win32") {
      symlinkSync(outside, join(root, "escape"));
      symlinkSync(join(outside, "dangling.txt"), join(root, "dangling"));
    }
    expect(await insideWorktree(root, "src/new/file.ts")).toBe(join(root, "src", "new", "file.ts"));
    expect(await insideWorktree(root, "..env")).toBe(join(root, "..env"));
    expect(await insideWorktree(root, "../x")).toBeNull();
    expect(await insideWorktree(root, ".git/config")).toBeNull();
    expect(await insideWorktree(root, ".GIT/config")).toBeNull();
    if (process.platform !== "win32") {
      expect(await insideWorktree(root, "escape/secret.txt")).toBeNull();
      expect(await insideWorktree(root, "dangling")).toBeNull();
    }
  });

  it("prevents concurrent MCP clients from claiming the same task", async () => {
    const root = mkdtempSync(join(tmpdir(), "km0-mcp-race-"));
    const worktree = mkdtempSync(join(tmpdir(), "km0-mcp-wt-"));
    const { putTask } = await import("./inbox");
    await putTask(root, {
      version: 1,
      ref: "r1/01",
      runId: "r1",
      taskId: "01",
      seq: 1,
      title: "Solo",
      projectTitle: "Demo",
      agent: "claude_desktop",
      model: null,
      worktree,
      branch: "km0/r1/01",
      prompt: "Do solo task",
      testCommand: null,
      acceptance: [],
      language: "en",
      state: "waiting",
      createdAt: new Date().toISOString(),
      claimedAt: null,
      report: null,
    });
    const clientA = await desktop(root);
    const clientB = await desktop(root);
    const [a, b] = await Promise.all([clientA.call("km0_next_task"), clientB.call("km0_next_task")]);
    const texts = [a.text, b.text];
    expect(texts.filter((t) => t.includes("Took task r1/01"))).toHaveLength(1);
    expect(texts.filter((t) => t.includes("No KM0 task is waiting"))).toHaveLength(1);
    await clientA.close();
    await clientB.close();
  });
});

describe("Codex", () => {
  it("does its task after Claude Code's, on top of it, with the model it was routed to", async () => {
    const repo = gitRepo();
    const argsFile = join(mkdtempSync(join(tmpdir(), "km0-args-")), "args.jsonl");
    process.env.FAKE_CODEX_ARGS = argsFile;
    try {
      const { run, runDir, runId, lines } = start(
        repo,
        [
          task(1, "claude_code", [], has("claude-01.txt")),
          { ...task(2, "codex", [1], has("claude-01.txt", "codex-02.txt")), model: "gpt-5.6-luna" },
        ],
        { codexCommand: FAKE_CODEX },
      );
      expect((await run.exited).code).toBe(0);
      expect(report(runDir, "02")).toMatchObject({
        agent: "codex",
        steps: 1,
        cost: 0,
        tokens: { input: 1500, output: 150, cache_read: 500, cache_write: 0 },
        test_result: { passed: true },
        failure_category: null,
        attempts: [expect.objectContaining({ agent: "codex", events: "events/02.jsonl", stop_reason: "settled" })],
      });
      const [call] = readFileSync(argsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(call.args).toEqual(["exec", "--json", "--sandbox", "workspace-write", "--model", "gpt-5.6-luna", "-"]);
      expect(lines.some((line) => /^→ Write .*codex-02\.txt$/.test(line))).toBe(true);
      const show = (ref: string) => execSync(`git show ${ref}`, { cwd: repo, encoding: "utf8" });
      expect(show(`km0/${runId}/02:claude-01.txt`)).toMatch(/task 01/);
      expect(show(`km0/${runId}/02:codex-02.txt`)).toMatch(/task 02 by fake Codex \(gpt-5.6-luna\)/);
    } finally {
      delete process.env.FAKE_CODEX_ARGS;
    }
  });

  it("fails a task whose turn fails, and says so when Codex is missing", async () => {
    process.env.FAKE_CODEX_FAIL = "01";
    try {
      const { run, runDir } = start(gitRepo(), [task(1, "codex", [], null)], { codexCommand: FAKE_CODEX });
      expect((await run.exited).code).toBe(1);
      expect(report(runDir, "01")).toMatchObject({
        failure_category: "error",
        failure_detail: "The fake model gave up.",
      });
    } finally {
      delete process.env.FAKE_CODEX_FAIL;
    }
    const missing = start(gitRepo(), [task(1, "codex", [], null)], { codexCommand: null });
    expect((await missing.run.exited).code).toBe(1);
    expect(report(missing.runDir, "01")).toMatchObject({ failure_detail: "Codex was not found." });
  });
});

describe("Phase 2: structured handoffs, inline EARS gate, in-place repair and cross-agent escalation", () => {
  it("passes structured handoff contracts and downstream notes across Claude Code → Claude Desktop → Codex", async () => {
    const repo = gitRepo();
    const codexArgsFile = join(mkdtempSync(join(tmpdir(), "km0-codex-handoff-")), "args.jsonl");
    process.env.FAKE_CLAUDE_EXPORT = "01";
    process.env.FAKE_CODEX_ARGS = codexArgsFile;
    try {
      const { run, runDir, inboxDir, runId } = start(
        repo,
        [
          task(1, "claude_code", [], has("claude-01.txt", "exported-01.ts")),
          task(2, "claude_desktop", [1], has("desktop-02.txt")),
          { ...task(3, "codex", [2], has("codex-03.txt")), model: "gpt-5.6-luna" },
        ],
        { codexCommand: FAKE_CODEX },
      );

      const agent = await desktop(inboxDir);
      let taken = await agent.call("km0_next_task");
      for (let i = 0; !/Took task/.test(taken.text) && i < 500; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        taken = await agent.call("km0_next_task");
      }
      const ref = `${runId}/02`;
      // Claude Desktop sees task 01's extracted TypeScript export in its prompt and km0/upstream.md.
      expect(taken.text).toContain("exported-01.ts: export function computeTotal(items: number[])");
      const upstreamMd = await agent.call("km0_read_file", { task_ref: ref, path: "km0/upstream.md" });
      expect(upstreamMd.isError).toBe(false);
      expect(upstreamMd.text).toContain("computeTotal");

      await agent.call("km0_write_file", { task_ref: ref, path: "desktop-02.txt", content: "from desktop\n" });
      await agent.call("km0_report", {
        task_ref: ref,
        status: "done",
        summary: "Built UI adapter for pricing.",
        contracts: ["export interface PricingAdapter"],
        downstream_notes: "Always pass integer cents to PricingAdapter.",
      });

      expect((await run.exited).code).toBe(0);
      await agent.close();

      // Handoff JSON files are saved for every finished task.
      const h1 = JSON.parse(readFileSync(join(runDir, "handoffs", "01.json"), "utf8"));
      expect(h1.changed_files).toEqual(expect.arrayContaining(["claude-01.txt", "exported-01.ts"]));
      expect(h1.contracts).toEqual(
        expect.arrayContaining(["exported-01.ts: export function computeTotal(items: number[])"]),
      );
      const h2 = JSON.parse(readFileSync(join(runDir, "handoffs", "02.json"), "utf8"));
      expect(h2.contracts).toEqual(["export interface PricingAdapter"]);
      expect(h2.notes_for_downstream).toBe("Always pass integer cents to PricingAdapter.");

      // Codex (task 03) received Claude Desktop's contracts and downstream notes in its prompt.
      const [codexCall] = readFileSync(codexArgsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { prompt: string });
      expect(codexCall?.prompt).toContain("export interface PricingAdapter");
      expect(codexCall?.prompt).toContain("Always pass integer cents to PricingAdapter.");
      // km0/upstream.md is never committed to the git branch.
      expect(() =>
        execSync(`git show km0/${runId}/03:km0/upstream.md`, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }),
      ).toThrow();
    } finally {
      delete process.env.FAKE_CLAUDE_EXPORT;
      delete process.env.FAKE_CODEX_ARGS;
    }
  });

  it("runs the inline EARS gate, repairs in place with feedback, and unlocks downstream tasks", async () => {
    const repo = gitRepo();
    const argsFile = join(mkdtempSync(join(tmpdir(), "km0-repair-args-")), "args.jsonl");
    process.env.FAKE_CLAUDE_REPAIR_FIX = "01";
    process.env.FAKE_CLAUDE_ARGS = argsFile;
    let judgeCalls = 0;
    try {
      const { run, runDir, runId } = start(
        repo,
        [task(1, "claude_code", [], null), task(2, "claude_code", [1], has("claude-01.txt", "claude-02.txt"))],
        {
          judge: async ({ task: current, diff }) => {
            judgeCalls += 1;
            if (current.seq === 1 && !diff?.includes("fixed")) {
              return { accepted: false, reason: "Missing validation for negative inputs.", judgedBy: "test-judge" };
            }
            return { accepted: true, reason: "All EARS criteria satisfied.", judgedBy: "test-judge" };
          },
        },
      );
      expect((await run.exited).code).toBe(0);
      // Task 01 judged twice (rejected, repaired, accepted) + task 02 judged once = 3.
      expect(judgeCalls).toBe(3);

      const r1 = report(runDir, "01");
      expect(r1).toMatchObject({
        failure_category: null,
        solved_tier: "T2",
        attempts: [
          expect.objectContaining({
            purpose: "task",
            verdict: { accepted: false, reason: "Missing validation for negative inputs." },
          }),
          expect.objectContaining({
            purpose: "repair",
            events: "events/01-a2.jsonl",
            verdict: { accepted: true, reason: "All EARS criteria satisfied." },
          }),
        ],
      });
      const calls = readFileSync(argsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { seq: string; prompt: string });
      // The repair prompt delivered the reviewer's exact rejection reason.
      expect(calls[1]?.prompt).toContain("KM0_REPAIR");
      expect(calls[1]?.prompt).toContain("Missing validation for negative inputs.");
      // Final committed file has the repaired content and acceptance.jsonl has both accepted verdicts.
      expect(execSync(`git show km0/${runId}/01:claude-01.txt`, { cwd: repo, encoding: "utf8" })).toContain("fixed");
      const verdicts = readFileSync(join(runDir, "acceptance.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(verdicts).toMatchObject([
        { task_id: "01", accepted: true, judged_by: "test-judge" },
        { task_id: "02", accepted: true, judged_by: "test-judge" },
      ]);
      expect(
        progress(runDir).some(
          (event) => event.event === "task_judged" && event.task_id === "01" && event.accepted === true,
        ),
      ).toBe(true);
    } finally {
      delete process.env.FAKE_CLAUDE_REPAIR_FIX;
      delete process.env.FAKE_CLAUDE_ARGS;
    }
  });

  it("climbs the escalation chain across agents (Codex T1 → Claude Code T2) after failed tests and cleans the worktree", async () => {
    const repo = gitRepo();
    const claudeArgsFile = join(mkdtempSync(join(tmpdir(), "km0-esc-args-")), "args.jsonl");
    process.env.FAKE_CLAUDE_ARGS = claudeArgsFile;
    try {
      // Only Claude Code writes `claude-01.txt`, so Codex fails the test command even after its in-place repair,
      // then DirectRun escalates cleanly to Claude Code on T2.
      const job: DirectTask = {
        ...task(1, "codex", [], has("claude-01.txt")),
        tier: "T1",
        model: "gpt-5.6-luna",
        modelRef: "km0-2/gpt-5.6-luna",
        escalations: [
          {
            agent: "claude_code",
            model: "claude-sonnet-5-5",
            modelRef: "km0-1/claude-sonnet-5-5",
            tier: "T2",
            env: {},
          },
        ],
      };
      const { run, runDir, runId } = start(repo, [job], {
        codexCommand: FAKE_CODEX,
        judge: async () => ({ accepted: true, reason: "Looks good.", judgedBy: "test-judge" }),
      });
      expect((await run.exited).code).toBe(0);

      const r1 = report(runDir, "01");
      expect(r1).toMatchObject({
        agent: "claude_code",
        solved_tier: "T2",
        failure_category: null,
        escalations: [
          expect.objectContaining({
            from_tier: "T1",
            to_tier: "T2",
            from_agent: "codex",
            to_agent: "claude_code",
            signal: "tests_failed",
          }),
        ],
      });
      // Attempt 1 (codex task), attempt 2 (codex repair), attempt 3 (claude_code escalation).
      expect((r1.attempts as { agent: string; purpose: string }[]).map((a) => [a.agent, a.purpose])).toEqual([
        ["codex", "task"],
        ["codex", "repair"],
        ["claude_code", "escalation"],
      ]);
      // Worktree was reset to baseCommit before escalation, so Codex's failed file is NOT left on the final branch.
      expect(() =>
        execSync(`git show km0/${runId}/01:codex-01.txt`, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }),
      ).toThrow();
      expect(execSync(`git show km0/${runId}/01:claude-01.txt`, { cwd: repo, encoding: "utf8" })).toContain(
        "claude-sonnet-5-5",
      );
      const [claudeCall] = readFileSync(claudeArgsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { prompt: string });
      expect(claudeCall?.prompt).toContain("codex / T1 / gpt-5.6-luna");
    } finally {
      delete process.env.FAKE_CLAUDE_ARGS;
    }
  });

  it("blocks downstream tasks when the inline EARS gate rejects a task with no retries or escalations left", async () => {
    const repo = gitRepo();
    const { run, runDir } = start(repo, [task(1, "claude_code", [], null), task(2, "claude_code", [1], null)], {
      maxRepairs: 0,
      judge: async () => ({ accepted: false, reason: "Missing audit log entry.", judgedBy: "test-judge" }),
    });
    expect((await run.exited).code).toBe(1);
    expect(report(runDir, "01")).toMatchObject({
      failure_category: "acceptance_rejected",
      failure_detail: "Missing audit log entry.",
    });
    expect(report(runDir, "02")).toMatchObject({ failure_category: "blocked", branch: null });
    const verdicts = readFileSync(join(runDir, "acceptance.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(verdicts).toMatchObject([{ task_id: "01", accepted: false, reason: "Missing audit log entry." }]);
  });
});

describe("Phase 3: parallel DAG execution, conflict coordination and final integration branch", () => {
  it("runs independent DAG branches concurrently and converges onto a downstream task and final branch", async () => {
    const repo = gitRepo();
    const argsFile = join(mkdtempSync(join(tmpdir(), "km0-parallel-args-")), "args.jsonl");
    process.env.FAKE_CLAUDE_ARGS = argsFile;
    process.env.FAKE_CLAUDE_DELAY_MS = "300";
    try {
      const { run, runDir, runId } = start(
        repo,
        [
          task(1, "claude_code", [], has("claude-01.txt")),
          task(2, "claude_code", [1], has("claude-01.txt", "claude-02.txt")),
          task(3, "claude_code", [1], has("claude-01.txt", "claude-03.txt")),
          task(4, "claude_code", [2, 3], has("claude-01.txt", "claude-02.txt", "claude-03.txt", "claude-04.txt")),
        ],
        { maxConcurrency: 2 },
      );
      expect((await run.exited).code).toBe(0);

      const calls = readFileSync(argsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { seq: string; startedAt: number; finishedAt: number });
      const bySeq = new Map(calls.map((c) => [c.seq, c]));
      const c1 = bySeq.get("01");
      const c2 = bySeq.get("02");
      const c3 = bySeq.get("03");
      const c4 = bySeq.get("04");
      expect(c1 && c2 && c3 && c4).toBeTruthy();
      if (!c1 || !c2 || !c3 || !c4) return;
      // Tasks 02 and 03 overlapped in wall-clock time, after 01 and before 04.
      expect(Math.max(c2.startedAt, c3.startedAt)).toBeLessThan(Math.min(c2.finishedAt, c3.finishedAt));
      expect(c2.startedAt).toBeGreaterThanOrEqual(c1.finishedAt - 20);
      expect(c4.startedAt).toBeGreaterThanOrEqual(Math.max(c2.finishedAt, c3.finishedAt) - 20);

      const finalBranch = `km0/${runId}/final`;
      for (const file of ["claude-01.txt", "claude-02.txt", "claude-03.txt", "claude-04.txt"]) {
        expect(execSync(`git show ${finalBranch}:${file}`, { cwd: repo, encoding: "utf8" })).toContain(
          "fake Claude Code",
        );
      }
      const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
      expect(summary.integration).toMatchObject({ branch: finalBranch, status: "ready", files: 4 });
      expect(readFileSync(join(runDir, "diffs", "final.diff"), "utf8")).toContain("claude-04.txt");
      expect(
        progress(runDir).some((event) => event.event === "integration_finished" && event.branch === finalBranch),
      ).toBe(true);
    } finally {
      delete process.env.FAKE_CLAUDE_ARGS;
      delete process.env.FAKE_CLAUDE_DELAY_MS;
    }
  }, 15_000);

  it("automatically resolves multi-upstream git merge conflicts before a downstream task starts", async () => {
    const repo = gitRepo();
    process.env.FAKE_CLAUDE_CONFLICT_FILE = "app.txt";
    process.env.FAKE_CODEX_CONFLICT_FILE = "app.txt";
    try {
      const { run, runDir } = start(
        repo,
        [
          task(1, "claude_code", [], has("claude-01.txt")),
          { ...task(2, "codex", [], has("codex-02.txt")), model: "gpt-5.6-luna" },
          task(3, "claude_code", [1, 2], null),
        ],
        {
          codexCommand: FAKE_CODEX,
          maxConcurrency: 2,
          resolveConflicts: true,
        },
      );
      expect((await run.exited).code).toBe(0);
      const r3 = report(runDir, "03");
      expect(r3.failure_category).toBeNull();
      expect((r3.attempts as { purpose: string }[]).some((a) => a.purpose === "merge")).toBe(true);
    } finally {
      delete process.env.FAKE_CLAUDE_CONFLICT_FILE;
      delete process.env.FAKE_CODEX_CONFLICT_FILE;
    }
  }, 15_000);

  it("resolves leaf-branch merge conflicts when building km0/<run_id>/final and runs repoTestCommand", async () => {
    const repo = gitRepo();
    process.env.FAKE_CLAUDE_CONFLICT_FILE = "app.txt";
    process.env.FAKE_CODEX_CONFLICT_FILE = "app.txt";
    try {
      const checkBoth = `node -e "const s=require('fs').readFileSync('app.txt','utf8');process.exit(s.includes('claude task 01')&&s.includes('codex task 02')&&!s.includes('<<<<<<<')?0:1)"`;
      const leafRun = start(
        repo,
        [
          task(1, "claude_code", [], has("claude-01.txt")),
          { ...task(2, "codex", [], has("codex-02.txt")), model: "gpt-5.6-luna" },
        ],
        {
          codexCommand: FAKE_CODEX,
          maxConcurrency: 2,
          resolveConflicts: true,
          repoTestCommand: checkBoth,
        },
      );
      expect((await leafRun.run.exited).code).toBe(0);
      const finalBranch = `km0/${leafRun.runId}/final`;
      const mergedApp = execSync(`git show ${finalBranch}:app.txt`, { cwd: repo, encoding: "utf8" });
      expect(mergedApp).toContain("shared line from claude task 01");
      expect(mergedApp).toContain("shared line from codex task 02");
      expect(mergedApp).not.toContain("<<<<<<<");
      const summary = JSON.parse(readFileSync(join(leafRun.runDir, "summary.json"), "utf8"));
      expect(summary.integration).toMatchObject({ branch: finalBranch, status: "ready", testPassed: true });
    } finally {
      delete process.env.FAKE_CLAUDE_CONFLICT_FILE;
      delete process.env.FAKE_CODEX_CONFLICT_FILE;
    }
  }, 15_000);

  it("aborts cleanly and reports conflict status when conflict markers remain unresolved", async () => {
    const repo = gitRepo();
    process.env.FAKE_CLAUDE_CONFLICT_FILE = "app.txt";
    process.env.FAKE_CODEX_CONFLICT_FILE = "app.txt";
    process.env.FAKE_CLAUDE_LEAVE_CONFLICT = "1";
    try {
      const blocked = start(
        repo,
        [
          task(1, "claude_code", [], has("claude-01.txt")),
          { ...task(2, "codex", [], has("codex-02.txt")), model: "gpt-5.6-luna" },
        ],
        { codexCommand: FAKE_CODEX, maxConcurrency: 2, resolveConflicts: true },
      );
      expect((await blocked.run.exited).code).toBe(1);
      const summary = JSON.parse(readFileSync(join(blocked.runDir, "summary.json"), "utf8"));
      expect(summary.integration).toMatchObject({ status: "conflict", commit: null });
      expect(execSync("git status --porcelain", { cwd: repo, encoding: "utf8" })).toBe("");
    } finally {
      delete process.env.FAKE_CLAUDE_CONFLICT_FILE;
      delete process.env.FAKE_CODEX_CONFLICT_FILE;
      delete process.env.FAKE_CLAUDE_LEAVE_CONFLICT;
    }
  }, 15_000);

  it("stops every concurrently running agent cleanly on terminate()", async () => {
    const repo = gitRepo();
    process.env.FAKE_CLAUDE_DELAY_MS = "5000";
    try {
      const { run, runDir } = start(
        repo,
        [task(1, "claude_code", [], null), task(2, "claude_code", [], null), task(3, "claude_code", [1, 2], null)],
        { maxConcurrency: 2 },
      );
      for (let i = 0; i < 200; i += 1) {
        const events = existsSync(join(runDir, "progress.jsonl")) ? progress(runDir) : [];
        if (events.filter((e) => e.event === "task_started").length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      run.terminate();
      expect((await run.exited).code).toBe(3);
      for (const seq of ["01", "02", "03"]) {
        expect(report(runDir, seq)).toMatchObject({ failure_category: "cancelled" });
      }
      expect(readdirSync(join(runDir, "worktrees"))).toEqual([]);
    } finally {
      delete process.env.FAKE_CLAUDE_DELAY_MS;
    }
  });

  it("reuses only succeeded uninvalidated branches, halts when budget is exhausted, and cancels cleanly during judge()", async () => {
    const repo = gitRepo();
    const sharedRoot = mkdtempSync(join(tmpdir(), "km0-reuse-root-"));
    const pkg = packageDir();
    // Run 1: task 1 (passes) -> task 2 (passes); independent task 3 (fails).
    process.env.FAKE_CLAUDE_FAIL = "03";
    try {
      const run1 = new DirectRun({
        runId: "r1",
        runDir: join(sharedRoot, "r1"),
        repo,
        projectId: 7,
        projectTitle: "Demo",
        packageDir: pkg,
        tasks: [task(1, "claude_code", [], null), task(2, "claude_code", [1], null), task(3, "claude_code", [], null)],
        seqs: [],
        reuse: null,
        inboxDir: join(sharedRoot, "dispatch"),
        claudeCommand: FAKE_CLAUDE,
        budget: null,
        language: "en",
        version: "1.2.0",
        onLine: () => undefined,
        pollMs: 20,
      });
      runs.push(run1);
      expect((await run1.exited).code).toBe(1);
    } finally {
      delete process.env.FAKE_CLAUDE_FAIL;
    }

    // Run 2: re-run only task 1 (with task 2 downstream of 1, and task 3 failed in r1). Neither r1/02 nor r1/03 may pollute final.
    const argsFile = join(mkdtempSync(join(tmpdir(), "km0-budget-args-")), "args.jsonl");
    process.env.FAKE_CLAUDE_ARGS = argsFile;
    try {
      const run2 = new DirectRun({
        runId: "r2",
        runDir: join(sharedRoot, "r2"),
        repo,
        projectId: 7,
        projectTitle: "Demo",
        packageDir: pkg,
        tasks: [task(1, "claude_code", [], null), task(2, "claude_code", [1], null), task(3, "claude_code", [], null)],
        seqs: [1],
        reuse: "r1",
        inboxDir: join(sharedRoot, "dispatch"),
        claudeCommand: FAKE_CLAUDE,
        budget: 0.01,
        language: "en",
        version: "1.2.0",
        onLine: () => undefined,
        pollMs: 20,
      });
      runs.push(run2);
      expect((await run2.exited).code).toBe(0);
      const summary2 = JSON.parse(readFileSync(join(sharedRoot, "r2", "summary.json"), "utf8"));
      expect(summary2.integration).toMatchObject({ branch: "km0/r2/final", status: "ready" });
      expect(() =>
        execSync("git show km0/r2/final:claude-03.txt", { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }),
      ).toThrow();
      expect(() =>
        execSync("git show km0/r2/final:claude-02.txt", { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }),
      ).toThrow();
    } finally {
      delete process.env.FAKE_CLAUDE_ARGS;
    }

    // Budget exhaustion stops before spawning task 2; cancellation during judge cancels cleanly.
    const budgetArgs = join(mkdtempSync(join(tmpdir(), "km0-budget2-args-")), "args.jsonl");
    process.env.FAKE_CLAUDE_ARGS = budgetArgs;
    try {
      const budgetRun = start(gitRepo(), [task(1, "claude_code", [], null), task(2, "claude_code", [1], null)], {
        budget: 0.01,
      });
      expect((await budgetRun.run.exited).code).toBe(1);
      expect(report(budgetRun.runDir, "02")).toMatchObject({ failure_category: "budget_exhausted" });
      expect(readFileSync(budgetArgs, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      delete process.env.FAKE_CLAUDE_ARGS;
    }

    let judgeRun!: DirectRun;
    const cancelDuringJudge = start(gitRepo(), [task(1, "claude_code", [], null)], {
      judge: async () => {
        judgeRun.terminate();
        return { accepted: false, reason: "should be ignored on cancel", judgedBy: "test" };
      },
    });
    judgeRun = cancelDuringJudge.run;
    expect((await cancelDuringJudge.run.exited).code).toBe(3);
    expect(report(cancelDuringJudge.runDir, "01")).toMatchObject({ failure_category: "cancelled" });
  }, 15_000);
});

// With KM0_CODEX_REAL=1, the real `codex` on PATH does one small task (it spends a little of the account's quota).
describe.skipIf(!process.env.KM0_CODEX_REAL)("the real Codex", () => {
  it("does a small task in its worktree and KM0 commits it", async () => {
    const repo = gitRepo();
    const model = process.env.KM0_CODEX_MODEL ?? "gpt-5.6-luna";
    const job: DirectTask = {
      ...task(1, "codex", [], has("hello.txt")),
      model,
      modelRef: `km0-1/${model}`,
      prompt: "Create a file named hello.txt in the current folder containing the single line: hello from KM0",
    };
    const codex = (await nodeExec().which("codex")) ?? "codex";
    const { run, runDir } = start(repo, [job], { codexCommand: [codex] });
    expect((await run.exited).code).toBe(0);
    expect(report(runDir, "01")).toMatchObject({
      test_result: { passed: true },
      failure_category: null,
      attempts: [expect.objectContaining({ model: `km0-1/${model}` })],
    });
    expect(Number(report(runDir, "01").steps)).toBeGreaterThan(0);
  }, 300_000);
});

// With KM0_CLAUDE_REAL=1, the real `claude` on PATH does one small task (it spends a little of the account's quota).
describe.skipIf(!process.env.KM0_CLAUDE_REAL)("the real Claude Code", () => {
  it("does a small task in its worktree and KM0 commits it", async () => {
    const repo = gitRepo();
    const job: DirectTask = {
      ...task(1, "claude_code", [], has("hello.txt")),
      model: process.env.KM0_CLAUDE_MODEL ?? "claude-haiku-5-5",
      prompt: "Create a file named hello.txt in the current folder containing the single line: hello from KM0",
    };
    // On Windows npm installs `claude.cmd`, which only a full path reaches; KM0 finds it the same way.
    const claude = (await nodeExec().which("claude")) ?? "claude";
    const { run, runDir } = start(repo, [job], { claudeCommand: [claude] });
    expect((await run.exited).code).toBe(0);
    expect(report(runDir, "01")).toMatchObject({ test_result: { passed: true }, failure_category: null });
    expect(Number(report(runDir, "01").steps)).toBeGreaterThan(0);
  }, 300_000);
});

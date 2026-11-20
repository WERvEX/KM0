import { exec } from "node:child_process";
import { appendFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IntegrationSummary } from "@km0/shared";
import type { RunningProcess } from "../services/exec-port";
import { type AgentOutcome, type AgentRun, runClaudeCode } from "./claude-code";
import { runCodex } from "./codex";
import { AUTHOR, EXCLUDES, GitError, git, gitDiff } from "./git";
import {
  buildHandoffNote,
  formatUpstreamMarkdown,
  formatUpstreamPromptBlock,
  readHandoffNote,
  type TaskHandoffNote,
} from "./handoff-notes";
import { findTask, type InboxTask, putTask, readInbox, removeRun, removeTask, updateTask } from "./inbox";

/**
 * KM0's direct executor: each task goes straight to the agent the plan routed it to, in dependency order. Every
 * task gets a git worktree on its own branch (`km0/<run_id>/<NN>`), started from its upstream tasks' branches
 * and carrying their structured hand-off notes (`km0/upstream.md`). After the agent works there, KM0 commits what
 * it left, runs the task's test command, optionally runs the inline EARS acceptance gate before unlocking
 * downstream tasks, repairs in place with feedback on failure, and climbs the task's escalation chain (including
 * across agents) when needed. The run directory holds the same files KM0 Runner writes (progress.jsonl, reports/,
 * diffs/, summary.json, acceptance.jsonl), plus handoffs/.
 */

/** One executable Agent × Model combination on a task's ladder. */
export interface DirectStep {
  agent: string;
  /** The model ID as the agent takes it, such as `claude-sonnet-5-5`. */
  model: string | null;
  /** The model as reports name it, `km0-<providerId>/<modelId>`, which KM0 matches back on import. */
  modelRef: string | null;
  tier: string | null;
  /** Added to the agent's environment. */
  env: Record<string, string>;
}

export interface DirectTask extends DirectStep {
  seq: number;
  title: string;
  dependsOn: number[];
  /** The task file from the hand-off package. */
  prompt: string;
  testCommand: string | null;
  acceptance: string[];
  /** Stronger or alternate-agent steps to climb when the initial combination fails. */
  escalations?: DirectStep[];
  features?: unknown;
  score?: unknown;
}

export interface InlineJudgeInput {
  task: DirectTask;
  diff: string | null;
  upstream: { seq: number; title: string; diff: string | null }[];
  testResult: { passed: boolean | null; detail: string } | null;
  failure: string | null;
}

export interface InlineJudgeVerdict {
  accepted: boolean;
  reason: string;
  judgedBy: string;
}

export interface DirectRunOptions {
  runId: string;
  runDir: string;
  repo: string;
  projectId: number;
  projectTitle: string;
  /** The hand-off package, copied into each worktree's `km0/` when the repository does not track one. */
  packageDir: string;
  tasks: DirectTask[];
  /** Run only these tasks; the others come from `reuse`'s branches, or the repository as it is. */
  seqs: number[];
  reuse: string | null;
  inboxDir: string;
  claudeCommand: string[] | null;
  /** How to start Codex; null when no task goes to it or it was not found. */
  codexCommand?: string[] | null;
  /** The project budget; the remainder caps each Claude Code run. */
  budget: number | null;
  language: "zh-CN" | "en";
  version: string;
  onLine: (line: string) => void;
  /** How often to look for a Claude Desktop report; tests make it short. */
  pollMs?: number;
  /** Optional inline per-task EARS acceptance gate run before unlocking downstream tasks. */
  judge?: ((input: InlineJudgeInput) => Promise<InlineJudgeVerdict>) | null;
  /** Whether to climb `task.escalations` automatically after a failed repair or error (default: true). */
  autoEscalate?: boolean;
  /** Same-combination in-place feedback repair attempts before escalating (default: 1). */
  maxRepairs?: number;
  /** Max concurrent tasks across independent DAG branches (default: 3; 1 = strict serial). */
  maxConcurrency?: number;
  /** Automatically ask a CLI agent to resolve multi-branch git merge conflicts before blocking (default: true). */
  resolveConflicts?: boolean;
  /** Optional repository-wide test command to verify `km0/<run_id>/final` after merging parallel leaf branches. */
  repoTestCommand?: string | null;
}

type Status = "passed" | "unjudged" | "failed" | "blocked" | "cancelled";
type Category =
  | "tests_failed"
  | "acceptance_rejected"
  | "budget_exhausted"
  | "blocked"
  | "error"
  | "cancelled"
  | "gave_up";

type HandOffOutcome = AgentOutcome & {
  gaveUp?: boolean;
  contracts?: string[];
  downstreamNotes?: string;
};

const EXIT_CANCELLED = 3;
const TEST_TIMEOUT_MS = 15 * 60_000;
const isAutomatedCli = (agent: string) => agent === "claude_code" || agent === "codex";
const CONFLICT_MARKER = /^(<{7}\s|={7}$|>{7}\s)/m;
const TIER_RANK: Record<string, number> = { T3: 3, T2: 2, T1: 1 };

function diffStats(diff: string): { files: number; added: number; removed: number } {
  const stats = { files: 0, added: 0, removed: 0 };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) stats.files += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) stats.added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) stats.removed += 1;
  }
  return stats;
}

const TEXT = {
  "zh-CN": {
    claudeNote: (branch: string) =>
      `你在一个独立的 git worktree 里工作，分支是 \`${branch}\`。按下面的任务完成改动；任务有测试命令时，完成后运行它。不要切换分支，也不要推送。改动可以自己提交；没有提交的改动，KM0 会在你结束后提交到这个分支。项目背景、文档和上游交接（如有 \`km0/upstream.md\`）在 \`km0/\` 文件夹里。`,
    codexNote: (branch: string) =>
      `你在一个独立的 git worktree 里工作，分支是 \`${branch}\`。按下面的任务完成改动；任务有测试命令时，完成后运行它。不要切换分支、提交或推送：你结束后，KM0 会把改动提交到这个分支。项目背景、文档和上游交接（如有 \`km0/upstream.md\`）在 \`km0/\` 文件夹里。`,
    upstreamFailed: (seq: string) => `依赖的任务 ${seq} 没有完成。`,
    conflict: (detail: string) => `合并上游任务的分支时有冲突：${detail}`,
    noAgent: (agent: string) => `直接执行还不能把任务交给 ${agent}。`,
    noClaude: "没有找到 Claude Code。",
    noCodex: "没有找到 Codex。",
    gaveUp: (summary: string) => `Agent 放弃了这个任务：${summary}`,
    testsFailed: "测试没有通过。",
    noRepoCommit: "仓库还没有任何提交：先提交一次，再执行。",
    waiting: (title: string) => `等待 Claude Desktop 领取：${title}`,
    claimed: (title: string) => `Claude Desktop 已领取：${title}`,
    judging: (seq: string) => `正在验收任务 ${seq}…`,
    accepted: (seq: string, reason: string) => `任务 ${seq} 验收通过：${reason}`,
    rejected: (seq: string, reason: string) => `任务 ${seq} 验收未通过：${reason}`,
    judgeError: (seq: string, detail: string) => `任务 ${seq} 即时验收出错（将留待结束后重试）：${detail}`,
    repairing: (seq: string, reason: string) => `任务 ${seq} 原地修补中（原因：${reason}）`,
    escalating: (seq: string, from: string, to: string, reason: string) =>
      `任务 ${seq} 升级：${from} → ${to}（${reason}）`,
    testFeedback: (cmd: string, detail: string) =>
      `测试命令 \`${cmd}\` 未通过，输出末尾如下：\n\`\`\`\n${detail.slice(-2000)}\n\`\`\``,
    acceptanceFeedback: (reason: string) => `规划模型对照验收标准判定未通过，具体原因：\n${reason}`,
    repairPrompt: (feedback: string) =>
      `## KM0_REPAIR：上次提交未通过检查，请在当前 worktree 原地修补\n\n你之前的改动已经提交在当前分支上。请只针对以下问题修补代码与测试，确认通过后结束：\n\n${feedback}`,
    escalationPrompt: (from: string, feedback: string) =>
      `## 前序尝试未通过（${from}），现已升级交由你从干净基线重新完成\n\n前序尝试失败原因（请避免重复同样问题）：\n${feedback}`,
    resolvingConflict: (other: string, files: string, agent: string) =>
      `合并 ${other} 出现冲突（${files}），交由 ${agent} 自动协调解决…`,
    conflictResolved: (other: string) => `已自动解决合并 ${other} 的冲突并完成合并提交。`,
    mergeConflictPrompt: (targetBranch: string, otherBranch: string, files: string[], context: string) =>
      [
        `## KM0_MERGE_CONFLICT：解决多分支合并冲突`,
        ``,
        `当前分支 \`${targetBranch}\` 正在合并 \`${otherBranch}\`，以下文件存在 git 合并冲突：`,
        ...files.map((file) => `- \`${file}\``),
        ...(context ? ["", context] : []),
        ``,
        `请直接编辑上述冲突文件，清除所有 \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` 冲突标记，尽量完整保留两个分支各自实现的功能与契约。不要切换分支、不要中止合并（\`git merge --abort\`），也不要推送。解决完成后直接结束，KM0 会校验无残留标记并完成合并提交。`,
      ].join("\n"),
    integrating: (branch: string, count: number) => `所有任务已完成，正在整合 ${count} 个末端分支到集成分支 ${branch}…`,
    integrationTesting: (branch: string, cmd: string) => `正在集成分支 ${branch} 上运行仓库测试（${cmd}）…`,
    integrationReady: (branch: string) => `集成分支 ${branch} 已就绪，可在执行面板查看总 Diff 并一键合并或检出。`,
    integrationConflict: (other: string, files: string) => `整合最终集成分支时合并 ${other} 存在未解决冲突：${files}`,
    integrationTestsFailed: (cmd: string) => `最终集成分支上的测试命令未通过：${cmd}`,
  },
  en: {
    claudeNote: (branch: string) =>
      `You work in a git worktree of your own, on branch \`${branch}\`. Make the change the task below asks for; when the task has a test command, run it at the end. Do not switch branches or push. You may commit; whatever you leave uncommitted, KM0 commits to this branch when you finish. Project background, documents and upstream notes (if \`km0/upstream.md\` exists) are in \`km0/\`.`,
    codexNote: (branch: string) =>
      `You work in a git worktree of your own, on branch \`${branch}\`. Make the change the task below asks for; when the task has a test command, run it at the end. Do not switch branches, commit or push: when you finish, KM0 commits your changes to this branch. Project background, documents and upstream notes (if \`km0/upstream.md\` exists) are in \`km0/\`.`,
    upstreamFailed: (seq: string) => `Upstream task ${seq} did not finish.`,
    conflict: (detail: string) => `The upstream tasks' branches conflict: ${detail}`,
    noAgent: (agent: string) => `The direct executor cannot hand a task to ${agent} yet.`,
    noClaude: "Claude Code was not found.",
    noCodex: "Codex was not found.",
    gaveUp: (summary: string) => `The agent gave the task up: ${summary}`,
    testsFailed: "The tests do not pass.",
    noRepoCommit: "The repository has no commit yet: commit once, then run.",
    waiting: (title: string) => `Waiting for Claude Desktop to take: ${title}`,
    claimed: (title: string) => `Claude Desktop took: ${title}`,
    judging: (seq: string) => `Judging task ${seq}…`,
    accepted: (seq: string, reason: string) => `Task ${seq} accepted: ${reason}`,
    rejected: (seq: string, reason: string) => `Task ${seq} rejected: ${reason}`,
    judgeError: (seq: string, detail: string) =>
      `Inline judge for task ${seq} failed (will retry after run): ${detail}`,
    repairing: (seq: string, reason: string) => `Repairing task ${seq} in place (${reason})`,
    escalating: (seq: string, from: string, to: string, reason: string) =>
      `Escalating task ${seq}: ${from} → ${to} (${reason})`,
    testFeedback: (cmd: string, detail: string) =>
      `Test command \`${cmd}\` failed. Tail of output:\n\`\`\`\n${detail.slice(-2000)}\n\`\`\``,
    acceptanceFeedback: (reason: string) =>
      `The reviewer rejected this attempt against the acceptance criteria:\n${reason}`,
    repairPrompt: (feedback: string) =>
      `## KM0_REPAIR: Fix the issue in place in this worktree\n\nYour previous changes are already committed on this branch. Fix the problem below, re-run tests if configured, and finish:\n\n${feedback}`,
    escalationPrompt: (from: string, feedback: string) =>
      `## Escalated after an earlier attempt (${from}) failed — starting fresh from the base commit\n\nWhy the previous attempt failed (avoid repeating it):\n${feedback}`,
    resolvingConflict: (other: string, files: string, agent: string) =>
      `Merge conflict with ${other} (${files}); asking ${agent} to resolve…`,
    conflictResolved: (other: string) => `Automatically resolved merge conflict with ${other} and committed the merge.`,
    mergeConflictPrompt: (targetBranch: string, otherBranch: string, files: string[], context: string) =>
      [
        `## KM0_MERGE_CONFLICT: Resolve multi-branch git merge conflict`,
        ``,
        `Branch \`${targetBranch}\` is merging \`${otherBranch}\`. The following files have merge conflicts:`,
        ...files.map((file) => `- \`${file}\``),
        ...(context ? ["", context] : []),
        ``,
        `Edit every conflicted file to remove all \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` markers while preserving both branches' intended changes and contracts. Do not switch branches, run \`git merge --abort\`, or push. Finish once all conflicts are cleanly resolved; KM0 will verify and commit the merge.`,
      ].join("\n"),
    integrating: (branch: string, count: number) =>
      `All tasks finished; integrating ${count} leaf ${count === 1 ? "branch" : "branches"} into ${branch}…`,
    integrationTesting: (branch: string, cmd: string) => `Running repository tests on ${branch} (${cmd})…`,
    integrationReady: (branch: string) =>
      `Integration branch ${branch} is ready: review the full diff and merge or check it out from the Run panel.`,
    integrationConflict: (other: string, files: string) =>
      `Unresolved merge conflict while integrating ${other} into final branch: ${files}`,
    integrationTestsFailed: (cmd: string) => `Repository test command failed on the final integration branch: ${cmd}`,
  },
} as const;

const pad = (seq: number) => String(seq).padStart(2, "0");
const nowIso = () => new Date().toISOString();
const stepLabel = (step: DirectStep) => [step.agent, step.tier, step.model].filter(Boolean).join(" / ");

/** Tasks in an order where every task comes after the tasks it depends on; ties by seq. */
export function dependencyOrder<T extends { seq: number; dependsOn: number[] }>(tasks: T[]): T[] {
  const bySeq = new Map(tasks.map((task) => [task.seq, task]));
  const done = new Set<number>();
  const order: T[] = [];
  const visit = (task: T, path: Set<number>) => {
    if (done.has(task.seq) || path.has(task.seq)) return;
    path.add(task.seq);
    for (const dep of [...task.dependsOn].sort((a, b) => a - b)) {
      const upstream = bySeq.get(dep);
      if (upstream) visit(upstream, path);
    }
    done.add(task.seq);
    order.push(task);
  };
  for (const task of [...tasks].sort((a, b) => a.seq - b.seq)) visit(task, new Set());
  return order;
}

/** Every earlier task `seq` depends on, directly or transitively, sorted by seq. */
function transitiveUpstream(seq: number, tasks: { seq: number; dependsOn: number[] }[]): number[] {
  const found = new Set<number>();
  const visit = (current: number) => {
    for (const dep of tasks.find((item) => item.seq === current)?.dependsOn ?? []) {
      if (!found.has(dep)) {
        found.add(dep);
        visit(dep);
      }
    }
  };
  visit(seq);
  return [...found].sort((a, b) => a - b);
}

/** Run a shell command in `cwd` to its end, with a time limit; its exit code and the tail of its output. */
function runShell(
  command: string,
  cwd: string,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.slice(-4000);
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, output });
      },
    );
  });
}

export class DirectRun implements RunningProcess {
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  private cancelled = false;
  /** Marking this run's inbox tasks cancelled, once a stop was asked for; awaited before they are removed. */
  private cancelling: Promise<void> = Promise.resolve();
  private readonly activeRuns = new Set<AgentRun>();
  private activeTaskCount = 0;
  private seqNo = 0;
  private spent = 0;
  private writes = Promise.resolve();
  private acceptanceWrites = Promise.resolve();
  private repoLock = Promise.resolve();
  private mergeAttemptSeq = 0;
  private readonly text;
  private readonly pollMs;
  private readonly handoffs = new Map<number, TaskHandoffNote>();
  private readonly diffs = new Map<number, string | null>();
  private readonly passedTestCommands = new Map<number, string>();

  constructor(private readonly options: DirectRunOptions) {
    this.text = TEXT[options.language];
    this.pollMs = options.pollMs ?? 1000;
    this.exited = this.main().then(
      (code) => ({ code, signal: null }),
      (error: unknown) => {
        this.options.onLine(error instanceof Error ? error.message : String(error));
        return { code: 2, signal: null };
      },
    );
  }

  terminate(): void {
    this.cancelled = true;
    for (const run of this.activeRuns) run.stop();
    this.cancelling = this.cancelInbox().catch(() => undefined);
  }

  kill(): void {
    this.terminate();
  }

  private withRepoLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.repoLock.then(fn, fn);
    this.repoLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async cancelInbox(): Promise<void> {
    for (const task of await readInbox(this.options.inboxDir)) {
      if (task.runId !== this.options.runId || task.state === "done" || task.state === "cancelled") continue;
      await updateTask(this.options.inboxDir, task.ref, (item) =>
        item.state === "waiting" || item.state === "claimed" ? { ...item, state: "cancelled" } : null,
      ).catch(() => null);
    }
  }

  private emit(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    this.seqNo += 1;
    const line = `${JSON.stringify({ seq: this.seqNo, at: nowIso(), event, ...fields })}\n`;
    const file = join(this.options.runDir, "progress.jsonl");
    this.writes = this.writes.then(() => appendFile(file, line, "utf8"));
    return this.writes;
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const file = join(this.options.runDir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private appendAcceptance(taskId: string, verdict: InlineJudgeVerdict): Promise<void> {
    const line = `${JSON.stringify({
      run_id: this.options.runId,
      task_id: taskId,
      accepted: verdict.accepted,
      reason: verdict.reason,
      judged_by: verdict.judgedBy,
      user_override: null,
      judged_at: nowIso(),
    })}\n`;
    const file = join(this.options.runDir, "acceptance.jsonl");
    this.acceptanceWrites = this.acceptanceWrites.then(() => appendFile(file, line, "utf8"));
    return this.acceptanceWrites;
  }

  private async loadHandoffsFor(seqs: number[]): Promise<TaskHandoffNote[]> {
    const notes: TaskHandoffNote[] = [];
    const reuseDir = this.options.reuse ? join(dirname(this.options.runDir), this.options.reuse) : null;
    for (const dep of [...new Set(seqs)].sort((a, b) => a - b)) {
      const local = this.handoffs.get(dep);
      if (local) {
        notes.push(local);
        continue;
      }
      if (reuseDir) {
        const reused = await readHandoffNote(join(reuseDir, "handoffs", `${pad(dep)}.json`));
        if (reused) notes.push(reused);
      }
    }
    return notes;
  }

  private loadUpstreamHandoffs(task: DirectTask): Promise<TaskHandoffNote[]> {
    return this.loadHandoffsFor(task.dependsOn);
  }

  private async loadUpstreamDiffs(task: DirectTask): Promise<{ seq: number; title: string; diff: string | null }[]> {
    const reuseDir = this.options.reuse ? join(dirname(this.options.runDir), this.options.reuse) : null;
    const seqs = transitiveUpstream(task.seq, this.options.tasks);
    const items: { seq: number; title: string; diff: string | null }[] = [];
    for (const dep of seqs) {
      const title = this.options.tasks.find((item) => item.seq === dep)?.title ?? `#${dep}`;
      if (this.diffs.has(dep)) {
        items.push({ seq: dep, title, diff: this.diffs.get(dep) ?? null });
        continue;
      }
      const reusedDiff = reuseDir
        ? await readFile(join(reuseDir, "diffs", `${pad(dep)}.diff`), "utf8").catch(() => null)
        : null;
      items.push({ seq: dep, title, diff: reusedDiff });
    }
    return items;
  }

  private emptyReport(task: DirectTask) {
    const { options } = this;
    return {
      report_version: 2,
      run_id: options.runId,
      project_id: options.projectId,
      task_id: pad(task.seq),
      source: "km0",
      title: task.title,
      predicted_tier: task.tier,
      predicted_features: task.features ?? null,
      predicted_score: task.score ?? null,
      start_tier: null as string | null,
      explored: false,
      solved_tier: null as string | null,
      escalations: [] as {
        from_tier: string;
        to_tier: string;
        from_agent?: string;
        to_agent?: string;
        signal: string;
        detail: string;
      }[],
      cost: 0,
      steps: 0,
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      wall_time: 0,
      test_command: task.testCommand,
      test_result: null as { passed: boolean | null; judge: string; detail: string } | null,
      failure_category: null as Category | null,
      failure_detail: "",
      handoff: "fresh",
      agent: task.agent,
      branch: null as string | null,
      base_commit: null as string | null,
      commit: null as string | null,
      diff: null as string | null,
      depends_on: task.dependsOn.map(pad),
      acceptance: task.acceptance,
      config_hash: "direct",
      runner_version: `km0-${options.version}`,
      attempts: [] as Record<string, unknown>[],
    };
  }

  private async finishSkipped(task: DirectTask, status: Status, category: Category, detail: string): Promise<Status> {
    const taskId = pad(task.seq);
    const report = this.emptyReport(task);
    report.failure_category = category;
    report.failure_detail = detail;
    await this.writeJson(`reports/${taskId}.json`, report);
    await this.emit("task_finished", { task_id: taskId, status, failure_detail: detail, cost: 0 });
    return status;
  }

  private async main(): Promise<number> {
    const { options } = this;
    await mkdir(options.runDir, { recursive: true });
    const startCommit = await git(options.repo, ["rev-parse", "--verify", "HEAD"], false);
    if (!startCommit) throw new GitError(this.text.noRepoCommit);
    const selected =
      options.seqs.length > 0 ? options.tasks.filter((task) => options.seqs.includes(task.seq)) : options.tasks;
    const order = dependencyOrder(selected);
    const maxConcurrency = Math.max(1, Math.min(6, Math.floor(options.maxConcurrency ?? 3)));
    await this.writeJson("run.json", {
      run_id: options.runId,
      executor: "km0-direct",
      km0_version: options.version,
      repo: options.repo,
      start_commit: startCommit,
      started_at: nowIso(),
      reuse: options.reuse,
      max_concurrency: maxConcurrency,
    });
    await this.emit("run_started", {
      run_id: options.runId,
      tasks: order.map((task) => ({ task_id: pad(task.seq), title: task.title })),
    });

    const results = new Map<number, Status>();
    const branches = new Map<number, string>();
    // Upstream tasks this run does not redo: the branch an earlier run left them on.
    if (options.reuse) {
      for (const task of options.tasks) {
        if (selected.includes(task)) continue;
        const branch = `km0/${options.reuse}/${pad(task.seq)}`;
        if (await git(options.repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], false)) {
          branches.set(task.seq, branch);
        }
      }
    }

    // Dynamic DAG scheduler: independent ready tasks run concurrently up to `maxConcurrency`.
    const selectedSeqs = new Set(selected.map((task) => task.seq));
    const pending = [...order];
    const running = new Map<number, Promise<void>>();
    const settledOk = (status: Status | undefined) => status === "passed" || status === "unjudged";

    while (pending.length > 0 || running.size > 0) {
      if (this.cancelled) {
        for (const task of pending.splice(0)) {
          const status = await this.finishSkipped(task, "cancelled", "cancelled", "");
          results.set(task.seq, status);
        }
        if (running.size > 0) await Promise.all(running.values());
        break;
      }

      // Immediately block any pending tasks whose upstream already failed/blocked/cancelled (transitively).
      let propagated = true;
      while (propagated) {
        propagated = false;
        for (let i = 0; i < pending.length; i += 1) {
          const task = pending[i] as DirectTask;
          const failedDep = [...task.dependsOn]
            .sort((a, b) => a - b)
            .find((dep) => selectedSeqs.has(dep) && results.has(dep) && !settledOk(results.get(dep)));
          if (failedDep !== undefined) {
            pending.splice(i, 1);
            const status = await this.finishSkipped(
              task,
              "blocked",
              "blocked",
              this.text.upstreamFailed(pad(failedDep)),
            );
            results.set(task.seq, status);
            propagated = true;
            break;
          }
        }
      }

      while (running.size < maxConcurrency && !this.cancelled) {
        const index = pending.findIndex((task) =>
          task.dependsOn.every((dep) => !selectedSeqs.has(dep) || settledOk(results.get(dep))),
        );
        if (index < 0) break;
        const [task] = pending.splice(index, 1);
        if (!task) break;
        this.activeTaskCount += 1;
        const promise = this.runTask(task, startCommit, results, branches, selected)
          .then((status) => {
            results.set(task.seq, status);
          })
          .finally(() => {
            this.activeTaskCount -= 1;
            running.delete(task.seq);
          });
        running.set(task.seq, promise);
      }

      if (running.size > 0) {
        await Promise.race(running.values());
      } else if (pending.length > 0) {
        // Guard against cyclic dependencies so the scheduler never deadlocks.
        for (const task of pending.splice(0)) {
          const dep = task.dependsOn.find((item) => selectedSeqs.has(item)) ?? task.seq;
          const status = await this.finishSkipped(task, "blocked", "blocked", this.text.upstreamFailed(pad(dep)));
          results.set(task.seq, status);
        }
      }
    }

    const counts = { passed: 0, unjudged: 0, failed: 0, blocked: 0, cancelled: 0 };
    for (const status of results.values()) counts[status] += 1;

    let integration: IntegrationSummary | null = null;
    if (
      !this.cancelled &&
      counts.failed === 0 &&
      counts.blocked === 0 &&
      counts.cancelled === 0 &&
      results.size > 0 &&
      branches.size > 0
    ) {
      integration = await this.integrateFinal(startCommit, branches);
      await this.emit("integration_finished", { ...integration });
    }

    await this.writeJson("summary.json", {
      run_id: options.runId,
      executor: "km0-direct",
      tasks: results.size,
      ...counts,
      cost: this.spent,
      integration,
    });
    // Nothing of this run stays in the inbox for an agent to take.
    await this.cancelling;
    await removeRun(options.inboxDir, options.runId);
    await this.emit("run_finished", { status: this.cancelled ? "cancelled" : "completed", cost: this.spent });
    await this.acceptanceWrites;
    await this.writes;
    if (this.cancelled) return EXIT_CANCELLED;
    if (counts.failed + counts.blocked > 0) return 1;
    if (integration && integration.status !== "ready") return 1;
    return 0;
  }

  private async prepareKm0Folder(worktree: string, upstreamNotes: TaskHandoffNote[]): Promise<void> {
    if (!(await stat(join(worktree, "km0", "tasks.json")).catch(() => null))) {
      await cp(this.options.packageDir, join(worktree, "km0"), { recursive: true }).catch(() => undefined);
    }
    if (upstreamNotes.length > 0) {
      await mkdir(join(worktree, "km0"), { recursive: true });
      await writeFile(
        join(worktree, "km0", "upstream.md"),
        formatUpstreamMarkdown(upstreamNotes, this.options.language),
        "utf8",
      );
    }
  }

  private async runTask(
    task: DirectTask,
    startCommit: string,
    results: Map<number, Status>,
    branches: Map<number, string>,
    selected: DirectTask[],
  ): Promise<Status> {
    const { options, text } = this;
    const taskId = pad(task.seq);
    const branch = `km0/${options.runId}/${taskId}`;
    const report = this.emptyReport(task);
    const finish = async (status: Status, category: Category | null, detail: string) => {
      report.failure_category = category;
      report.failure_detail = detail;
      await this.writeJson(`reports/${taskId}.json`, report);
      await this.emit("task_finished", { task_id: taskId, status, failure_detail: detail, cost: report.cost });
      return status;
    };

    if (this.cancelled) return finish("cancelled", "cancelled", "");
    // Upstream tasks: in this run they must have finished; outside it, their branch from `reuse` if there is one.
    const upstream: { seq: number; branch: string }[] = [];
    for (const dep of [...task.dependsOn].sort((a, b) => a - b)) {
      const inRun = selected.some((item) => item.seq === dep);
      const result = results.get(dep);
      if (inRun && result !== "passed" && result !== "unjudged")
        return finish("blocked", "blocked", text.upstreamFailed(pad(dep)));
      const upstreamBranch = branches.get(dep);
      if (upstreamBranch) upstream.push({ seq: dep, branch: upstreamBranch });
    }

    const worktree = join(options.runDir, "worktrees", taskId);
    try {
      await this.withRepoLock(() =>
        git(options.repo, ["worktree", "add", "-q", "-b", branch, worktree, upstream[0]?.branch ?? startCommit]),
      );
    } catch (error) {
      return finish("blocked", "error", (error as Error).message);
    }
    const upstreamNotes = await this.loadUpstreamHandoffs(task);
    const initialStep: DirectStep = {
      agent: task.agent,
      model: task.model,
      modelRef: task.modelRef,
      tier: task.tier,
      env: task.env,
    };
    for (const other of upstream.slice(1)) {
      try {
        await git(worktree, [...AUTHOR, "merge", "-q", "--no-edit", other.branch]);
      } catch {
        const resolved = await this.resolveMergeConflict({
          worktree,
          targetBranch: branch,
          otherBranch: other.branch,
          taskId,
          contextNotes: upstreamNotes,
          preferredStep: initialStep,
          report,
        });
        if (!resolved.resolved) {
          await this.discard(worktree, branch);
          if (this.cancelled) return finish("cancelled", "cancelled", "");
          return finish("blocked", "blocked", text.conflict(`${other.branch}: ${resolved.files.join(", ") || "?"}`));
        }
      }
    }

    const upstreamDiffs = options.judge ? await this.loadUpstreamDiffs(task) : [];
    await this.prepareKm0Folder(worktree, upstreamNotes);

    const upstreamBlock = formatUpstreamPromptBlock(upstreamNotes, options.language);
    const basePrompt = upstreamBlock ? `${upstreamBlock}\n\n---\n\n${task.prompt}` : task.prompt;
    const baseCommit = await git(worktree, ["rev-parse", "HEAD"]);
    Object.assign(report, { branch, base_commit: baseCommit, start_tier: task.tier });
    await this.emit("task_started", { task_id: taskId, tier: task.tier, agent: task.agent });

    const steps: DirectStep[] =
      options.autoEscalate === false ? [initialStep] : [initialStep, ...(task.escalations ?? [])];
    const maxRepairs = Math.max(0, options.maxRepairs ?? 1);

    let attemptNo = 0;
    let lastHead = baseCommit;
    let lastDiff: string | null = null;
    let lastOutcome: HandOffOutcome | null = null;
    let lastStep = initialStep;
    let finalVerdict: InlineJudgeVerdict | null = null;
    let finalStatus: Status = "failed";
    let finalCategory: Category | null = "error";
    let finalDetail = "";
    let escalationFrom = "";
    let escalationFeedback = "";

    const recordEscalation = async (from: DirectStep, to: DirectStep, signal: string, reason: string) => {
      const fromTier = from.tier ?? from.agent;
      const toTier = to.tier ?? to.agent;
      const crossAgent = from.agent !== to.agent;
      const detail = crossAgent ? `${from.agent} → ${to.agent}: ${reason}` : reason;
      const entry = {
        from_tier: fromTier,
        to_tier: toTier,
        from_agent: from.agent,
        to_agent: to.agent,
        signal,
        detail,
      };
      report.escalations.push(entry);
      await this.emit("escalation", { task_id: taskId, ...entry });
      options.onLine(text.escalating(taskId, stepLabel(from), stepLabel(to), reason));
    };

    stepLoop: for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex] as DirectStep;
      const nextStep = steps[stepIndex + 1];
      lastStep = step;
      if (stepIndex > 0) {
        // Start an escalated stronger combination cleanly from baseCommit, keeping km0/ intact.
        await git(worktree, ["reset", "--hard", baseCommit], false);
        await git(worktree, ["clean", "-fd", "-e", "km0"], false);
        await this.prepareKm0Folder(worktree, upstreamNotes);
      }

      let repairFeedback = "";
      for (let repair = 0; repair <= maxRepairs; repair += 1) {
        attemptNo += 1;
        const purpose = repair > 0 ? "repair" : stepIndex > 0 ? "escalation" : "task";
        const prompt =
          repair > 0
            ? `${text.repairPrompt(repairFeedback)}\n\n---\n\n${basePrompt}`
            : stepIndex > 0 && escalationFeedback
              ? `${text.escalationPrompt(escalationFrom, escalationFeedback)}\n\n---\n\n${basePrompt}`
              : basePrompt;

        await this.emit("attempt_started", {
          task_id: taskId,
          tier: step.tier,
          model: step.model,
          agent: step.agent,
          purpose,
        });

        const started = Date.now();
        const eventsRel =
          step.agent === "claude_code" || step.agent === "codex"
            ? attemptNo === 1
              ? `events/${taskId}.jsonl`
              : `events/${taskId}-a${attemptNo}.jsonl`
            : null;
        const outcome = await this.handTo(task, step, prompt, worktree, branch, eventsRel);
        const wallTime = (Date.now() - started) / 1000;
        lastOutcome = outcome;

        this.spent += outcome.cost;
        report.cost += outcome.cost;
        report.steps += outcome.steps;
        report.tokens.input += outcome.tokens.input;
        report.tokens.output += outcome.tokens.output;
        report.tokens.cache_read += outcome.tokens.cache_read;
        report.tokens.cache_write += outcome.tokens.cache_write;
        report.wall_time += wallTime;
        await this.emit("attempt_finished", {
          task_id: taskId,
          tier: step.tier,
          model: step.model,
          agent: step.agent,
          cost: outcome.cost,
          steps: outcome.steps,
          stop_reason: outcome.stopReason,
        });

        // Whatever the agent left uncommitted goes onto the task's branch, outside km0/.
        await git(worktree, ["add", "-A", "--", ".", ...EXCLUDES], false);
        if (await git(worktree, ["diff", "--cached", "--name-only"], false)) {
          await git(worktree, [...AUTHOR, "commit", "-q", "--no-verify", "-m", `km0: ${taskId} ${task.title}`], false);
        }
        lastHead = await git(worktree, ["rev-parse", "HEAD"]);
        lastDiff = lastHead !== baseCommit ? await gitDiff(worktree, baseCommit, lastHead) : null;

        let testResult: { passed: boolean | null; judge: string; detail: string } | null = null;
        const settled = outcome.stopReason === "settled" && !outcome.gaveUp;
        if (task.testCommand && settled && !this.cancelled) {
          const run = await runShell(task.testCommand, worktree);
          testResult = { passed: run.code === 0, judge: "test_command", detail: run.output };
          report.test_result = testResult;
          await this.emit("test_result", {
            task_id: taskId,
            passed: testResult.passed,
            detail: run.output.slice(-500),
          });
        }

        const attemptRecord: Record<string, unknown> = {
          purpose,
          tier: step.tier ?? "T1",
          model: step.modelRef ?? step.model ?? step.agent,
          agent: step.agent,
          steps: outcome.steps,
          tokens: outcome.tokens,
          cost: outcome.cost,
          wall_time: wallTime,
          stop_reason: outcome.stopReason,
          test_result: testResult,
          events: eventsRel,
        };
        report.attempts.push(attemptRecord);

        if (outcome.stopReason === "cancelled" || this.cancelled) {
          finalStatus = "cancelled";
          finalCategory = "cancelled";
          finalDetail = "";
          break stepLoop;
        }
        if (outcome.stopReason === "cost_budget") {
          finalStatus = "failed";
          finalCategory = "budget_exhausted";
          finalDetail = outcome.detail;
          break stepLoop;
        }
        if (outcome.stopReason === "error" || outcome.gaveUp) {
          const reason = outcome.gaveUp ? text.gaveUp(outcome.detail) : outcome.detail;
          if (nextStep) {
            await recordEscalation(step, nextStep, outcome.gaveUp ? "gave_up" : "error", reason);
            escalationFrom = stepLabel(step);
            escalationFeedback = reason;
            break;
          }
          finalStatus = "failed";
          finalCategory = outcome.gaveUp ? "gave_up" : "error";
          finalDetail = reason;
          break stepLoop;
        }

        if (testResult?.passed === false) {
          const feedback = text.testFeedback(task.testCommand ?? "", testResult.detail);
          if (repair < maxRepairs && isAutomatedCli(step.agent)) {
            options.onLine(text.repairing(taskId, text.testsFailed));
            repairFeedback = feedback;
            continue;
          }
          if (nextStep) {
            await recordEscalation(step, nextStep, "tests_failed", text.testsFailed);
            escalationFrom = stepLabel(step);
            escalationFeedback = feedback;
            break;
          }
          finalStatus = "failed";
          finalCategory = "tests_failed";
          finalDetail = text.testsFailed;
          break stepLoop;
        }

        // Tests passed (or no test command): run the inline EARS acceptance gate when configured.
        if (options.judge) {
          options.onLine(text.judging(taskId));
          let verdict: InlineJudgeVerdict | null = null;
          try {
            verdict = await options.judge({
              task,
              diff: lastDiff,
              upstream: upstreamDiffs,
              testResult,
              failure: null,
            });
          } catch (error) {
            options.onLine(text.judgeError(taskId, error instanceof Error ? error.message : String(error)));
          }
          if (verdict) {
            attemptRecord.verdict = { accepted: verdict.accepted, reason: verdict.reason };
            await this.emit("task_judged", {
              task_id: taskId,
              accepted: verdict.accepted,
              reason: verdict.reason,
              judged_by: verdict.judgedBy,
            });
            if (verdict.accepted) {
              options.onLine(text.accepted(taskId, verdict.reason));
              finalVerdict = verdict;
              report.solved_tier = step.tier;
              finalStatus = "passed";
              finalCategory = null;
              finalDetail = "";
              break stepLoop;
            }
            options.onLine(text.rejected(taskId, verdict.reason));
            const feedback = text.acceptanceFeedback(verdict.reason);
            if (repair < maxRepairs && isAutomatedCli(step.agent)) {
              options.onLine(text.repairing(taskId, verdict.reason));
              repairFeedback = feedback;
              continue;
            }
            if (nextStep) {
              await recordEscalation(step, nextStep, "acceptance_rejected", verdict.reason);
              escalationFrom = stepLabel(step);
              escalationFeedback = feedback;
              break;
            }
            finalVerdict = verdict;
            finalStatus = "failed";
            finalCategory = "acceptance_rejected";
            finalDetail = verdict.reason;
            break stepLoop;
          }
        }

        if (testResult?.passed) report.solved_tier = step.tier;
        finalStatus = testResult?.passed ? "passed" : "unjudged";
        finalCategory = null;
        finalDetail = "";
        break stepLoop;
      }
    }

    report.agent = lastStep.agent;
    if (lastHead !== baseCommit && lastDiff !== null) {
      report.commit = lastHead;
      report.diff = `diffs/${taskId}.diff`;
      const diffFile = join(options.runDir, "diffs", `${taskId}.diff`);
      await mkdir(dirname(diffFile), { recursive: true });
      await writeFile(diffFile, lastDiff, "utf8");
    }
    this.diffs.set(task.seq, lastDiff);
    branches.set(task.seq, branch);

    if (finalStatus === "passed" || finalStatus === "unjudged") {
      if (task.testCommand && report.test_result?.passed === true) {
        this.passedTestCommands.set(task.seq, task.testCommand);
      }
      const changedRaw =
        lastHead !== baseCommit ? await git(worktree, ["diff", "--name-only", baseCommit, lastHead], false) : "";
      const note = buildHandoffNote({
        taskId,
        seq: task.seq,
        title: task.title,
        agent: lastStep.agent,
        model: lastStep.model,
        branch,
        commit: report.commit,
        changedFiles: changedRaw.split(/\r?\n/).filter(Boolean),
        diff: lastDiff,
        agentText: lastOutcome?.detail ?? "",
        explicitContracts: lastOutcome?.contracts,
        explicitNotes: lastOutcome?.downstreamNotes,
        verdict: finalVerdict ? { accepted: finalVerdict.accepted, reason: finalVerdict.reason } : null,
      });
      this.handoffs.set(task.seq, note);
      await this.writeJson(`handoffs/${taskId}.json`, note);
    }

    if (finalVerdict) await this.appendAcceptance(taskId, finalVerdict);
    await this.removeWorktree(worktree);
    return finish(finalStatus, finalCategory, finalDetail);
  }

  /** Choose the strongest available automated CLI step to resolve a multi-branch git merge conflict. */
  private pickConflictCoordinator(preferred?: DirectStep): DirectStep | null {
    const { options } = this;
    const hasCli = (agent: string) =>
      (agent === "claude_code" && Boolean(options.claudeCommand)) ||
      (agent === "codex" && Boolean(options.codexCommand));
    if (preferred && isAutomatedCli(preferred.agent) && hasCli(preferred.agent)) return preferred;

    const candidates: DirectStep[] = [];
    for (const task of options.tasks) {
      const steps: DirectStep[] = [
        { agent: task.agent, model: task.model, modelRef: task.modelRef, tier: task.tier, env: task.env },
        ...(task.escalations ?? []),
      ];
      for (const step of steps) {
        if (isAutomatedCli(step.agent) && hasCli(step.agent)) candidates.push(step);
      }
    }
    if (candidates.length > 0) {
      candidates.sort(
        (a, b) =>
          (TIER_RANK[b.tier ?? ""] ?? 0) - (TIER_RANK[a.tier ?? ""] ?? 0) ||
          (b.agent === "claude_code" ? 1 : 0) - (a.agent === "claude_code" ? 1 : 0),
      );
      return candidates[0] ?? null;
    }
    if (options.claudeCommand) {
      return { agent: "claude_code", model: null, modelRef: null, tier: null, env: {} };
    }
    if (options.codexCommand) {
      return { agent: "codex", model: null, modelRef: null, tier: null, env: {} };
    }
    return null;
  }

  /** Hand a multi-branch git merge conflict to an automated CLI coordinator, verify no markers remain, and commit. */
  private async resolveMergeConflict({
    worktree,
    targetBranch,
    otherBranch,
    taskId,
    contextNotes,
    preferredStep,
    report,
  }: {
    worktree: string;
    targetBranch: string;
    otherBranch: string;
    taskId: string | null;
    contextNotes: TaskHandoffNote[];
    preferredStep?: DirectStep;
    report?: ReturnType<DirectRun["emptyReport"]>;
  }): Promise<{ resolved: boolean; files: string[] }> {
    const { options, text } = this;
    const rawFiles = await git(worktree, ["diff", "--name-only", "--diff-filter=U"], false);
    const files = rawFiles
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const coord =
      options.resolveConflicts !== false && !this.cancelled && files.length > 0
        ? this.pickConflictCoordinator(preferredStep)
        : null;
    if (!coord) {
      await git(worktree, ["merge", "--abort"], false);
      return { resolved: false, files };
    }

    await this.prepareKm0Folder(worktree, contextNotes);
    const context = formatUpstreamPromptBlock(contextNotes, options.language);
    const prompt = text.mergeConflictPrompt(targetBranch, otherBranch, files, context);
    this.mergeAttemptSeq += 1;
    const eventsRel = `events/${taskId ?? "final"}-merge-${this.mergeAttemptSeq}.jsonl`;

    options.onLine(text.resolvingConflict(otherBranch, files.join(", "), stepLabel(coord)));
    await this.emit("attempt_started", {
      ...(taskId ? { task_id: taskId } : {}),
      tier: coord.tier,
      model: coord.model,
      agent: coord.agent,
      purpose: "merge",
    });

    const started = Date.now();
    const outcome = await this.runCliStep(coord, prompt, worktree, targetBranch, eventsRel);
    const wallTime = (Date.now() - started) / 1000;

    this.spent += outcome.cost;
    if (report) {
      report.cost += outcome.cost;
      report.steps += outcome.steps;
      report.tokens.input += outcome.tokens.input;
      report.tokens.output += outcome.tokens.output;
      report.tokens.cache_read += outcome.tokens.cache_read;
      report.tokens.cache_write += outcome.tokens.cache_write;
      report.wall_time += wallTime;
      report.attempts.push({
        purpose: "merge",
        tier: coord.tier ?? "T2",
        model: coord.modelRef ?? coord.model ?? coord.agent,
        agent: coord.agent,
        steps: outcome.steps,
        tokens: outcome.tokens,
        cost: outcome.cost,
        wall_time: wallTime,
        stop_reason: outcome.stopReason,
        test_result: null,
        events: eventsRel,
      });
    }
    await this.emit("attempt_finished", {
      ...(taskId ? { task_id: taskId } : {}),
      tier: coord.tier,
      model: coord.model,
      agent: coord.agent,
      purpose: "merge",
      cost: outcome.cost,
      steps: outcome.steps,
      stop_reason: outcome.stopReason,
    });

    if (outcome.stopReason !== "settled" || this.cancelled) {
      await git(worktree, ["merge", "--abort"], false);
      return { resolved: false, files };
    }

    // Verify no conflict markers remain in any previously conflicted file.
    for (const rel of files) {
      const content = await readFile(join(worktree, rel), "utf8").catch(() => null);
      if (content !== null && CONFLICT_MARKER.test(content)) {
        await git(worktree, ["merge", "--abort"], false);
        return { resolved: false, files };
      }
    }

    const merging = await git(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], false);
    if (merging) {
      await git(worktree, ["add", "-A", "--", ".", ...EXCLUDES], false);
      const unmerged = await git(worktree, ["diff", "--name-only", "--diff-filter=U"], false);
      if (unmerged.trim()) {
        await git(worktree, ["merge", "--abort"], false);
        return { resolved: false, files };
      }
      try {
        await git(worktree, [...AUTHOR, "commit", "-q", "--no-verify", "--no-edit"]);
      } catch {
        await git(worktree, ["merge", "--abort"], false);
        return { resolved: false, files };
      }
    } else {
      // If the agent committed the merge itself, verify the incoming branch is now an ancestor of HEAD.
      try {
        await git(worktree, ["merge-base", "--is-ancestor", otherBranch, "HEAD"]);
      } catch {
        return { resolved: false, files };
      }
    }

    options.onLine(text.conflictResolved(otherBranch));
    return { resolved: true, files };
  }

  /** Combine all parallel leaf task branches into `km0/<run_id>/final`, write `diffs/final.diff`, and run tests. */
  private async integrateFinal(startCommit: string, branches: Map<number, string>): Promise<IntegrationSummary> {
    const { options, text } = this;
    const finalBranch = `km0/${options.runId}/final`;
    const allSeqs = [...branches.keys()].sort((a, b) => a - b);
    const dependedOn = new Set<number>();
    for (const seq of allSeqs) {
      const task = options.tasks.find((item) => item.seq === seq);
      for (const dep of task?.dependsOn ?? []) {
        if (branches.has(dep)) dependedOn.add(dep);
      }
    }
    const leaves = allSeqs.filter((seq) => !dependedOn.has(seq));
    const leafSeqs = leaves.length > 0 ? leaves : [allSeqs[allSeqs.length - 1] as number];
    const firstSeq = leafSeqs[0] as number;
    const firstBranch = branches.get(firstSeq) as string;

    options.onLine(text.integrating(finalBranch, leafSeqs.length));
    const needsTests =
      Boolean(options.repoTestCommand) &&
      !this.cancelled &&
      !(leafSeqs.length === 1 && this.passedTestCommands.get(firstSeq) === options.repoTestCommand);

    // Fast path: single leaf branch and no extra repo-wide test run needed — point `final` directly without a worktree.
    if (leafSeqs.length === 1 && !needsTests) {
      try {
        await this.withRepoLock(() => git(options.repo, ["branch", "-f", finalBranch, firstBranch]));
      } catch (error) {
        return {
          branch: finalBranch,
          status: "error",
          commit: null,
          files: 0,
          added: 0,
          removed: 0,
          testPassed: null,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      const finalHead = await git(options.repo, ["rev-parse", finalBranch]);
      const fullDiff = finalHead !== startCommit ? await gitDiff(options.repo, startCommit, finalHead) : "";
      const diffFile = join(options.runDir, "diffs", "final.diff");
      await mkdir(dirname(diffFile), { recursive: true });
      await writeFile(diffFile, fullDiff, "utf8");
      const stats = diffStats(fullDiff);
      const testPassed =
        options.repoTestCommand && this.passedTestCommands.get(firstSeq) === options.repoTestCommand ? true : null;
      options.onLine(text.integrationReady(finalBranch));
      return {
        branch: finalBranch,
        status: "ready",
        commit: finalHead,
        files: stats.files,
        added: stats.added,
        removed: stats.removed,
        testPassed,
        detail: "",
      };
    }

    const worktree = join(options.runDir, "worktrees", "final");
    try {
      await this.withRepoLock(() =>
        git(options.repo, ["worktree", "add", "-q", "-b", finalBranch, worktree, firstBranch]),
      );
    } catch (error) {
      return {
        branch: finalBranch,
        status: "error",
        commit: null,
        files: 0,
        added: 0,
        removed: 0,
        testPassed: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const integratedSeqs = [firstSeq];
    for (const seq of leafSeqs.slice(1)) {
      const otherBranch = branches.get(seq) as string;
      try {
        await git(worktree, [...AUTHOR, "merge", "-q", "--no-edit", otherBranch]);
      } catch {
        const contextNotes = await this.loadHandoffsFor([...integratedSeqs, seq]);
        const resolved = await this.resolveMergeConflict({
          worktree,
          targetBranch: finalBranch,
          otherBranch,
          taskId: null,
          contextNotes,
        });
        if (!resolved.resolved) {
          await this.discard(worktree, finalBranch);
          return {
            branch: finalBranch,
            status: "conflict",
            commit: null,
            files: 0,
            added: 0,
            removed: 0,
            testPassed: null,
            detail: text.integrationConflict(otherBranch, resolved.files.join(", ") || "?"),
          };
        }
      }
      integratedSeqs.push(seq);
    }

    const finalHead = await git(worktree, ["rev-parse", "HEAD"]);
    const fullDiff = finalHead !== startCommit ? await gitDiff(worktree, startCommit, finalHead) : "";
    const diffFile = join(options.runDir, "diffs", "final.diff");
    await mkdir(dirname(diffFile), { recursive: true });
    await writeFile(diffFile, fullDiff, "utf8");
    const stats = diffStats(fullDiff);

    let testPassed: boolean | null = null;
    let detail = "";
    if (options.repoTestCommand && !this.cancelled) {
      if (leafSeqs.length === 1 && this.passedTestCommands.get(firstSeq) === options.repoTestCommand) {
        testPassed = true;
      } else {
        options.onLine(text.integrationTesting(finalBranch, options.repoTestCommand));
        const run = await runShell(options.repoTestCommand, worktree);
        testPassed = run.code === 0;
        if (!testPassed) detail = run.output.slice(-1000) || text.integrationTestsFailed(options.repoTestCommand);
      }
    }

    await this.removeWorktree(worktree);
    if (testPassed !== false) options.onLine(text.integrationReady(finalBranch));
    return {
      branch: finalBranch,
      status: testPassed === false ? "tests_failed" : "ready",
      commit: finalHead,
      files: stats.files,
      added: stats.added,
      removed: stats.removed,
      testPassed,
      detail,
    };
  }

  /** Run an automated CLI agent (Claude Code or Codex) in a worktree and track it for cancellation. */
  private async runCliStep(
    step: DirectStep,
    prompt: string,
    worktree: string,
    branch: string,
    eventsRel: string,
  ): Promise<HandOffOutcome> {
    const { options, text } = this;
    const base = { steps: 0, cost: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 } };
    if (this.cancelled) return { ...base, stopReason: "cancelled", detail: "" };
    const failed = (detail: string): HandOffOutcome => ({ ...base, stopReason: "error", detail });

    if (step.agent === "claude_code") {
      if (!options.claudeCommand) return failed(text.noClaude);
      const slots = Math.max(this.activeTaskCount, 1);
      const left = options.budget !== null ? Math.max((options.budget - this.spent) / slots, 0.01) : null;
      const eventsFile = join(options.runDir, eventsRel);
      await mkdir(dirname(eventsFile), { recursive: true });
      if (this.cancelled) return { ...base, stopReason: "cancelled", detail: "" };
      const agentRun = runClaudeCode({
        command: options.claudeCommand,
        cwd: worktree,
        prompt: `${text.claudeNote(branch)}\n\n---\n\n${prompt}`,
        model: step.model,
        env: step.env,
        maxBudgetUsd: left,
        eventsFile,
        onLine: options.onLine,
      });
      this.activeRuns.add(agentRun);
      try {
        return await agentRun.outcome;
      } finally {
        this.activeRuns.delete(agentRun);
      }
    }
    if (step.agent === "codex") {
      if (!options.codexCommand) return failed(text.noCodex);
      const eventsFile = join(options.runDir, eventsRel);
      await mkdir(dirname(eventsFile), { recursive: true });
      if (this.cancelled) return { ...base, stopReason: "cancelled", detail: "" };
      const agentRun = runCodex({
        command: options.codexCommand,
        cwd: worktree,
        prompt: `${text.codexNote(branch)}\n\n---\n\n${prompt}`,
        model: step.model,
        env: step.env,
        eventsFile,
        onLine: options.onLine,
      });
      this.activeRuns.add(agentRun);
      try {
        return await agentRun.outcome;
      } finally {
        this.activeRuns.delete(agentRun);
      }
    }
    return failed(text.noAgent(step.agent));
  }

  /** Give the task to one step's agent and wait for it to finish. */
  private async handTo(
    task: DirectTask,
    step: DirectStep,
    prompt: string,
    worktree: string,
    branch: string,
    eventsRel: string | null,
  ): Promise<HandOffOutcome> {
    if (step.agent === "claude_code" || step.agent === "codex") {
      return this.runCliStep(step, prompt, worktree, branch, eventsRel ?? `events/${pad(task.seq)}.jsonl`);
    }
    if (step.agent === "claude_desktop") return this.waitForDesktop(task, step, prompt, worktree, branch);
    return {
      stopReason: "error",
      steps: 0,
      cost: 0,
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      detail: this.text.noAgent(step.agent),
    };
  }

  /** Put the task in the inbox for Claude Desktop and wait until it reports, or the run is cancelled. */
  private async waitForDesktop(
    task: DirectTask,
    step: DirectStep,
    prompt: string,
    worktree: string,
    branch: string,
  ): Promise<HandOffOutcome> {
    const { options, text } = this;
    const ref = `${options.runId}/${pad(task.seq)}`;
    const entry: InboxTask = {
      version: 1,
      ref,
      runId: options.runId,
      taskId: pad(task.seq),
      seq: task.seq,
      title: task.title,
      projectTitle: options.projectTitle,
      agent: step.agent,
      model: step.model,
      worktree,
      branch,
      prompt,
      testCommand: task.testCommand,
      acceptance: task.acceptance,
      language: options.language,
      state: "waiting",
      createdAt: nowIso(),
      claimedAt: null,
      report: null,
    };
    await putTask(options.inboxDir, entry);
    await this.emit("task_waiting", { task_id: entry.taskId, agent: step.agent });
    options.onLine(text.waiting(task.title));
    let claimed = false;
    const base = { steps: 0, cost: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 } };
    try {
      for (;;) {
        if (this.cancelled) return { ...base, stopReason: "cancelled", detail: "" };
        const current = await findTask(options.inboxDir, ref);
        if (!current || current.state === "cancelled") return { ...base, stopReason: "cancelled", detail: "" };
        if (current.state === "claimed" && !claimed) {
          claimed = true;
          await this.emit("task_claimed", { task_id: entry.taskId, agent: step.agent });
          options.onLine(text.claimed(task.title));
        }
        if (current.state === "done" && current.report) {
          const gaveUp = current.report.status === "gave_up";
          return {
            ...base,
            stopReason: "settled",
            detail: current.report.summary,
            gaveUp,
            contracts: current.report.contracts,
            downstreamNotes: current.report.downstreamNotes,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      }
    } finally {
      // A stop marks the task cancelled in the inbox; let that finish first, or it would write the file back.
      await this.cancelling;
      await removeTask(options.inboxDir, ref);
    }
  }

  private removeWorktree(worktree: string): Promise<void> {
    return this.withRepoLock(async () => {
      await git(this.options.repo, ["worktree", "remove", "--force", worktree], false);
      await rm(worktree, { recursive: true, force: true });
      await git(this.options.repo, ["worktree", "prune"], false);
    });
  }

  /** Drop the worktree and its branch: the task never started. */
  private async discard(worktree: string, branch: string): Promise<void> {
    await this.removeWorktree(worktree);
    await this.withRepoLock(() => git(this.options.repo, ["branch", "-q", "-D", branch], false));
  }
}

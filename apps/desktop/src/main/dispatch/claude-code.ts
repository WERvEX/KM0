import { type ChildProcess, spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";

/** How one agent's go at a task ended, in KM0 Runner's terms. */
export interface AgentOutcome {
  stopReason: "settled" | "cost_budget" | "error" | "cancelled";
  /** Tool calls the agent made. */
  steps: number;
  cost: number;
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
  /** Why it did not settle, or the agent's last words when it did. */
  detail: string;
}

export interface AgentRun {
  outcome: Promise<AgentOutcome>;
  /** Stop it: the run is being cancelled. */
  stop(): void;
}

export interface ClaudeCodeOptions {
  /** How to start Claude Code, such as `["/usr/local/bin/claude"]`. */
  command: string[];
  cwd: string;
  prompt: string;
  /** Claude Code's model ID, such as `claude-sonnet-5-5`; null leaves Claude Code's own choice. */
  model: string | null;
  /** Added to KM0's environment: ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL when the provider has them. */
  env: Record<string, string>;
  /** `--max-budget-usd`; null for no limit. */
  maxBudgetUsd: number | null;
  /** Where to keep Claude Code's event stream. */
  eventsFile: string;
  onLine: (line: string) => void;
}

/**
 * What Claude Code may do without asking: edit (accepted by `acceptEdits`), read, search and run commands. On Windows
 * Claude Code may run commands with PowerShell instead of Bash; without it here every command is refused.
 */
export const ALLOWED_TOOLS = [
  "Bash",
  "PowerShell",
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Glob",
  "Grep",
  "LS",
  "TodoWrite",
];

export function claudeCodeArgs(model: string | null, maxBudgetUsd: number | null): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    ...(model ? ["--model", model] : []),
    ...(maxBudgetUsd !== null ? ["--max-budget-usd", maxBudgetUsd.toFixed(2)] : []),
    // Last: it takes every argument after it.
    "--allowedTools",
    ...ALLOWED_TOOLS,
  ];
}

/** A short line for the run's log about one tool call: `Edit src/app.ts`, paths relative to the worktree. */
function describeTool(block: { name?: unknown; input?: unknown }, cwd: string): string {
  const input = (block.input ?? {}) as Record<string, unknown>;
  // A search says more by what it looks for than by where (often the worktree itself).
  const target = input.file_path ?? input.pattern ?? input.command ?? input.path ?? "";
  const line = relativeTo(cwd, String(target).split("\n")[0] ?? "");
  return `${String(block.name ?? "tool")} ${line.slice(0, 160)}`.trim();
}

/** A line of the run's log with the worktree's own path left out: `src/app.ts`, or `.` for the worktree itself. */
export function relativeTo(cwd: string, line: string): string {
  if (!cwd) return line;
  return line === cwd ? "." : line.replaceAll(`${cwd}/`, "").replaceAll(`${cwd}\\`, "");
}

/** Fold Claude Code's stream-json events into an outcome; `result` ends the run. */
export class StreamState implements EventStream {
  /** `cwd`: the task's worktree, left out of the paths in the log. */
  constructor(private readonly cwd = "") {}

  steps = 0;
  result: AgentOutcome | null = null;
  lastText = "";

  /** One line of output; returns what to show in the run's log, if anything. */
  take(line: string): string | null {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return line.trim() ? line : null;
    }
    if (event.type === "assistant") {
      const content = ((event.message as { content?: unknown[] } | undefined)?.content ?? []) as {
        type?: string;
        text?: string;
        name?: unknown;
        input?: unknown;
      }[];
      const shown: string[] = [];
      for (const block of content) {
        if (block.type === "tool_use") {
          this.steps += 1;
          shown.push(`→ ${describeTool(block, this.cwd)}`);
        } else if (block.type === "text" && block.text) this.lastText = block.text;
      }
      return shown.length > 0 ? shown.join("\n") : null;
    }
    if (event.type === "result") {
      const usage = (event.usage ?? {}) as Record<string, number | undefined>;
      const subtype = String(event.subtype ?? "");
      const failed = event.is_error === true || subtype !== "success";
      this.result = {
        stopReason: !failed ? "settled" : /budget/.test(subtype) ? "cost_budget" : "error",
        steps: this.steps,
        cost: Number(event.total_cost_usd) || 0,
        tokens: {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cache_read: usage.cache_read_input_tokens ?? 0,
          cache_write: usage.cache_creation_input_tokens ?? 0,
        },
        detail: String(event.result ?? (failed ? subtype : this.lastText)).slice(0, 2000),
      };
      // An error such as "Not logged in" still comes as subtype "success", with is_error set and the reason in `result`.
      const why = subtype && subtype !== "success" ? subtype : String(event.result ?? "error").split("\n")[0];
      return failed ? `Claude Code: ${why}` : null;
    }
    return null;
  }
}

/** End the process and what it started: its group on Linux and macOS, its tree on Windows. */
function endTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

const quoteForCmd = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Folds an agent's JSON-lines output into an outcome; `result` is set once the agent says how it ended. */
export interface EventStream {
  steps: number;
  result: AgentOutcome | null;
  /** One line of output; returns what to show in the run's log, if anything. */
  take(line: string): string | null;
}

export interface AgentProcessOptions {
  /** How to start the agent, such as `["claude"]`; the agent's own arguments follow. */
  command: string[];
  args: string[];
  cwd: string;
  prompt: string;
  env: Record<string, string>;
  /** Where to keep the agent's event stream. */
  eventsFile: string;
  onLine: (line: string) => void;
  stream: EventStream;
  /** The agent's name, for an exit without an outcome. */
  name: string;
}

/** Run a coding agent's CLI on one task in its worktree: the prompt goes in on stdin, JSON lines come out. */
export function runAgentProcess(options: AgentProcessOptions): AgentRun {
  const [program = "", ...rest] = options.command;
  const args = [...rest, ...options.args];
  // Node will not start a .cmd or .bat without a shell (npm installs `claude.cmd` and `codex.cmd` on Windows).
  const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(program);
  const child = viaShell
    ? spawn([program, ...args].map(quoteForCmd).join(" "), {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        shell: true,
        windowsHide: true,
      })
    : spawn(program, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        detached: process.platform !== "win32",
        windowsHide: true,
      });
  const state = options.stream;
  let stopped = false;
  let writes = Promise.resolve();
  let buffer = "";
  const errors: string[] = [];
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) handle(line);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
      errors.push(line);
      if (errors.length > 20) errors.shift();
      options.onLine(line.slice(0, 4000));
    }
  });
  function handle(line: string) {
    if (!line.trim()) return;
    const file = options.eventsFile;
    writes = writes.then(() => appendFile(file, `${line}\n`, "utf8")).catch(() => undefined);
    const shown = state.take(line);
    if (shown) for (const part of shown.split("\n")) options.onLine(part.slice(0, 4000));
  }
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(options.prompt, "utf8");

  const outcome = new Promise<AgentOutcome>((resolve) => {
    const finish = (code: number | null, problem?: string) => {
      if (buffer) handle(buffer);
      buffer = "";
      void writes.then(() => {
        if (stopped) {
          resolve({ ...(state.result ?? empty(state.steps)), stopReason: "cancelled", detail: "" });
        } else if (state.result) resolve(state.result);
        else {
          const why = problem ?? (errors.join("\n").trim() || `${options.name} exited with code ${code ?? "none"}`);
          resolve({ ...empty(state.steps), stopReason: "error", detail: why.slice(-2000) });
        }
      });
    };
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });
  return {
    outcome,
    stop() {
      stopped = true;
      endTree(child);
    },
  };
}

/** Run Claude Code non-interactively on one task in its worktree; the prompt goes in on stdin. */
export function runClaudeCode(options: ClaudeCodeOptions): AgentRun {
  return runAgentProcess({
    command: options.command.length > 0 ? options.command : ["claude"],
    args: claudeCodeArgs(options.model, options.maxBudgetUsd),
    cwd: options.cwd,
    prompt: options.prompt,
    env: options.env,
    eventsFile: options.eventsFile,
    onLine: options.onLine,
    stream: new StreamState(options.cwd),
    name: "Claude Code",
  });
}

export const empty = (steps: number): AgentOutcome => ({
  stopReason: "error",
  steps,
  cost: 0,
  tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  detail: "",
});

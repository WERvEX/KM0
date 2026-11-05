import { type AgentOutcome, type AgentRun, type EventStream, empty, relativeTo, runAgentProcess } from "./claude-code";

export interface CodexOptions {
  /** How to start Codex, such as `["/usr/local/bin/codex"]`. */
  command: string[];
  cwd: string;
  prompt: string;
  /** Codex's model ID, such as `gpt-5.6-luna`; null leaves Codex's own choice. */
  model: string | null;
  /** Added to KM0's environment. */
  env: Record<string, string>;
  /** Where to keep Codex's event stream. */
  eventsFile: string;
  onLine: (line: string) => void;
}

/**
 * `codex exec` reading the prompt from stdin, printing JSON lines, and allowed to write only inside the worktree.
 * The worktree's git metadata lies outside it, so Codex cannot commit; KM0 commits what it leaves.
 */
export function codexArgs(model: string | null): string[] {
  return ["exec", "--json", "--sandbox", "workspace-write", ...(model ? ["--model", model] : []), "-"];
}

interface CodexItem {
  type?: string;
  text?: string;
  command?: string;
  changes?: { path?: string; kind?: string }[];
  server?: string;
  tool?: string;
  query?: string;
}

/** A short line for the run's log about one action: `Shell npm test`, `Edit src/app.ts`. */
function describeItem(item: CodexItem): string | null {
  switch (item.type) {
    case "command_execution":
      return `Shell ${String(item.command ?? "")
        .split("\n")[0]
        ?.slice(0, 160)}`;
    case "file_change":
      return (item.changes ?? [])
        .map((change) => `${change.kind === "add" ? "Write" : "Edit"} ${change.path}`)
        .join("\n");
    case "mcp_tool_call":
      return `MCP ${item.server ?? ""}/${item.tool ?? ""}`;
    case "web_search":
      return `Search ${item.query ?? ""}`;
    default:
      return null;
  }
}

/** Fold `codex exec --json` events into an outcome; `turn.completed` or a failure ends the run. */
export class CodexStream implements EventStream {
  /** `cwd`: the task's worktree, left out of the paths in the log. */
  constructor(private readonly cwd = "") {}

  steps = 0;
  result: AgentOutcome | null = null;
  lastText = "";

  take(line: string): string | null {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return line.trim() ? line : null;
    }
    const item = (event.item ?? {}) as CodexItem;
    if (event.type === "item.started") {
      const described = describeItem(item);
      const shown = described === null ? null : relativeTo(this.cwd, described);
      if (shown) this.steps += 1;
      return shown
        ? shown
            .split("\n")
            .map((part) => `→ ${part}`)
            .join("\n")
        : null;
    }
    if (event.type === "item.completed" && item.type === "agent_message" && item.text) this.lastText = item.text;
    if (event.type === "turn.completed") {
      const usage = (event.usage ?? {}) as Record<string, number | undefined>;
      const cached = usage.cached_input_tokens ?? 0;
      this.result = {
        stopReason: "settled",
        steps: this.steps,
        // Codex reports tokens, not money; a ChatGPT sign-in has no per-token price.
        cost: 0,
        tokens: {
          input: Math.max((usage.input_tokens ?? 0) - cached, 0),
          output: (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0),
          cache_read: cached,
          cache_write: usage.cache_write_input_tokens ?? 0,
        },
        detail: this.lastText.slice(0, 2000),
      };
      return null;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const message = String(
        (event.error as { message?: unknown } | undefined)?.message ?? event.message ?? "error",
      ).slice(0, 2000);
      this.result = { ...empty(this.steps), detail: message };
      return `Codex: ${message.split("\n")[0]}`;
    }
    return null;
  }
}

/** Run Codex non-interactively on one task in its worktree; the prompt goes in on stdin. */
export function runCodex(options: CodexOptions): AgentRun {
  return runAgentProcess({
    command: options.command.length > 0 ? options.command : ["codex"],
    args: codexArgs(options.model),
    cwd: options.cwd,
    prompt: options.prompt,
    env: options.env,
    eventsFile: options.eventsFile,
    onLine: options.onLine,
    stream: new CodexStream(options.cwd),
    name: "Codex",
  });
}

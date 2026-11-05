import { describe, expect, it } from "vitest";
import { StreamState } from "./claude-code";
import { CodexStream } from "./codex";

const toolCall = (name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

describe("Claude Code's stream in the run's log", () => {
  it("names files relative to the worktree, and a search by what it looks for", () => {
    const state = new StreamState("/runs/r1/worktrees/01");
    expect(state.take(toolCall("Edit", { file_path: "/runs/r1/worktrees/01/src/login.html" }))).toBe(
      "→ Edit src/login.html",
    );
    expect(state.take(toolCall("Grep", { pattern: "登陆", path: "/runs/r1/worktrees/01" }))).toBe("→ Grep 登陆");
    expect(state.take(toolCall("LS", { path: "/runs/r1/worktrees/01" }))).toBe("→ LS .");
    expect(state.take(toolCall("Bash", { command: "npm test\necho done" }))).toBe("→ Bash npm test");
    expect(state.steps).toBe(4);
  });

  it("reads the result: cost, tokens and why it failed", () => {
    const state = new StreamState();
    expect(
      state.take(
        JSON.stringify({
          type: "result",
          subtype: "error_max_budget_usd",
          is_error: true,
          total_cost_usd: 0.5,
          usage: { input_tokens: 10, output_tokens: 2 },
          result: "Exceeded USD budget",
        }),
      ),
    ).toMatch(/error_max_budget_usd/);
    expect(state.result).toMatchObject({ stopReason: "cost_budget", cost: 0.5, tokens: { input: 10, output: 2 } });
  });
});

describe("Codex's stream in the run's log", () => {
  it("names changed files relative to the worktree", () => {
    const state = new CodexStream("/runs/r1/worktrees/02");
    const started = (item: Record<string, unknown>) => JSON.stringify({ type: "item.started", item });
    expect(
      state.take(
        started({ type: "file_change", changes: [{ path: "/runs/r1/worktrees/02/src/a.ts", kind: "update" }] }),
      ),
    ).toBe("→ Edit src/a.ts");
    expect(state.take(started({ type: "command_execution", command: "npm test" }))).toBe("→ Shell npm test");
    expect(state.steps).toBe(2);
  });
});

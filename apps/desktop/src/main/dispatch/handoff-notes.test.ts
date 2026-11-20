import { describe, expect, it } from "vitest";
import {
  buildHandoffNote,
  extractContractsFromDiff,
  formatUpstreamMarkdown,
  formatUpstreamPromptBlock,
  parseAgentHandoff,
} from "./handoff-notes";

describe("extractContractsFromDiff", () => {
  it("extracts TypeScript exports, Python defs, Go exports, Rust pub items and SQL tables", () => {
    const diff = [
      "diff --git a/src/price.ts b/src/price.ts",
      "+++ b/src/price.ts",
      "+export interface CartItem { id: string; cents: number }",
      "+export async function formatPrice(cents: number): Promise<string> {",
      "+  // ignored comment",
      "+  const helper = 1;",
      "+}",
      "diff --git a/api/routes.py b/api/routes.py",
      "+++ b/api/routes.py",
      "+def create_order(user_id: int):",
      "+    def _inner(): pass",
      "+class OrderService:",
      "diff --git a/db/001.sql b/db/001.sql",
      "+++ b/db/001.sql",
      "+CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY);",
    ].join("\n");

    expect(extractContractsFromDiff(diff)).toEqual([
      "src/price.ts: export interface CartItem",
      "src/price.ts: export async function formatPrice(cents: number)",
      "api/routes.py: def create_order(user_id: int)",
      "api/routes.py: class OrderService",
      "db/001.sql: CREATE TABLE IF NOT EXISTS orders",
    ]);
  });
});

describe("parseAgentHandoff", () => {
  it("reads a fenced km0-handoff JSON block and falls back cleanly on plain text", () => {
    const fenced = [
      "Done implementing.",
      "```km0-handoff",
      JSON.stringify({
        summary: "Added orders table and helper.",
        contracts: ["src/orders.ts: export function createOrder"],
        notes_for_downstream: "Pass amounts in integer cents.",
      }),
      "```",
    ].join("\n");
    expect(parseAgentHandoff(fenced)).toEqual({
      summary: "Added orders table and helper.",
      contracts: ["src/orders.ts: export function createOrder"],
      notes: "Pass amounts in integer cents.",
    });
    expect(parseAgentHandoff("Plain summary only.")).toEqual({
      summary: "Plain summary only.",
      contracts: [],
      notes: "",
    });
  });
});

describe("buildHandoffNote and upstream formatting", () => {
  it("merges explicit contracts with diff contracts and formats markdown and prompt blocks", () => {
    const note = buildHandoffNote({
      taskId: "01",
      seq: 1,
      title: "Create pricing module",
      agent: "claude_code",
      model: "claude-sonnet-5-5",
      branch: "km0/r1/01",
      commit: "abc123",
      changedFiles: ["src/price.ts"],
      diff: "diff --git a/src/price.ts b/src/price.ts\n+++ b/src/price.ts\n+export function total(n: number) {}",
      agentText: "Implemented pricing.",
      explicitContracts: ["Price is always in cents"],
      explicitNotes: "Call total() before rendering.",
      verdict: { accepted: true, reason: "Meets all criteria." },
      now: "2026-11-20T00:00:00.000Z",
    });
    expect(note.contracts).toEqual(["Price is always in cents", "src/price.ts: export function total(n: number)"]);
    expect(note.changed_files).toEqual(["src/price.ts"]);

    const md = formatUpstreamMarkdown([note], "zh-CN");
    expect(md).toContain("## 01 Create pricing module");
    expect(md).toContain("claude_code / claude-sonnet-5-5");
    expect(md).toContain("Call total() before rendering.");
    expect(md).toContain("验收结果：通过");

    const promptBlock = formatUpstreamPromptBlock([note], "en");
    expect(promptBlock).toContain("km0/upstream.md");
    expect(promptBlock).toContain("Price is always in cents");
    expect(promptBlock).toContain("Call total() before rendering.");
  });
});

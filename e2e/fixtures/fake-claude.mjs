#!/usr/bin/env node
// A stand-in for Claude Code's `claude -p --output-format stream-json`, for KM0's tests: no model, no network.
// It reads the prompt on stdin, finds the task's number in the branch KM0 names (`km0/<run>/<NN>`), writes
// `claude-<NN>.txt` in the working folder and prints the events Claude Code prints, ending with `result`.
//   FAKE_CLAUDE_FAIL=<NN>     that task ends with an error result
//   FAKE_CLAUDE_DELAY_MS=<n>  wait this long before finishing (to test stopping)
//   FAKE_CLAUDE_ARGS=<file>   append the arguments it was given, one JSON line per run
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.316 (Claude Code)\n");
  process.exit(0);
}

const startedAt = Date.now();
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

const seq = prompt.match(/km0\/[\w.-]+\/(\d+)/)?.[1] ?? "00";
const model = args[args.indexOf("--model") + 1] ?? "default";
const resolvingConflict = prompt.includes("KM0_MERGE_CONFLICT");
const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
say({ type: "system", subtype: "init", session_id: `fake-${seq}`, model, cwd: process.cwd(), tools: ["Write"] });

let summary = "";
if (resolvingConflict) {
  const targets = [...prompt.matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);
  const files =
    targets.length > 0 ? targets : process.env.FAKE_CLAUDE_CONFLICT_FILE ? [process.env.FAKE_CLAUDE_CONFLICT_FILE] : [];
  for (const rel of files) {
    const full = join(process.cwd(), rel);
    if (!existsSync(full)) continue;
    say({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: full } }] },
    });
    if (process.env.FAKE_CLAUDE_LEAVE_CONFLICT !== "1") {
      const content = readFileSync(full, "utf8");
      const merged = content
        .split(/\r?\n/)
        .filter((line) => !/^(<{7}\s|={7}$|>{7}\s)/.test(line))
        .join("\n");
      writeFileSync(full, merged.endsWith("\n") ? merged : `${merged}\n`);
    }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
  }
  summary = `Resolved conflicts in ${files.join(", ")}.`;
} else {
  const file = `claude-${seq}.txt`;
  const repairing = prompt.includes("KM0_REPAIR");
  const body =
    process.env.FAKE_CLAUDE_REPAIR_FIX === seq
      ? repairing
        ? `task ${seq} fixed (${model})\n`
        : `task ${seq} incomplete (${model})\n`
      : `task ${seq} by fake Claude Code (${model})\n`;
  say({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: join(process.cwd(), file) } }],
    },
  });
  writeFileSync(join(process.cwd(), file), body);
  if (process.env.FAKE_CLAUDE_CONFLICT_FILE) {
    writeFileSync(join(process.cwd(), process.env.FAKE_CLAUDE_CONFLICT_FILE), `shared line from claude task ${seq}\n`);
  }
  if (process.env.FAKE_CLAUDE_EXPORT === seq) {
    writeFileSync(
      join(process.cwd(), `exported-${seq}.ts`),
      "export function computeTotal(items: number[]): number {\n  return items.length;\n}\n",
    );
  }
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
  summary = `Wrote ${file}.`;
}
say({ type: "assistant", message: { content: [{ type: "text", text: summary }] } });

const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
const finishedAt = Date.now();
if (process.env.FAKE_CLAUDE_ARGS) {
  appendFileSync(
    process.env.FAKE_CLAUDE_ARGS,
    `${JSON.stringify({ seq, args, cwd: process.cwd(), prompt, startedAt, finishedAt, resolvingConflict })}\n`,
  );
}

const failModels = (process.env.FAKE_CLAUDE_FAIL_MODELS ?? "").split(",").filter(Boolean);
const failed = (!resolvingConflict && process.env.FAKE_CLAUDE_FAIL === seq) || failModels.includes(model);
say({
  type: "result",
  subtype: failed ? "error_during_execution" : "success",
  is_error: failed,
  total_cost_usd: 0.0125,
  num_turns: 2,
  usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
  result: failed ? "The fake model gave up." : summary,
});
process.exitCode = failed ? 1 : 0;

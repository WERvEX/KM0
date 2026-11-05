#!/usr/bin/env node
// A stand-in for `codex exec --json`, for KM0's tests: no model, no network.
// It reads the prompt on stdin, finds the task's number in the branch KM0 names (`km0/<run>/<NN>`), writes
// `codex-<NN>.txt` in the working folder and prints the events Codex prints, ending with `turn.completed`.
//   FAKE_CODEX_FAIL=<NN>    that task ends with `turn.failed`
//   FAKE_CODEX_ARGS=<file>  append the arguments it was given, one JSON line per run
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.154.0\n");
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

const seq = prompt.match(/km0\/[\w.-]+\/(\d+)/)?.[1] ?? "00";
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "default";
if (process.env.FAKE_CODEX_ARGS) {
  appendFileSync(process.env.FAKE_CODEX_ARGS, `${JSON.stringify({ seq, args, cwd: process.cwd() })}\n`);
}
const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
say({ type: "thread.started", thread_id: `fake-${seq}` });
say({ type: "turn.started" });

const file = join(process.cwd(), `codex-${seq}.txt`);
const change = { id: "item_1", type: "file_change", changes: [{ path: file, kind: "add" }] };
say({ type: "item.started", item: { ...change, status: "in_progress" } });
writeFileSync(file, `task ${seq} by fake Codex (${model})\n`);
say({ type: "item.completed", item: { ...change, status: "completed" } });

if (process.env.FAKE_CODEX_FAIL === seq) {
  say({ type: "turn.failed", error: { message: "The fake model gave up." } });
  process.exit(1);
}
say({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: `Wrote codex-${seq}.txt.` } });
say({
  type: "turn.completed",
  usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 120, reasoning_output_tokens: 30 },
});

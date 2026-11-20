#!/usr/bin/env node
// A stand-in for `codex exec --json`, for KM0's tests: no model, no network.
// It reads the prompt on stdin, finds the task's number in the branch KM0 names (`km0/<run>/<NN>`), writes
// `codex-<NN>.txt` in the working folder and prints the events Codex prints, ending with `turn.completed`.
//   FAKE_CODEX_FAIL=<NN>    that task ends with `turn.failed`
//   FAKE_CODEX_ARGS=<file>  append the arguments it was given, one JSON line per run
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.154.0\n");
  process.exit(0);
}

const startedAt = Date.now();
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

const seq = prompt.match(/km0\/[\w.-]+\/(\d+)/)?.[1] ?? "00";
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "default";
const resolvingConflict = prompt.includes("KM0_MERGE_CONFLICT");
const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
say({ type: "thread.started", thread_id: `fake-${seq}` });
say({ type: "turn.started" });

let summary = "";
if (resolvingConflict) {
  const targets = [...prompt.matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);
  const files =
    targets.length > 0 ? targets : process.env.FAKE_CODEX_CONFLICT_FILE ? [process.env.FAKE_CODEX_CONFLICT_FILE] : [];
  for (const rel of files) {
    const full = join(process.cwd(), rel);
    if (!existsSync(full)) continue;
    const change = { id: "item_1", type: "file_change", changes: [{ path: full, kind: "update" }] };
    say({ type: "item.started", item: { ...change, status: "in_progress" } });
    const content = readFileSync(full, "utf8");
    const merged = content
      .split(/\r?\n/)
      .filter((line) => !/^(<{7}\s|={7}$|>{7}\s)/.test(line))
      .join("\n");
    writeFileSync(full, merged.endsWith("\n") ? merged : `${merged}\n`);
    say({ type: "item.completed", item: { ...change, status: "completed" } });
  }
  summary = `Resolved conflicts in ${files.join(", ")}.`;
} else {
  const file = join(process.cwd(), `codex-${seq}.txt`);
  const repairing = prompt.includes("KM0_REPAIR");
  const body =
    process.env.FAKE_CODEX_REPAIR_FIX === seq
      ? repairing
        ? `task ${seq} fixed (${model})\n`
        : `task ${seq} incomplete (${model})\n`
      : `task ${seq} by fake Codex (${model})\n`;
  const change = { id: "item_1", type: "file_change", changes: [{ path: file, kind: "add" }] };
  say({ type: "item.started", item: { ...change, status: "in_progress" } });
  writeFileSync(file, body);
  if (process.env.FAKE_CODEX_CONFLICT_FILE) {
    writeFileSync(join(process.cwd(), process.env.FAKE_CODEX_CONFLICT_FILE), `shared line from codex task ${seq}\n`);
  }
  say({ type: "item.completed", item: { ...change, status: "completed" } });
  summary = `Wrote codex-${seq}.txt.`;
}

const delay = Number(process.env.FAKE_CODEX_DELAY_MS ?? 0);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
const finishedAt = Date.now();
if (process.env.FAKE_CODEX_ARGS) {
  appendFileSync(
    process.env.FAKE_CODEX_ARGS,
    `${JSON.stringify({ seq, args, cwd: process.cwd(), prompt, startedAt, finishedAt, resolvingConflict })}\n`,
  );
}

const failModels = (process.env.FAKE_CODEX_FAIL_MODELS ?? "").split(",").filter(Boolean);
if ((!resolvingConflict && process.env.FAKE_CODEX_FAIL === seq) || failModels.includes(model)) {
  say({ type: "turn.failed", error: { message: "The fake model gave up." } });
  process.exit(1);
}
say({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: summary } });
say({
  type: "turn.completed",
  usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 120, reasoning_output_tokens: 30 },
});

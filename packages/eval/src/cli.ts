/**
 * KM0's offline eval. Never part of CI: recordings go stale whenever a prompt changes.
 *
 *   pnpm --filter @km0/eval replay [label]   recorded answers only, no API key; writes reports/<label>.md
 *   pnpm --filter @km0/eval record [label]   asks a model and records every answer to recordings/<label>.jsonl
 *   pnpm --filter @km0/eval smoke            the simulated model, to check the harness itself
 *
 * Recording reads KM0_EVAL_API_KEY (or ANTHROPIC_API_KEY), KM0_EVAL_PROVIDER (anthropic | openai, default
 * anthropic), KM0_EVAL_BASE_URL and KM0_EVAL_MODEL (default claude-sonnet-5-5); the label defaults to the
 * model. With KM0_EVAL_BRIDGE=<folder> no request is sent: each is written to <folder>/NNN.request.md and
 * the run waits for someone else (a person, another model session) to write NNN.response.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type ChatProvider,
  type ChatRequest,
  createGateway,
  createSimulatedLlm,
  type DiscussionLlm,
  type ResolvedProfile,
} from "@km0/core";
import { loadCases } from "./cases";
import { Cassette, recording, replaying } from "./cassette";
import { report, runEval } from "./run";

const root = resolve(import.meta.dirname, "..");
const [command = "replay", labelArg] = process.argv.slice(2);
const model = process.env.KM0_EVAL_MODEL ?? "claude-sonnet-5-5";
const bridgeDir = process.env.KM0_EVAL_BRIDGE ? resolve(process.env.KM0_EVAL_BRIDGE) : null;
const label = labelArg ?? (command === "smoke" ? "simulated" : model);

let bridgeSeq = 0;
async function askBridge(request: ChatRequest): Promise<string> {
  const dir = bridgeDir as string;
  const id = String(++bridgeSeq).padStart(3, "0");
  const parts = [`<!-- model: ${request.model} · max_tokens: ${request.maxTokens ?? "-"} -->`];
  if (request.system) parts.push("# system", "", request.system, "");
  for (const message of request.messages) parts.push(`# ${message.role}`, "", message.content, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.request.md`), parts.join("\n"));
  const answer = join(dir, `${id}.response.md`);
  while (!existsSync(answer)) await new Promise((done) => setTimeout(done, 1000));
  await new Promise((done) => setTimeout(done, 500));
  return readFileSync(answer, "utf8");
}
const bridge: ChatProvider = {
  async complete(request) {
    return { text: await askBridge(request), usage: { inputTokens: 0, outputTokens: 0 } };
  },
  async stream(request, onDelta) {
    const text = await askBridge(request);
    onDelta(text);
    return { text, usage: { inputTokens: 0, outputTokens: 0 } };
  },
};

function liveModel(): DiscussionLlm {
  const apiKey = process.env.KM0_EVAL_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? null;
  if (!apiKey && !bridgeDir) {
    throw new Error("Recording needs KM0_EVAL_API_KEY (or ANTHROPIC_API_KEY), or KM0_EVAL_BRIDGE for a file bridge.");
  }
  const provider = process.env.KM0_EVAL_PROVIDER === "openai" ? "openai" : "anthropic";
  const profile: ResolvedProfile = {
    id: 1,
    name: model,
    provider,
    baseUrl: process.env.KM0_EVAL_BASE_URL ?? null,
    model,
    apiKey,
    // The bridge carries text only, so structured answers are asked for in the prompt.
    structuredMode: bridgeDir ? "prompt" : "auto",
    temperature: null,
    priceInPerMTok: null,
    priceOutPerMTok: null,
  };
  const gateway = createGateway({ ...(bridgeDir ? { providerFor: () => bridge } : {}), recordCall: () => undefined });
  return { structured: (_role, call) => gateway.structured({ ...call, profile, projectId: null }) };
}

async function main(): Promise<number> {
  const set = loadCases(join(root, "cases"));
  let current = "";
  const onCase = (id: string) => {
    current = id;
    console.log(`… ${id}`);
  };
  const file = join(root, "recordings", `${label}.jsonl`);
  let llm: DiscussionLlm;
  if (command === "smoke") llm = createSimulatedLlm();
  else if (command === "record") llm = recording(liveModel(), new Cassette(file), () => current);
  else if (command === "replay") {
    const cassette = new Cassette(file);
    if (cassette.size === 0) {
      console.error(`No recordings in ${file}; record them first with \`pnpm --filter @km0/eval record\`.`);
      return 2;
    }
    llm = replaying(cassette, () => current);
  } else {
    console.error(`Unknown command ${command}; use replay, record or smoke.`);
    return 2;
  }
  const result = await runEval(set, llm, onCase);
  const markdown = report(result, label);
  const out = join(root, "reports", `${label}.md`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${markdown}\n`);
  writeFileSync(out.replace(/\.md$/, ".json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\n${markdown}\nwrote ${out}`);
  return result.metrics.errors > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);

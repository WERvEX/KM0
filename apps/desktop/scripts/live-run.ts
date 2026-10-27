/**
 * Walks the whole KM0 flow against a real model and writes everything it produced to a folder for
 * review: triage, every question round, the decision ledger, the documents, the routed tasks and
 * the hand-off package. Nothing is asserted about content; this exists to judge prompt quality.
 *
 *   ANTHROPIC_API_KEY=... pnpm --filter @km0/desktop live-run
 *
 * Optional: KM0_LIVE_CASES (comma-separated: fast, light, full; default full),
 * KM0_LIVE_DESCRIPTION (overrides the case's one-line request), KM0_LIVE_ROUTER_MODEL and
 * KM0_LIVE_PLANNER_MODEL (default claude-sonnet-5-5), KM0_LIVE_BASE_URL, KM0_LIVE_OUT.
 * KM0_LIVE_SIMULATED=1 runs the same steps on the simulated model, to check the script itself.
 * KM0_LIVE_BRIDGE=<folder> sends no API request: each call is written to <folder>/NNN.request.md and
 * the run waits for something else (a person, another agent) to write the answer to NNN.response.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type ChatProvider,
  type ChatRequest,
  createGateway,
  createSimulatedLlm,
  type LlmCallRecord,
  type ResolvedProfile,
} from "@km0/core";
import { type LlmRole, PATH_DOCUMENTS, type ProjectDetail, type QuestionRound } from "@km0/shared";
import { it } from "vitest";
import { openDatabase } from "../src/main/db/database";
import { AgentStore } from "../src/main/services/agent-store";
import { DocumentService } from "../src/main/services/document-service";
import { HandoffService } from "../src/main/services/handoff-service";
import { llmPort } from "../src/main/services/llm-port";
import { ProjectService } from "../src/main/services/project-service";
import { RoutingService } from "../src/main/services/routing-service";
import { PlainSecretStore } from "../src/main/services/secrets";
import { SettingsStore as RealSettingsStore, type SettingsStore } from "../src/main/services/settings-store";

const CASES: Record<string, string> = {
  fast: "修复登录页“忘记密码”链接点了没反应的问题",
  light: "给现有的 Next.js 博客加上文章评论功能，需要登录后才能评论",
  full: "做一个给 5 到 20 人小团队用的需求管理平台：收集需求、排优先级、关联迭代，支持网页端",
};

const simulated = process.env.KM0_LIVE_SIMULATED === "1";
const apiKey = process.env.ANTHROPIC_API_KEY;
const bridgeDir = process.env.KM0_LIVE_BRIDGE ? resolve(process.env.KM0_LIVE_BRIDGE) : null;
const baseUrl = process.env.KM0_LIVE_BASE_URL ?? "https://api.anthropic.com";
const routerModel = process.env.KM0_LIVE_ROUTER_MODEL ?? "claude-sonnet-5-5";
const plannerModel = process.env.KM0_LIVE_PLANNER_MODEL ?? "claude-sonnet-5-5";
const cases = (process.env.KM0_LIVE_CASES ?? "full").split(",").map((name) => name.trim());
const outRoot = resolve(
  process.env.KM0_LIVE_OUT ?? join("live-run-output", new Date().toISOString().replace(/[:.]/g, "-")),
);

function profile(id: number, model: string): ResolvedProfile {
  return {
    id,
    name: model,
    provider: "anthropic",
    baseUrl,
    model,
    apiKey: apiKey ?? null,
    // The bridge only carries text, so structured answers are asked for in the prompt.
    structuredMode: bridgeDir ? "prompt" : "auto",
    temperature: null,
    priceInPerMTok: null,
    priceOutPerMTok: null,
  };
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function roundMarkdown(round: QuestionRound): string {
  const lines = [`### ${round.stage}${round.review ? "（复核）" : ""} · 第 ${round.id} 轮`, ""];
  for (const question of round.questions) {
    lines.push(`- **${question.decisionKey}**（${question.type}）${question.prompt}`);
    for (const option of question.options) {
      lines.push(
        `  - ${option.recommended ? "★ " : ""}${option.label}${option.description ? `：${option.description}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

let bridgeSeq = 0;

/** Hands each request to whoever answers files in the bridge folder, and waits for the answer. */
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

async function askBridge(request: ChatRequest): Promise<string> {
  if (!bridgeDir) throw new Error("No bridge folder");
  const id = String(++bridgeSeq).padStart(3, "0");
  const parts = [
    `<!-- model: ${request.model} · effort: ${request.effort ?? "-"} · max_tokens: ${request.maxTokens ?? "-"} -->`,
  ];
  if (request.system) parts.push("# system", "", request.system, "");
  for (const message of request.messages) parts.push(`# ${message.role}`, "", message.content, "");
  write(join(bridgeDir, `${id}.request.md`), parts.join("\n"));
  const answer = join(bridgeDir, `${id}.response.md`);
  while (!existsSync(answer)) await new Promise((done) => setTimeout(done, 1000));
  // Give the writer a moment to finish the file.
  await new Promise((done) => setTimeout(done, 500));
  return readFileSync(answer, "utf8");
}

async function runCase(name: string, description: string, calls: LlmCallRecord[]) {
  const out = join(outRoot, name);
  const db = openDatabase(":memory:");
  const profiles: Record<LlmRole, ResolvedProfile> = {
    router: profile(1, routerModel),
    planner: profile(2, plannerModel),
  };
  const settings = { profileForRole: (role: LlmRole) => profiles[role] } as unknown as SettingsStore;
  const gateway = createGateway({
    ...(bridgeDir ? { providerFor: () => bridge } : {}),
    recordCall: (record) => calls.push({ ...record, purpose: `${name}:${record.purpose}` }),
  });
  const fake = simulated ? createSimulatedLlm() : null;
  const llmFor = (projectId: number | null) => fake ?? llmPort(gateway, settings, projectId);
  const language = () => "zh-CN" as const;
  // The seeded Claude Code models live in the models table; agents read them through a real store.
  const modelStore = new RealSettingsStore(db, new PlainSecretStore());
  const agents = new AgentStore(db, () => modelStore.listModels());
  const projects = new ProjectService(db, llmFor, language);
  const documents = new DocumentService(db, llmFor, language, () => undefined);
  const routing = new RoutingService(db, llmFor, language, agents);
  const handoff = new HandoffService(db, routing, language);

  const log: string[] = [`# ${name}：${description}`, ""];
  const timings: Record<string, number> = {};
  const timed = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await work();
    } finally {
      timings[step] = (timings[step] ?? 0) + Date.now() - started;
    }
  };
  /** A failed generation is stored on the project; retry it once, then stop. */
  const settle = async (project: ProjectDetail): Promise<ProjectDetail> => {
    if (!project.error) return project;
    log.push(`> 出错后重试：${project.error.kind} ${project.error.message} ${project.error.detail ?? ""}`, "");
    const retried = await projects.retry(project.id);
    if (retried.error) throw new Error(`${retried.error.kind}: ${retried.error.message} ${retried.error.detail ?? ""}`);
    return retried;
  };

  let project = await settle(await timed("triage+first round", () => projects.create(description, null)));
  log.push(
    "## 分流",
    "",
    "```json",
    JSON.stringify(project.triage, null, 2),
    "```",
    "",
    `通道：${project.path}`,
    "",
    "## 讨论",
    "",
  );

  // Answer every round with the recommended options, as a user who only clicks "推荐" would.
  for (let guard = 0; guard < 30 && !project.discussionComplete; guard++) {
    const round = project.openRound;
    if (round) {
      log.push(roundMarkdown(round), "");
      const answers = round.questions.map((question) => ({
        questionId: question.id,
        optionIds: question.options.filter((option) => option.recommended).map((option) => option.id),
        // A question with no recommended option gets "let the AI decide".
        ...(question.options.some((option) => option.recommended) ? {} : { delegate: true }),
      }));
      project = await settle(
        await timed(`discussion.${round.stage}`, () => projects.answer(project.id, round.id, answers)),
      );
      continue;
    }
    const stage = project.stage;
    project = await settle(
      await timed(`discussion.${stage}`, async () => {
        try {
          return await projects.advance(project.id, false);
        } catch {
          log.push(`> ${stage} 阶段推荐答案未覆盖所有必填项，用“采用推荐”补齐`, "");
          return projects.advance(project.id, true);
        }
      }),
    );
  }

  log.push("## 决策账本", "");
  for (const decision of project.decisions) {
    log.push(
      `- **${decision.key}**（${decision.stage}，${decision.source}）${decision.value.text}${decision.rationale ? ` —— ${decision.rationale}` : ""}`,
    );
  }
  log.push("");

  for (const kind of PATH_DOCUMENTS[project.path ?? "full"]) {
    const doc = await timed(`document.${kind}`, () => documents.generate(project.id, kind, false));
    write(join(out, "docs", doc.fileName), doc.markdown);
    log.push(`## 文档 ${doc.fileName}`, "", `${doc.sections.length} 节，${doc.markdown.length} 字`, "");
  }

  const plan = await timed("routing", () => routing.plan(project.id));
  write(join(out, "routing.json"), JSON.stringify(plan, null, 2));
  log.push(
    "## 任务与路由",
    "",
    "| # | 任务 | 分数 | 档位 | Agent | 模型 | 依赖 | 验收条数 |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const task of plan.tasks) {
    log.push(
      `| ${task.seq} | ${task.title} | ${task.score} | ${task.tier} | ${task.agent ?? "-"} | ${task.model ?? "-"} | ${task.dependsOn.join(",") || "-"} | ${task.acceptance.length} |`,
    );
  }
  log.push("", "```json", JSON.stringify({ totals: plan.totals, tierCounts: plan.tierCounts }, null, 2), "```", "");

  const pkg = handoff.build(project.id);
  for (const file of pkg.files) write(join(out, "handoff", file.path), file.content);
  log.push("## 交接包", "", ...pkg.files.map((file) => `- ${file.path}（${file.content.length} 字）`), "");

  const caseCalls = calls.filter((call) => call.purpose.startsWith(`${name}:`));
  log.push(
    "## 模型调用",
    "",
    "| 用途 | 模型 | 模式 | 尝试 | 输入 | 输出 | 耗时 ms | 错误 |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const call of caseCalls) {
    log.push(
      `| ${call.purpose.slice(name.length + 1)} | ${call.model} | ${call.mode} | ${call.attempt} | ${call.inputTokens} | ${call.outputTokens} | ${call.latencyMs} | ${call.error ? `${call.error.kind}: ${call.error.message}` : ""} |`,
    );
  }
  log.push("", "## 各步耗时（ms）", "", "```json", JSON.stringify(timings, null, 2), "```");

  write(join(out, "decisions.json"), JSON.stringify(project.decisions, null, 2));
  write(join(out, "REPORT.md"), `${log.join("\n")}\n`);
  db.close();
}

it.skipIf(!apiKey && !simulated && !bridgeDir)(
  "runs the whole flow against a real model",
  async () => {
    const calls: LlmCallRecord[] = [];
    try {
      for (const name of cases) {
        const description = process.env.KM0_LIVE_DESCRIPTION ?? CASES[name];
        if (!description) throw new Error(`Unknown case "${name}"; use fast, light or full.`);
        await runCase(name, description, calls);
      }
    } finally {
      write(join(outRoot, "calls.json"), JSON.stringify(calls, null, 2));
      console.log(`Output written to ${outRoot}`);
    }
  },
  60 * 60 * 1000,
);

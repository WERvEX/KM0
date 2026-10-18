import type { AgentConfig, AgentId, Decision, RoutingPlan } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { planTotals, routeTask, type TaskBasics } from "../routing/route";
import { ADAPTERS } from "./adapters";
import { buildHandoff, EXCERPT_LIMITS, type HandoffInput } from "./build";

const decision = (key: string, text: string, rationale: string | null = null): Decision => ({
  key,
  stage: "tech",
  value: { text },
  source: "user",
  rationale,
  alternatives: [],
  dependsOn: [],
  needsReview: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const agents: AgentConfig[] = [
  {
    id: "claude_code",
    enabled: true,
    preference: 0,
    models: {
      T1: { modelId: "claude-haiku-5-5", priceInPerMTok: null, priceOutPerMTok: null },
      T2: { modelId: "claude-sonnet-5-5", priceInPerMTok: null, priceOutPerMTok: null },
      T3: null,
    },
  },
  {
    id: "codex",
    enabled: true,
    preference: 1,
    models: { T1: null, T2: null, T3: { modelId: "gpt-codex-max", priceInPerMTok: null, priceOutPerMTok: null } },
  },
];

const basics = (seq: number, overrides: Partial<TaskBasics>): TaskBasics => ({
  id: seq * 10,
  seq,
  title: `任务 ${seq}`,
  goal: "目标",
  acceptance: ["当用户提交评论时，系统应当保存并显示它。"],
  files: [],
  dependsOn: [],
  decisionKeys: [],
  sections: [],
  features: {
    scope: "single_file",
    ambiguity: "low",
    reasoning: "follow",
    context: "small",
    hasTests: true,
    risks: [],
    kind: "code",
  },
  override: null,
  ...overrides,
});

function input(): HandoffInput {
  const tasks = [
    routeTask(
      basics(1, {
        title: "加评论表",
        files: ["src/db/schema.ts"],
        decisionKeys: ["storage"],
        sections: [{ kind: "tech_design", sectionId: "data_model" }],
      }),
      agents,
      "zh-CN",
    ),
    routeTask(
      basics(2, {
        title: "设计权限",
        dependsOn: [1],
        features: {
          scope: "few_files",
          ambiguity: "low",
          reasoning: "design",
          context: "small",
          hasTests: false,
          risks: ["security"],
          kind: "code",
        },
      }),
      agents,
      "zh-CN",
    ),
  ];
  const plan: RoutingPlan = {
    projectId: 7,
    createdAt: "2026-01-01T00:00:00.000Z",
    tasks,
    ...planTotals(tasks),
    basedOn: [],
    outdated: false,
  };
  return {
    language: "zh-CN",
    projectId: 7,
    createdAt: "2026-01-02T00:00:00.000Z",
    title: "博客评论",
    description: "给博客加评论功能",
    path: "full",
    decisions: [
      decision("scale", "开源项目"),
      decision("storage", "SQLite", "单机即可"),
      decision("backend", "FastAPI"),
    ],
    documents: [
      {
        kind: "tech_design",
        markdown: "# 博客评论 · 技术方案\n",
        sections: [
          { id: "architecture", title: "架构概览", body: "单体 FastAPI 应用。" },
          { id: "data_model", title: "数据模型", body: "comments 表。" },
        ],
      },
    ],
    plan,
  };
}

describe("hand-off package", () => {
  it("lays out docs, tasks, tasks.json and instructions only for the agents in use", () => {
    const pkg = buildHandoff(input());
    expect(pkg.root).toBe("km0");
    expect(pkg.files.map((file) => file.path)).toEqual([
      "km0/README.md",
      "km0/docs/TECH_DESIGN.md",
      "km0/tasks.json",
      "km0/tasks/01.md",
      "km0/tasks/02.md",
      "km0/agents/CLAUDE.md",
      "km0/agents/AGENTS.md",
    ]);
    expect(pkg.tasks.map((task) => [task.seq, task.tier, task.agent, task.model])).toEqual([
      [1, "T1", "claude_code", "claude-haiku-5-5"],
      [2, "T3", "codex", "gpt-codex-max"],
    ]);
    expect(pkg.tasks.map((task) => task.command)).toEqual([
      'claude --model claude-haiku-5-5 -p "阅读 km0/tasks/01.md 并完成其中描述的任务。"',
      'codex exec -m gpt-codex-max -s workspace-write "阅读 km0/tasks/02.md 并完成其中描述的任务。"',
    ]);
    const json = JSON.parse(pkg.files.find((file) => file.path === "km0/tasks.json")?.content ?? "[]");
    expect(json[1]).toMatchObject({ seq: 2, dependsOn: [1], prompt: "km0/tasks/02.md", tier: "T3" });
  });

  it("gives a task only the decisions and sections it cites", () => {
    const [first] = buildHandoff(input()).tasks;
    expect(first?.prompt).toMatchSnapshot();
    expect(first?.prompt).toContain("数据存储：SQLite（单机即可）");
    expect(first?.prompt).not.toContain("后端：FastAPI");
    expect(first?.prompt).toContain("### 技术方案 · 数据模型");
    expect(first?.prompt).not.toContain("### 技术方案 · 架构概览");
  });

  it("falls back to the stack and architecture, and adds risk rules and escalation for uncited tasks", () => {
    const second = buildHandoff(input()).tasks[1]?.prompt ?? "";
    expect(second).toMatchSnapshot();
    expect(second).toContain("后端：FastAPI");
    expect(second).toContain("### 技术方案 · 架构概览");
    expect(second).toContain("涉及安全");
    expect(second).toContain("这一块还没有测试");
    expect(second).toContain("任务 01：加评论表 (`km0/tasks/01.md`)");
    expect(second).toContain("交给人来决定");
  });

  it("cuts long excerpts and points to the full document", () => {
    const data = input();
    const doc = data.documents[0];
    if (doc?.sections[1]) doc.sections[1].body = "长".repeat(EXCERPT_LIMITS.section + 500);
    const prompt = buildHandoff(data).tasks[0]?.prompt ?? "";
    expect(prompt).toContain("…（已截断，完整内容见 `km0/docs/TECH_DESIGN.md`）");
    expect(prompt.match(/长/g)?.length).toBe(EXCERPT_LIMITS.section);
  });

  it("writes the README and the instructions in English too", () => {
    const pkg = buildHandoff({ ...input(), language: "en" });
    const readme = pkg.files.find((file) => file.path === "km0/README.md")?.content ?? "";
    expect(readme).toMatchSnapshot();
    expect(pkg.tasks[0]?.command).toBe(
      'claude --model claude-haiku-5-5 -p "Read km0/tasks/01.md and complete the task it describes."',
    );
  });
});

describe("adapters", () => {
  const ids = Object.keys(ADAPTERS) as AgentId[];

  it.each(ids)("%s renders its instructions and command consistently", (id) => {
    const adapter = ADAPTERS[id];
    expect({
      instructions: adapter.instructions
        ? {
            packagedAs: adapter.instructions.packagedAs,
            target: adapter.instructions.target,
            content: adapter.instructions.render("# 项目\n\n概览\n", "zh-CN"),
          }
        : null,
      command: adapter.command("阅读 km0/tasks/01.md 并完成其中描述的任务。", "model-x"),
      commandWithoutModel: adapter.command("Do it.", null),
      howTo: adapter.howTo,
    }).toMatchSnapshot();
  });
});

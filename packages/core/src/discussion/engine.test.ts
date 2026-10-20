import type { Decision } from "@km0/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { dependentsOf, requiredKeys, stageKeys } from "./catalog";
import {
  choosePath,
  type DiscussionLlm,
  fillDecisions,
  missingKeys,
  normalizeQuestions,
  planRound,
  recommendedAnswers,
  resolveAnswers,
  triageTask,
} from "./engine";
import { fillSystem, type RoundPromptInput, roundSystem } from "./prompts";

/** Returns scripted outputs in order and records each call. */
function scriptedLlm(outputs: unknown[]) {
  const calls: { role: string; purpose: string; system?: string; prompt: string }[] = [];
  const llm: DiscussionLlm = {
    async structured<S extends z.ZodType>(
      role: "router" | "planner",
      call: { schema: S; purpose: string; system?: string; prompt: string },
    ) {
      calls.push({ role, purpose: call.purpose, system: call.system, prompt: call.prompt });
      const next = outputs.shift();
      if (next === undefined) throw new Error("no scripted output left");
      return call.schema.parse(next);
    },
  } as DiscussionLlm;
  return { llm, calls };
}

function decision(key: string, stage: Decision["stage"], text: string, needsReview = false): Decision {
  return {
    key,
    stage,
    value: { text },
    source: "user",
    rationale: null,
    alternatives: [],
    dependsOn: [],
    needsReview,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const baseCtx = {
  language: "zh-CN" as const,
  path: "full" as const,
  description: "做一个团队内部用的需求管理工具",
  triage: null,
  roundNo: 1,
  mode: "required" as const,
};

describe("triage", () => {
  it("maps the model's classification to a path with rules", async () => {
    const { llm, calls } = scriptedLlm([
      {
        title: "需求管理工具",
        task_type: "new_project",
        complexity: "L",
        has_codebase: false,
        summary: "s",
        reasons: ["r"],
      },
    ]);
    const triage = await triageTask(llm, "做一个需求管理工具", "zh-CN");
    expect(triage).toMatchObject({ title: "需求管理工具", taskType: "new_project", suggestedPath: "full" });
    expect(calls[0]?.role).toBe("router");
    expect(calls[0]?.system).toContain("Simplified Chinese");
  });

  it.each([
    ["bugfix", "S", "fast"],
    ["small_change", "S", "fast"],
    ["feature", "M", "light"],
    ["feature", "L", "full"],
    ["new_project", "S", "light"],
    ["new_project", "M", "full"],
    ["refactor", "XL", "full"],
  ] as const)("%s/%s goes to the %s path", (type, complexity, path) => {
    expect(choosePath(type, complexity)).toBe(path);
  });
});

describe("planRound", () => {
  it("asks only about undecided keys of the stage and keeps inferred decisions", async () => {
    const { llm, calls } = scriptedLlm([
      {
        inferred: [{ key: "user_scale", value: "约 20 人", rationale: "描述里写了团队内部" }],
        questions: [
          {
            key: "scale",
            prompt: "做成什么形态？",
            type: "single",
            options: [{ label: "本地工具" }, { label: "在线部署", recommended: true }],
          },
          {
            key: "compliance",
            prompt: "数据敏感吗？",
            type: "single",
            options: [{ label: "普通数据", recommended: true }, { label: "含个人隐私" }],
          },
          { key: "backend", prompt: "跨阶段的问题应被丢弃", type: "text" },
          { key: "compliance", prompt: "重复的 key 应被丢弃", type: "text" },
        ],
      },
    ]);
    const plan = await planRound(llm, { ...baseCtx, stage: "scale", decisions: [] });
    expect(plan.inferred).toEqual([
      {
        key: "user_scale",
        value: { text: "约 20 人" },
        source: "ai",
        rationale: "描述里写了团队内部",
        alternatives: [],
      },
    ]);
    expect(plan.questions.map((question) => question.decisionKey)).toEqual(["scale", "compliance"]);
    // The scale question always has the four fixed delivery forms, with the model's pick carried over.
    expect(plan.questions[0]?.options.map((option) => option.id)).toEqual([
      "local_tool",
      "open_source",
      "online_service",
      "enterprise",
    ]);
    expect(plan.questions[0]?.options.find((option) => option.recommended)?.id).toBe("online_service");
    expect(calls[0]?.prompt).toContain("scale (required)");
  });

  it("keeps at most one optional question while required keys are open", async () => {
    const { llm } = scriptedLlm([
      {
        questions: [
          { key: "compliance", prompt: "数据敏感吗？", type: "text" },
          { key: "timeline", prompt: "什么时候要？", type: "text" },
          { key: "user_scale", prompt: "多少人用？", type: "text" },
        ],
      },
    ]);
    const plan = await planRound(llm, { ...baseCtx, stage: "scale", decisions: [] });
    expect(plan.questions.map((question) => question.decisionKey)).toEqual(["compliance", "user_scale"]);
  });

  it("skips the model when nothing is left to ask", async () => {
    const { llm, calls } = scriptedLlm([]);
    const decisions = ["scope", "acceptance"].map((key) => decision(key, "confirm", "x"));
    const plan = await planRound(llm, { ...baseCtx, path: "fast", stage: "confirm", decisions });
    expect(plan).toEqual({ questions: [], inferred: [] });
    expect(calls).toHaveLength(0);
  });

  it("adds tech defaults that follow the chosen delivery form", async () => {
    const { llm, calls } = scriptedLlm([{ questions: [] }]);
    await planRound(llm, { ...baseCtx, stage: "tech", decisions: [decision("scale", "scale", "企业级系统")] });
    expect(calls[0]?.prompt).toContain("SSO");
  });

  it("offers to keep the current value when re-checking a flagged decision", async () => {
    const { llm } = scriptedLlm([
      {
        questions: [
          {
            key: "storage",
            prompt: "存储还用 SQLite 吗？",
            type: "single",
            options: [{ label: "PostgreSQL", recommended: true }, { label: "MySQL" }],
          },
        ],
      },
    ]);
    const plan = await planRound(llm, {
      ...baseCtx,
      stage: "tech",
      mode: "review",
      decisions: [decision("storage", "tech", "SQLite", true)],
    });
    const options = plan.questions[0]?.options ?? [];
    expect(options[0]).toEqual({ id: "keep", label: "SQLite", recommended: true });
    expect(options.filter((option) => option.recommended)).toHaveLength(1);
    expect(plan.questions[0]?.currentValue).toEqual({ text: "SQLite" });
  });
});

describe("normalizeQuestions", () => {
  const allowed = new Set(["frontend", "backend", "storage", "deployment"]);
  const opts = { allowed, roundNo: 2, language: "zh-CN" as const, currentValues: new Map() };

  it("caps questions at three, turns option-less choices into text and fixes recommendations", () => {
    const questions = normalizeQuestions(
      [
        {
          key: "frontend",
          prompt: "a",
          type: "single",
          options: [
            { label: "React", recommended: true },
            { label: "Vue", recommended: true },
          ],
          allow_custom: true,
        },
        {
          key: "backend",
          prompt: "b",
          type: "single",
          options: [{ label: "only one", recommended: false }],
          allow_custom: false,
        },
        {
          key: "storage",
          prompt: "c",
          type: "single",
          options: [
            { label: "SQLite", recommended: false },
            { label: "PG", recommended: false },
          ],
          allow_custom: true,
        },
        { key: "deployment", prompt: "d", type: "text", options: [], allow_custom: true },
      ],
      opts,
    );
    expect(questions).toHaveLength(3);
    expect(questions.map((question) => question.id)).toEqual(["r2q1", "r2q2", "r2q3"]);
    expect(questions[0]?.options.map((option) => option.recommended)).toEqual([true, false]);
    expect(questions[1]).toMatchObject({ type: "text", options: [], allowCustom: true });
    expect(questions[2]?.options.map((option) => option.recommended)).toEqual([true, false]);
  });
});

describe("resolveAnswers", () => {
  const questions = normalizeQuestions(
    [
      {
        key: "frontend",
        prompt: "前端？",
        type: "single",
        options: [
          { label: "React", recommended: true },
          { label: "Vue", recommended: false },
        ],
        allow_custom: true,
      },
      {
        key: "integrations",
        prompt: "集成？",
        type: "multi",
        options: [
          { label: "GitHub", recommended: true },
          { label: "Slack", recommended: false },
        ],
        allow_custom: true,
      },
      { key: "backend", prompt: "后端？", type: "text", options: [], allow_custom: true },
    ],
    {
      allowed: new Set(["frontend", "integrations", "backend"]),
      roundNo: 1,
      language: "zh-CN",
      currentValues: new Map(),
    },
  );

  it("keeps the description of a single chosen option, where plans spell out their parts", () => {
    const [milestones] = normalizeQuestions(
      [
        {
          key: "milestones",
          prompt: "按什么顺序交付？",
          type: "single",
          options: [
            { label: "按功能逐个交付", description: "推荐：阶段 1 登录；阶段 2 需求；阶段 3 迭代", recommended: true },
            { label: "先后端再前端", description: "分工清晰，但后期才能看到页面", recommended: false },
          ],
          allow_custom: true,
        },
      ],
      { allowed: new Set(["milestones"]), roundNo: 2, language: "zh-CN", currentValues: new Map() },
    );
    if (!milestones) throw new Error("no question");
    const pick = (text?: string) =>
      resolveAnswers([milestones], [{ questionId: milestones.id, optionIds: ["o1"], ...(text ? { text } : {}) }])
        .decided[0];
    expect(pick()).toMatchObject({
      value: { text: "按功能逐个交付" },
      rationale: "推荐：阶段 1 登录；阶段 2 需求；阶段 3 迭代",
    });
    // With the user's own words added, the option's description no longer describes the answer.
    expect(pick("再加一个导出阶段")?.rationale).toBeNull();
  });

  it("records the source, the alternatives and multi-select items", () => {
    const { decided, delegated } = resolveAnswers(questions, [
      { questionId: "r1q1", optionIds: ["o1"] },
      { questionId: "r1q2", optionIds: ["o1", "o2"], text: "飞书" },
      { questionId: "r1q3", delegate: true },
    ]);
    expect(decided).toEqual([
      { key: "frontend", value: { text: "React" }, source: "recommended", rationale: null, alternatives: ["Vue"] },
      {
        key: "integrations",
        value: { text: "GitHub、Slack、飞书", items: ["GitHub", "Slack", "飞书"] },
        source: "user",
        rationale: null,
        alternatives: [],
      },
    ]);
    expect(delegated).toEqual(["backend"]);
  });

  it("ignores empty answers and invalid multi-picks on single questions", () => {
    const { decided } = resolveAnswers(questions, [
      { questionId: "r1q1", optionIds: ["o1", "o2"] },
      { questionId: "r1q3", text: "   " },
    ]);
    expect(decided).toEqual([]);
  });

  it("builds recommended answers, delegating questions without a recommendation", () => {
    expect(recommendedAnswers(questions, new Set(["r1q1"]))).toEqual([
      { questionId: "r1q2", optionIds: ["o1"], delegate: false },
      { questionId: "r1q3", optionIds: [], delegate: true },
    ]);
  });
});

describe("fillDecisions", () => {
  it("uses the planner and fills keys the model skipped", async () => {
    const { llm, calls } = scriptedLlm([
      {
        decisions: [
          { key: "backend", value: "FastAPI", rationale: "团队熟悉 Python" },
          { key: "unrelated", value: "x" },
        ],
      },
    ]);
    const drafts = await fillDecisions(llm, { ...baseCtx, stage: "tech", decisions: [] }, ["backend", "storage"]);
    expect(calls[0]?.role).toBe("planner");
    expect(drafts.map((draft) => [draft.key, draft.value.text, draft.source])).toEqual([
      ["backend", "FastAPI", "ai"],
      ["storage", "待定，由实现时决定", "ai"],
    ]);
  });
});

describe("catalog", () => {
  it("lists the required keys of each stage", () => {
    expect(requiredKeys("scale")).toEqual(["scale", "user_scale"]);
    expect(requiredKeys("requirements")).toEqual(["target_users", "core_scenarios", "auth", "mvp_features"]);
    expect(
      missingKeys("confirm", [decision("scope", "confirm", "x"), decision("acceptance", "confirm", "y", true)]),
    ).toEqual(["acceptance"]);
  });

  it("finds transitive dependents of a changed decision", () => {
    const dependents = dependentsOf("scale");
    expect(dependents).toEqual(expect.arrayContaining(["user_scale", "auth", "storage", "architecture", "milestones"]));
    expect(dependents).not.toContain("scale");
    expect(dependentsOf("risks")).toEqual([]);
  });
});

describe("prompts", () => {
  const input: Omit<RoundPromptInput, "stage"> = {
    language: "zh-CN",
    path: "full",
    description: "做一个需求管理平台",
    triage: null,
    decisions: [],
    targetKeys: [],
    maxQuestions: 3,
    mode: "required",
  };

  it("keeps inferred and delegated values within the decisions already made", () => {
    expect(roundSystem({ ...input, stage: "implementation" })).toContain("never add a feature");
    expect(fillSystem("zh-CN")).toContain("never add a feature");
  });

  it("asks for the product's core rules in the requirements stage", () => {
    expect(stageKeys("requirements").map((def) => def.key)).toContain("core_rules");
    expect(dependentsOf("mvp_features")).toContain("core_rules");
    expect(roundSystem({ ...input, stage: "requirements" })).toContain("`core_rules`");
    expect(roundSystem({ ...input, stage: "tech" })).not.toContain("`core_rules`");
  });
});

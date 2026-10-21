import { describe, expect, it } from "vitest";
import { type AcceptanceInput, acceptancePrompt, acceptanceSystem } from "./acceptance";

const input: AcceptanceInput = {
  language: "zh-CN",
  title: "按码点截断发言",
  goal: "发言超过 120 个码点时截断。",
  acceptance: ["当清理后的发言超过 120 个码点时，系统应当保留前 120 个码点并追加省略号。"],
  decisions: ["完成标准: 先去掉 think 块、引号和前缀再计数"],
  diff: "diff --git a/a.ts b/a.ts\n",
  testCommand: "npm test",
  testResult: { passed: true, detail: "6 passed" },
  failure: null,
};

describe("acceptance prompt", () => {
  // A condition the planner left only in a referenced decision must still be checked.
  it("shows the decisions the task relies on and counts their conditions as criteria", () => {
    expect(acceptancePrompt(input)).toContain(
      "Decisions the task relies on:\n- 完成标准: 先去掉 think 块、引号和前缀再计数",
    );
    expect(acceptanceSystem(input)).toContain("counts as a criterion too");
  });

  it("leaves the decisions block out when there are none", () => {
    expect(acceptancePrompt({ ...input, decisions: [] })).not.toContain("Decisions the task relies on");
  });

  // An earlier task often writes the tests a later "add tests" task asks for, leaving that task's diff empty.
  it("shows upstream changes so an empty diff can pass when they meet the criteria", () => {
    const prompt = acceptancePrompt({
      ...input,
      diff: null,
      upstream: [
        { title: "按码点截断", diff: "diff --git a/parse.test.ts b/parse.test.ts\n+it('emoji')" },
        { title: "没有改动的任务", diff: null },
      ],
    });
    expect(prompt).toContain("Diff:\n```diff\n(no changes)\n```");
    expect(prompt).toContain(
      "Upstream changes already on this branch:\n\n### 按码点截断\n```diff\ndiff --git a/parse.test.ts",
    );
    expect(prompt).not.toContain("没有改动的任务");
    expect(acceptanceSystem(input)).toContain("an empty diff passes when the upstream changes meet every criterion");
  });

  it("leaves the upstream block out when there is nothing upstream", () => {
    expect(acceptancePrompt(input)).not.toContain("Upstream changes");
  });

  it("shows the request as written and asks for a literal check of its formats", () => {
    const prompt = acceptancePrompt({ ...input, request: "示例：\n```\n## 用户\n\n你好\n```" });
    expect(prompt).toContain("The request as written");
    expect(prompt).toContain("````markdown\n示例：");
    expect(acceptanceSystem(input)).toContain("compare the change against it literally");
    expect(acceptancePrompt(input)).not.toContain("The request as written");
  });

  it("lists the request's other tasks so their work is not held against this one", () => {
    const prompt = acceptancePrompt({ ...input, others: ["更新锦囊文档"] });
    expect(prompt).toContain("Other tasks of this request, judged separately:\n- 更新锦囊文档");
    expect(acceptancePrompt(input)).not.toContain("Other tasks");
    expect(acceptanceSystem(input)).toContain("Judge the result, not where it is done");
  });
});

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
});

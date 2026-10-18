import type { Decision } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { createSimulatedLlm } from "../discussion/simulator";
import { type DocumentLlm, reviseSections, writeDocument } from "./engine";

function streamingLlm(text: string) {
  const calls: { role: string; purpose: string; system?: string; prompt: string }[] = [];
  const llm = {
    async structured() {
      throw new Error("not used");
    },
    async stream(
      role: string,
      call: { purpose: string; system?: string; prompt: string },
      onDelta: (t: string) => void,
    ) {
      calls.push({ role, purpose: call.purpose, system: call.system, prompt: call.prompt });
      for (const piece of text.match(/[\s\S]{1,7}/g) ?? []) onDelta(piece);
      return text;
    },
  } as unknown as DocumentLlm;
  return { llm, calls };
}

const decision = (key: string, text: string, extra: Partial<Decision> = {}): Decision => ({
  key,
  stage: "brief",
  value: { text },
  source: "user",
  rationale: null,
  alternatives: [],
  dependsOn: [],
  needsReview: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

const input = {
  language: "zh-CN" as const,
  kind: "brief" as const,
  title: "博客评论",
  description: "给现有的博客加上评论功能",
  triage: null,
  decisions: [
    decision("brief_scope", "文章页评论，含审核"),
    decision("brief_approach", "复用现有用户表", { alternatives: ["第三方评论服务"], rationale: "数据留在自己库里" }),
  ],
};

describe("writeDocument", () => {
  it("streams one planner call and splits the answer into the template's sections", async () => {
    const { llm, calls } = streamingLlm("@@section:goal\n让读者能评论\n@@section:scope\n- 文章页\n@@section:extra\nx");
    const deltas: string[] = [];
    const bodies = await writeDocument(llm, input, (delta) => deltas.push(delta));

    expect(Object.fromEntries(bodies)).toEqual({ goal: "让读者能评论", scope: "- 文章页" });
    expect(deltas.join("")).toContain("@@section:scope");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ role: "planner", purpose: "document.brief" });
    // The ledger carries values, reasons and rejected alternatives; every section is listed in order.
    expect(calls[0]?.prompt).toContain("实现思路 (brief_approach): 复用现有用户表");
    expect(calls[0]?.prompt).toContain("rejected: 第三方评论服务");
    expect(calls[0]?.prompt).toMatch(/- goal \(目标\)[\s\S]*- acceptance \(验收标准\)[\s\S]*- open_questions/);
    expect(calls[0]?.system).toContain("当……时，系统应当……");
  });

  it("fails as retryable when the answer has no section markers", async () => {
    const { llm } = streamingLlm("# 博客评论\n\n一些没有分节的内容");
    await expect(writeDocument(llm, input, () => undefined)).rejects.toMatchObject({
      kind: "validation",
      retryable: true,
    });
  });
});

describe("reviseSections", () => {
  const current = [
    { id: "goal", title: "目标", body: "旧目标" },
    { id: "scope", title: "范围", body: "旧范围" },
  ];

  it("keeps only the requested sections even when the model rewrites more", async () => {
    const { llm, calls } = streamingLlm("@@section:goal\n新目标\n@@section:scope\n不该改");
    const bodies = await reviseSections(llm, { ...input, current, targetIds: ["goal"], instruction: "更简短" });
    expect(Object.fromEntries(bodies)).toEqual({ goal: "新目标" });
    expect(calls[0]?.purpose).toBe("document.brief.revise");
    expect(calls[0]?.prompt).toContain("@@section:scope\n## 范围\n旧范围");
    expect(calls[0]?.prompt).toContain("Instruction: 更简短");
    expect(calls[0]?.prompt).toMatch(/Sections to rewrite:\n- goal \(目标\)[^\n]*\n\nInstruction/);
  });

  it("rewrites from the decisions when no instruction is given", async () => {
    const { llm, calls } = streamingLlm("@@section:scope\n新范围");
    await reviseSections(llm, { ...input, current, targetIds: ["scope"], instruction: null });
    expect(calls[0]?.prompt).toContain("match the current decision ledger");
  });
});

describe("simulated model", () => {
  it("writes every section of a document and revises only what was asked", async () => {
    const llm = createSimulatedLlm();
    const bodies = await writeDocument(llm, { ...input, kind: "prd" }, () => undefined);
    expect([...bodies.keys()]).toEqual([
      "background",
      "positioning",
      "users_scenarios",
      "functional",
      "non_functional",
      "non_goals",
      "success",
      "open_questions",
    ]);
    const revised = await reviseSections(llm, {
      ...input,
      current: [],
      targetIds: ["scope"],
      instruction: "加上不做的部分",
    });
    expect([...revised.keys()]).toEqual(["scope"]);
    expect(revised.get("scope")).toContain("已按要求修订：加上不做的部分");
  });
});

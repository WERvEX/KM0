import { createSimulatedLlm } from "@km0/core";
import type { DocumentProgress } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database";
import { DocumentService } from "./document-service";
import { ProjectService } from "./project-service";

function setup() {
  const db = openDatabase(":memory:");
  const llm = createSimulatedLlm();
  const events: DocumentProgress[] = [];
  const projects = new ProjectService(
    db,
    () => llm,
    () => "zh-CN",
  );
  const documents = new DocumentService(
    db,
    () => llm,
    () => "zh-CN",
    (event, payload) => {
      if (event === "document.progress") events.push(payload as DocumentProgress);
    },
  );
  return { projects, documents, events };
}

/** A full-path project whose four stages were closed by taking the recommendations. */
async function discussedProject(projects: ProjectService) {
  let project = await projects.create("从零做一个团队内部的需求管理平台", null);
  expect(project.path).toBe("full");
  for (let stage = 0; stage < 4; stage += 1) project = await projects.advance(project.id, true);
  expect(project).toMatchObject({ stage: "documents", discussionComplete: true });
  return project;
}

const bodies = (view: { sections: { id: string; body: string }[] }) =>
  Object.fromEntries(view.sections.map((section) => [section.id, section.body]));

describe("documents", () => {
  it("refuses to write before the discussion ends or for another path's document", async () => {
    const { projects, documents } = setup();
    const early = await projects.create("从零做一个团队内部的需求管理平台", null);
    await expect(documents.generate(early.id, "prd", false)).rejects.toMatchObject({ kind: "conflict" });
    await discussedProject(projects);
    await expect(documents.generate(early.id, "brief", false)).rejects.toMatchObject({ kind: "conflict" });
  });

  it("streams a generation and stores every section with the decisions it was written from", async () => {
    const { projects, documents, events } = setup();
    const project = await discussedProject(projects);
    expect(project.documents).toEqual([
      { kind: "prd", version: null, staleSections: 0, openQuestions: 0, updatedAt: null },
      { kind: "tech_design", version: null, staleSections: 0, openQuestions: 0, updatedAt: null },
    ]);

    const view = await documents.generate(project.id, "prd", false);
    expect(view).toMatchObject({ kind: "prd", version: 1, origin: "generated", latest: true, fileName: "PRD.md" });
    expect(view.sections.map((section) => section.title)).toEqual([
      "背景与目标",
      "项目定位与规模",
      "目标用户与核心场景",
      "功能需求",
      "非功能需求",
      "非目标",
      "成功标准",
      "待定问题",
    ]);
    expect(view.sections.every((section) => section.body.length > 0 && section.staleKeys.length === 0)).toBe(true);
    expect(view.markdown).toMatch(/^# .+ · 产品需求文档\n\n## 1\. 背景与目标\n\n/);

    expect(events[0]).toMatchObject({ kind: "prd", phase: "start" });
    expect(events.at(-1)).toMatchObject({ kind: "prd", phase: "done" });
    const streamed = events.filter((event) => event.phase === "delta").map((event) => event.delta);
    expect(streamed.join("")).toContain("@@section:open_questions");

    expect((await projects.get(project.id)).documents[0]).toMatchObject({ version: 1, staleSections: 0 });
  });

  it("lists the open questions of the latest version and counts them for the project page", async () => {
    const { projects, documents } = setup();
    const project = await discussedProject(projects);
    await documents.generate(project.id, "prd", false);
    const view = await documents.saveSection(
      project.id,
      "prd",
      1,
      "open_questions",
      "以下按假设处理：\n\n- 优先级怎么打分？假设按价值和紧急度。\n  - 补充说明不算一条\n2. 需求有哪些状态？",
    );
    expect(view.openQuestions).toEqual(["优先级怎么打分？假设按价值和紧急度。", "需求有哪些状态？"]);
    expect((await projects.get(project.id)).documents[0]).toMatchObject({ version: 2, openQuestions: 2 });

    const none = await documents.saveSection(project.id, "prd", 2, "open_questions", "无。");
    expect(none.openQuestions).toEqual([]);
  });

  it("marks only the sections built on a changed decision as stale, and revises only those", async () => {
    const { projects, documents } = setup();
    const project = await discussedProject(projects);
    const first = await documents.generate(project.id, "prd", false);

    const changed = await projects.updateDecision(project.id, "mvp_features", { text: "需求看板、评论、导出" });
    expect(changed.documents[0]).toMatchObject({ version: 1, staleSections: 3 });
    const stale = (await documents.get(project.id, "prd"))?.sections.filter((section) => section.staleKeys.length);
    expect(stale?.map((section) => [section.id, section.staleKeys])).toEqual([
      ["functional", ["mvp_features"]],
      ["non_goals", ["mvp_features"]],
      ["open_questions", ["mvp_features"]],
    ]);

    const revised = await documents.revise(project.id, "prd", 1, ["functional", "non_goals", "open_questions"], null);
    expect(revised).toMatchObject({ version: 2, origin: "revised", note: null });
    expect(revised.sections.every((section) => section.staleKeys.length === 0)).toBe(true);
    const before = bodies(first);
    const after = bodies(revised);
    for (const id of ["background", "positioning", "users_scenarios", "non_functional", "success"]) {
      expect(after[id]).toBe(before[id]);
    }
    expect(after.functional).toContain("已按要求修订");
    expect(after.functional).not.toBe(before.functional);
  });

  it("keeps hand edits as their own versions and protects them on request when regenerating", async () => {
    const { projects, documents } = setup();
    const project = await discussedProject(projects);
    await documents.generate(project.id, "tech_design", false);

    const edited = await documents.saveSection(project.id, "tech_design", 1, "risks", "  只有一个风险：工期。 ");
    expect(edited).toMatchObject({ version: 2, origin: "edited" });
    expect(edited.sections.find((section) => section.id === "risks")).toMatchObject({
      body: "只有一个风险：工期。",
      edited: true,
    });
    // An edit made on an outdated version is rejected instead of silently overwriting.
    await expect(documents.saveSection(project.id, "tech_design", 1, "risks", "x")).rejects.toMatchObject({
      kind: "conflict",
    });

    const kept = await documents.generate(project.id, "tech_design", true);
    expect(kept.sections.find((section) => section.id === "risks")).toMatchObject({
      body: "只有一个风险：工期。",
      edited: true,
    });
    const replaced = await documents.generate(project.id, "tech_design", false);
    expect(replaced.sections.find((section) => section.id === "risks")?.edited).toBe(false);

    const restored = await documents.restore(project.id, "tech_design", 2);
    expect(restored).toMatchObject({ version: 5, origin: "restored", note: "2", latest: true });
    expect(bodies(restored)).toEqual(bodies(edited));
    expect(restored.versions.map((item) => [item.version, item.origin])).toEqual([
      [5, "restored"],
      [4, "generated"],
      [3, "generated"],
      [2, "edited"],
      [1, "generated"],
    ]);
    expect(await documents.get(project.id, "tech_design", 1)).toMatchObject({ version: 1, latest: false });
  });
});

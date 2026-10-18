import { createSimulatedLlm } from "@km0/core";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database";
import { AgentStore } from "./agent-store";
import { DocumentService } from "./document-service";
import { HandoffService } from "./handoff-service";
import { ProjectService } from "./project-service";
import { RoutingService } from "./routing-service";

function setup() {
  const db = openDatabase(":memory:");
  const llm = createSimulatedLlm();
  const language = () => "zh-CN" as const;
  const routing = new RoutingService(db, () => llm, language, new AgentStore(db));
  return {
    projects: new ProjectService(db, () => llm, language),
    documents: new DocumentService(
      db,
      () => llm,
      language,
      () => undefined,
    ),
    routing,
    handoff: new HandoffService(db, routing, language),
  };
}

describe("hand-off", () => {
  it("needs routed tasks first", async () => {
    const { projects, handoff } = setup();
    const project = await projects.advance((await projects.create("修复登录页按钮上的错别字", null)).id, true);
    expect(() => handoff.build(project.id)).toThrow(expect.objectContaining({ kind: "conflict" }));
  });

  it("packages the latest documents and every routed task, and moves the project to hand-off", async () => {
    const { projects, documents, routing, handoff } = setup();
    let project = await projects.create("给现有的博客加上评论功能", null);
    project = await projects.advance(project.id, true);
    await documents.generate(project.id, "brief", false);
    await documents.saveSection(project.id, "brief", 1, "scope", "只做文章页评论");
    await routing.plan(project.id);

    const pkg = handoff.build(project.id);
    expect(pkg.files.map((file) => file.path)).toEqual([
      "km0/README.md",
      "km0/docs/BRIEF.md",
      "km0/tasks.json",
      "km0/tasks/01.md",
      "km0/tasks/02.md",
      "km0/tasks/03.md",
      "km0/agents/CLAUDE.md",
    ]);
    // The edited version of the brief is the one handed over.
    expect(pkg.files.find((file) => file.path === "km0/docs/BRIEF.md")?.content).toContain("只做文章页评论");
    expect(pkg.tasks[1]?.prompt).toContain("只做文章页评论");
    expect((await projects.get(project.id)).stage).toBe("handoff");
  });
});

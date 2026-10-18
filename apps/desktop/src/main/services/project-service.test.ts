import { createSimulatedLlm, type DiscussionLlm } from "@km0/core";
import { AppError, type ProjectDetail } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database";
import { ProjectService } from "./project-service";
import type { RepoAccess } from "./repo-access";

function setup(llm: DiscussionLlm = createSimulatedLlm()) {
  const db = openDatabase(":memory:");
  return {
    db,
    service: new ProjectService(
      db,
      () => llm,
      () => "zh-CN",
    ),
  };
}

/** Answers every open question with its recommended option. */
function recommended(project: ProjectDetail) {
  const round = project.openRound;
  if (!round) throw new Error("no open round");
  return {
    roundId: round.id,
    answers: round.questions.map((question) => ({
      questionId: question.id,
      optionIds: question.options.filter((option) => option.recommended).map((option) => option.id),
    })),
  };
}

function stageStatus(project: ProjectDetail) {
  return Object.fromEntries(project.stages.map((stage) => [stage.stage, stage.status]));
}

describe("fast path", () => {
  it("confirms scope and acceptance in one round and finishes the discussion", async () => {
    const { service } = setup();
    let project = await service.create("修复登录页按钮上的错别字", null);
    expect(project).toMatchObject({ path: "fast", stage: "confirm", error: null });
    expect(project.triage).toMatchObject({ taskType: "bugfix", complexity: "S", suggestedPath: "fast" });
    expect(project.openRound?.questions.map((question) => question.decisionKey)).toEqual(["scope", "acceptance"]);

    const { roundId, answers } = recommended(project);
    project = await service.answer(project.id, roundId, answers);
    expect(project.openRound).toBeNull();
    expect(stageStatus(project)).toEqual({ confirm: "ready" });
    expect(project.decisions.map((decision) => [decision.key, decision.source])).toEqual([
      ["scope", "recommended"],
      ["acceptance", "recommended"],
    ]);

    project = await service.advance(project.id, false);
    // The fast path writes no documents.
    expect(project).toMatchObject({ stage: "routing", discussionComplete: true, documents: [] });
  });
});

describe("light path", () => {
  it("allows one follow-up round and then stops asking", async () => {
    const { service } = setup();
    let project = await service.create("给现有的博客加上评论功能", null);
    expect(project).toMatchObject({ path: "light", stage: "brief" });
    expect(project.openRound?.questions.map((question) => question.decisionKey)).toEqual([
      "brief_scope",
      "brief_approach",
      "brief_acceptance",
    ]);
    const first = recommended(project);
    project = await service.answer(project.id, first.roundId, first.answers);
    expect(stageStatus(project)).toEqual({ brief: "ready" });

    project = await service.askMore(project.id);
    expect(project.openRound?.questions.map((question) => question.decisionKey)).toEqual(["brief_constraints"]);
    const second = recommended(project);
    project = await service.answer(project.id, second.roundId, second.answers);
    expect(project.stages[0]).toMatchObject({ status: "ready", roundsUsed: 2, maxRounds: 2 });
    await expect(service.askMore(project.id)).rejects.toMatchObject({ kind: "conflict" });
  });
});

describe("full path", () => {
  it("walks the four stages by adopting the recommendations", async () => {
    const { service } = setup();
    let project = await service.create("从零做一个团队需求管理平台", null);
    expect(project).toMatchObject({ path: "full", stage: "scale" });
    expect(stageStatus(project)).toEqual({
      scale: "active",
      requirements: "pending",
      tech: "pending",
      implementation: "pending",
    });

    for (const next of ["requirements", "tech", "implementation", "documents"]) {
      project = await service.advance(project.id, true);
      expect(project.stage).toBe(next);
    }
    expect(project.discussionComplete).toBe(true);
    const keys = project.decisions.map((decision) => decision.key);
    expect(keys).toEqual(expect.arrayContaining(["scale", "target_users", "backend", "architecture", "milestones"]));
    expect(project.stages.every((stage) => stage.missingKeys.length === 0)).toBe(true);
  });

  it("refuses to move on while required questions are unanswered", async () => {
    const { service } = setup();
    const project = await service.create("从零做一个团队需求管理平台", null);
    await expect(service.advance(project.id, false)).rejects.toMatchObject({ kind: "conflict" });
  });

  it("flags dependent decisions when an earlier one changes, and re-checks them", async () => {
    const { service } = setup();
    let project = await service.create("从零做一个团队需求管理平台", null);
    project = await service.advance(project.id, true);
    project = await service.advance(project.id, true);
    project = await service.advance(project.id, true);
    expect(project.stage).toBe("implementation");

    project = await service.updateDecision(project.id, "scale", { text: "企业级系统" });
    const flagged = project.decisions.filter((decision) => decision.needsReview).map((decision) => decision.key);
    expect(flagged).toEqual(expect.arrayContaining(["user_scale", "auth", "target_users", "storage", "deployment"]));
    expect(flagged).not.toContain("scale");
    expect(project.stages.find((stage) => stage.stage === "tech")?.reviewKeys).toEqual(
      expect.arrayContaining(["storage", "deployment"]),
    );

    project = await service.review(project.id, "tech");
    expect(project.openRound).toMatchObject({ stage: "tech", review: true });
    // Four tech decisions are flagged; review rounds continue until none is left.
    let rounds = 0;
    while (project.openRound?.review) {
      const keep = project.openRound.questions.map((question) => ({ questionId: question.id, optionIds: ["keep"] }));
      project = await service.answer(project.id, project.openRound.id, keep);
      rounds += 1;
    }
    expect(rounds).toBe(2);
    expect(project.stages.find((stage) => stage.stage === "tech")?.reviewKeys).toEqual([]);
    expect(project.decisions.find((decision) => decision.key === "storage")?.value.text).toBe("storage 方案 A");
    // Back in the current stage, its unanswered round was set aside and is asked again.
    expect(project.stage).toBe("implementation");
    expect(project.openRound).toMatchObject({ stage: "implementation", review: false });
  });
});

describe("round integrity", () => {
  it("accepts an answer once and rejects a stale or duplicate submission", async () => {
    const { service } = setup();
    const project = await service.create("修复登录页按钮上的错别字", null);
    const { roundId, answers } = recommended(project);
    const results = await Promise.allSettled([
      service.answer(project.id, roundId, answers),
      service.answer(project.id, roundId, answers),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ kind: "conflict" });
  });

  it("lets the AI decide delegated questions", async () => {
    const { service } = setup();
    let project = await service.create("修复登录页按钮上的错别字", null);
    const round = project.openRound;
    project = await service.answer(
      project.id,
      round?.id ?? 0,
      (round?.questions ?? []).map((question) => ({ questionId: question.id, delegate: true })),
    );
    expect(project.decisions.map((decision) => [decision.key, decision.source])).toEqual([
      ["scope", "ai"],
      ["acceptance", "ai"],
    ]);
    expect(stageStatus(project)).toEqual({ confirm: "ready" });
  });
});

describe("path changes and failures", () => {
  it("restarts the discussion when the user switches to the full path", async () => {
    const { service } = setup();
    let project = await service.create("修复登录页按钮上的错别字", null);
    project = await service.setPath(project.id, "full");
    expect(project).toMatchObject({ path: "full", stage: "scale" });
    expect(project.openRound?.stage).toBe("scale");
    expect(project.stages.map((stage) => stage.stage)).toEqual(["scale", "requirements", "tech", "implementation"]);
  });

  it("returns a retryable error when question generation fails, and recovers on retry", async () => {
    const simulated = createSimulatedLlm();
    let failNext = false;
    const flaky: DiscussionLlm = {
      structured: (role, call) => {
        if (failNext && call.purpose.startsWith("questions.")) {
          failNext = false;
          return Promise.reject(new AppError("upstream", "Rate limited"));
        }
        return simulated.structured(role, call);
      },
    };
    const { service } = setup(flaky);
    failNext = true;
    let project = await service.create("修复登录页按钮上的错别字", null);
    expect(project.error).toMatchObject({ kind: "upstream", retryable: true });
    expect(project.openRound).toBeNull();

    project = await service.retry(project.id);
    expect(project.error).toBeNull();
    expect(project.openRound?.questions).toHaveLength(2);
  });

  it("does not create a project when triage fails", async () => {
    const failing: DiscussionLlm = {
      structured: () => Promise.reject(new AppError("config", "No model is configured yet.")),
    };
    const { service } = setup(failing);
    await expect(service.create("修复登录页按钮上的错别字", null)).rejects.toMatchObject({ kind: "config" });
    expect(service.list()).toEqual([]);
  });
});

describe("research and linked repositories", () => {
  const repoAccess = (files: Record<string, string>): RepoAccess => ({
    pick: async () => "/work/ledger",
    open: async () => ({
      name: "ledger",
      fs: {
        list: async (dir) =>
          dir === "" ? Object.keys(files).map((name) => ({ name, dir: false })) : Promise.reject(new Error("none")),
        read: async (file) => files[file] ?? null,
      },
    }),
  });

  it("checks the tech options once and shows the evidence on the round", async () => {
    const queries: string[] = [];
    const searchPort = () => ({
      name: "Bocha",
      search: async (query: string) => {
        queries.push(query);
        return [{ title: "Result", url: "https://example.com", snippet: "current" }];
      },
    });
    const db = openDatabase(":memory:");
    const service = new ProjectService(
      db,
      () => createSimulatedLlm(),
      () => "zh-CN",
      { searchPort },
    );
    let project = await service.create("从零做一个团队需求管理平台", null);
    project = await service.advance(project.id, true);
    expect(project.openRound?.research ?? null).toBeNull();
    project = await service.advance(project.id, true);
    expect(project.stage).toBe("tech");
    expect(project.openRound?.research).toMatchObject({ status: "verified", service: "Bocha" });
    const searched = queries.length;
    expect(searched).toBeGreaterThan(0);
    expect(searched).toBeLessThanOrEqual(3);

    // The next round reuses the evidence instead of searching again.
    const { roundId, answers } = recommended(project);
    project = await service.answer(project.id, roundId, answers);
    if (!project.openRound) project = await service.askMore(project.id);
    expect(project.openRound?.research).toMatchObject({ status: "verified" });
    expect(queries.length).toBe(searched);
  });

  it("marks the tech stage unverified without a search service", async () => {
    const { service } = setup();
    let project = await service.create("从零做一个团队需求管理平台", null);
    project = await service.advance(project.id, true);
    project = await service.advance(project.id, true);
    expect(project.openRound?.research).toEqual({ status: "unverified", service: null, findings: [] });
  });

  it("scans a linked repository and keeps its stack in the tech stage", async () => {
    const db = openDatabase(":memory:");
    const repo = repoAccess({
      "package.json": JSON.stringify({ dependencies: { react: "19", express: "5", pg: "8" } }),
    });
    const service = new ProjectService(
      db,
      () => createSimulatedLlm(),
      () => "zh-CN",
      { repo },
    );
    let project = await service.create("从零做一个团队需求管理平台", "/work/ledger");
    expect(project.repoPath).toBe("/work/ledger");
    expect(project.repoScan?.stack.map((item) => item.name)).toEqual(["React", "Express", "PostgreSQL"]);
    expect(project.triage?.hasCodebase).toBe(true);
    expect(project.decisions.filter((decision) => decision.stage === "tech").map((d) => [d.key, d.value.text])).toEqual(
      [
        ["frontend", "React"],
        ["backend", "Express"],
        ["storage", "PostgreSQL"],
      ],
    );

    project = await service.advance(project.id, true);
    project = await service.advance(project.id, true);
    // Of the required layers, only the one the scan could not see is asked about.
    expect(project.openRound?.questions.map((question) => question.decisionKey)).toEqual(["deployment", "auth_impl"]);
  });

  it("refuses a repository it cannot open", async () => {
    const { service } = setup();
    await expect(service.create("给现有的博客加上评论功能", "/nowhere")).rejects.toMatchObject({ kind: "config" });
  });
});

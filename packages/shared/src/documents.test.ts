import { describe, expect, it } from "vitest";
import { DOCUMENT_TEMPLATES, renderDocument, splitSections, staleKeys } from "./documents";

describe("splitSections", () => {
  const ids = ["goal", "scope", "approach"];

  it("splits marker-delimited output and drops preamble, unknown ids and repeated headings", () => {
    const text = [
      "Sure, here is the document.",
      "@@section:goal",
      "## 目标",
      "Ship comments.",
      "",
      "@@section:bogus",
      "ignored",
      "@@section:scope (in and out)",
      "- In: comments",
      "---",
    ].join("\n");
    expect([...splitSections(text, ids)]).toEqual([
      ["goal", "Ship comments."],
      ["scope", "- In: comments"],
    ]);
  });

  it("keeps the first copy of a repeated section and works on partial output", () => {
    const text = "@@section:goal\nFirst\n@@section:goal\nSecond\n@@section:approach\nStill wri";
    expect(Object.fromEntries(splitSections(text, ids))).toEqual({ goal: "First", approach: "Still wri" });
  });
});

describe("staleKeys", () => {
  it("reports decisions whose value changed, appeared or disappeared since the section was written", () => {
    const current = new Map([
      ["scale", "本地工具"],
      ["storage", "PostgreSQL"],
      ["auth", "免登录"],
    ]);
    expect(staleKeys({ scale: "本地工具", storage: "SQLite", auth: null, timeline: "两周" }, current)).toEqual([
      "storage",
      "auth",
      "timeline",
    ]);
  });
});

describe("templates", () => {
  it("give every document unique section ids and render numbered headings", () => {
    for (const template of Object.values(DOCUMENT_TEMPLATES)) {
      const ids = template.sections.map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(
      renderDocument("评论功能", [
        { title: "目标", body: "上线评论" },
        { title: "范围", body: "" },
      ]),
    ).toBe("# 评论功能\n\n## 1. 目标\n\n上线评论\n\n## 2. 范围\n");
  });
});

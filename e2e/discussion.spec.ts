import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type LaunchedApp, launchApp } from "./launch";

let launched: LaunchedApp;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp({ KM0_FAKE_LLM: "1" });
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
});

async function startTask(description: string) {
  await page.getByRole("link", { name: /新建任务/ }).click();
  await page.getByRole("textbox", { name: "从一句话开始" }).fill(description);
  await page.getByRole("button", { name: "开始分诊" }).click();
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("从一句话开始");
}

test("a small fix takes the fast path and finishes in one round", async () => {
  await startTask("修复登录页按钮上的错别字");
  await expect(page.getByRole("combobox", { name: "通道" })).toHaveValue("fast");
  await expect(page.getByText("确认范围 · 第 1 轮")).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/fast-round.png" });

  await page.getByRole("button", { name: "填入推荐答案" }).click();
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByText("本阶段的关键决策已确定")).toBeVisible();
  await page.getByRole("button", { name: "完成讨论" }).click();
  await expect(page.getByText("讨论完成")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "决策账本" }).getByText("采用推荐")).toHaveCount(2);

  // The fast path goes straight to one cheap task.
  await page.getByRole("button", { name: "拆解任务并路由" }).click();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("table").getByText("claude-haiku-5-5")).toBeVisible();
});

test("a new project walks the four stages, and editing a decision flags its dependents", async () => {
  await startTask("从零做一个团队需求管理平台");
  await expect(page.getByRole("combobox", { name: "通道" })).toHaveValue("full");
  await expect(page.getByText("A 定位与规模 · 第 1 轮")).toBeVisible();

  // Answer the first round by hand: pick a delivery form, take an option, and type a custom answer.
  const round = page.locator("section").filter({ hasText: "第 1 轮" });
  await round.getByRole("radio", { name: /企业级系统/ }).check();
  await round.getByRole("group").nth(1).getByRole("radio").first().check();
  await round.getByRole("group").nth(2).getByRole("textbox").fill("只处理内部数据");
  await page.screenshot({ path: "test-results/screenshots/full-round.png" });
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByText("本阶段的关键决策已确定")).toBeVisible();

  const ledger = page.getByRole("complementary", { name: "决策账本" });
  await expect(ledger.getByText("企业级系统")).toBeVisible();
  await expect(ledger.getByText("只处理内部数据")).toBeVisible();

  await page.getByRole("button", { name: "进入下一阶段" }).click();
  for (const stage of ["B 产品需求", "C 技术选型", "D 实现方案"]) {
    await expect(page.getByText(`${stage} · 第 1 轮`)).toBeVisible();
    await page.getByRole("button", { name: "跳过剩余问题，进入下一阶段" }).click();
  }
  // Skipped questions and leftover keys are decided by the AI and marked as such.
  await expect(ledger.getByText("AI 决定", { exact: true }).first()).toBeVisible();

  // Closing the last stage writes the PRD and the technical design side by side.
  await expect(page.getByRole("tab", { name: /产品需求文档/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "8. 待定问题" })).toBeVisible();
  await page.getByRole("tab", { name: /技术方案/ }).click();
  await expect(page.getByRole("heading", { name: "10. 风险" })).toBeVisible();
  await page.getByRole("tab", { name: /产品需求文档/ }).click();
  await page.screenshot({ path: "test-results/screenshots/full-documents.png" });

  await ledger.getByRole("button", { name: "修改 交付形态" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("在线部署");
  await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  await expect(ledger.getByText("需复核").first()).toBeVisible();
  // Only the sections written from the delivery form are marked stale.
  await expect(
    page.getByText("4 个小节依据的决策已改动：背景与目标、项目定位与规模、非功能需求、待定问题"),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/needs-review.png" });

  await ledger.getByRole("button", { name: "复核此阶段" }).first().click();
  await expect(page.getByText(/复核/).first()).toBeVisible();
  await expect(page.getByText("这些决策依赖的内容变了")).toBeVisible();
});

test("a full-path task goes from one sentence to a hand-off package, then is renamed and deleted", async () => {
  await startTask("从零做一个内部知识库平台");
  for (const stage of ["A 定位与规模", "B 产品需求", "C 技术选型", "D 实现方案"]) {
    await expect(page.getByText(`${stage} · 第 1 轮`)).toBeVisible();
    if (stage === "A 定位与规模") await page.screenshot({ path: "test-results/screenshots/p5-1-questions.png" });
    await page.getByRole("button", { name: "跳过剩余问题，进入下一阶段" }).click();
  }
  await expect(page.getByRole("heading", { name: "8. 待定问题" })).toBeVisible();
  await page.getByRole("tab", { name: /技术方案/ }).click();
  await expect(page.getByRole("heading", { name: "10. 风险" })).toBeVisible();
  await page.getByRole("tab", { name: /产品需求文档/ }).click();
  await page.screenshot({ path: "test-results/screenshots/p5-2-documents.png" });

  await page.getByRole("tab", { name: "任务与路由" }).click();
  await page.getByRole("button", { name: "拆解任务并路由" }).click();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(4);
  await page.screenshot({ path: "test-results/screenshots/p5-3-routing.png" });

  await page.getByRole("button", { name: "生成交接包" }).click();
  await expect(page.getByRole("navigation", { name: "包内文件" }).getByText("km0/docs/TECH_DESIGN.md")).toBeVisible();
  const progress = page.getByRole("list", { name: "进度" });
  await expect(progress.locator('[aria-current="step"]')).toHaveText("交接");
  await page.screenshot({ path: "test-results/screenshots/p5-4-handoff.png", fullPage: true });

  const sidebar = page.getByRole("navigation", { name: "任务" });
  await expect(sidebar.getByText("已生成交接包")).toBeVisible();
  await sidebar.getByRole("button", { name: "重命名 从零做一个内部知识库平台" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("内部知识库");
  await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  await expect(sidebar.getByText("内部知识库", { exact: true })).toBeVisible();

  await sidebar.getByRole("button", { name: "删除 内部知识库" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
  await expect(sidebar.getByText("内部知识库", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("从一句话开始");
});

test("a linked repository is scanned read-only and its stack fills the technology stage", async () => {
  const repo = mkdtempSync(join(tmpdir(), "km0-linked-"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { react: "19", express: "5", pg: "8" } }));
  await page.getByRole("link", { name: /新建任务/ }).click();
  await page.getByRole("button", { name: "关联本地仓库（可选）" }).click();
  // KM0's own folder browser, not a system dialog: type the path, go there, choose it.
  const browser = page.getByRole("dialog", { name: "选择本地仓库" });
  await browser.getByRole("textbox", { name: "路径" }).fill(repo);
  await browser.getByRole("button", { name: "前往" }).click();
  await expect(browser.getByRole("list", { name: repo })).toBeVisible();
  await browser.getByRole("button", { name: "选择此文件夹" }).click();
  await expect(browser).toBeHidden();
  await expect(page.getByText("识别到：React, Express, PostgreSQL")).toBeVisible();
  await page.getByRole("textbox", { name: "从一句话开始" }).fill("从零做一个团队需求管理平台");
  await page.getByRole("button", { name: "开始分诊" }).click();
  await expect(page.getByText(/仓库：km0-linked-/)).toBeVisible();

  await page.getByRole("button", { name: "跳过剩余问题，进入下一阶段" }).click();
  await expect(page.getByText("B 产品需求 · 第 1 轮")).toBeVisible();
  await page.getByRole("button", { name: "跳过剩余问题，进入下一阶段" }).click();
  await expect(page.getByText("C 技术选型 · 第 1 轮")).toBeVisible();
  // No search service is set up, so the round says its options are unverified.
  await expect(page.getByText(/未查证：没有启用搜索服务/)).toBeVisible();
  const ledger = page.getByRole("complementary", { name: "决策账本" });
  await expect(ledger.getByText("Express", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "关于「deployment」，你倾向哪种方案？" })).toBeVisible();
  await expect(page.getByRole("group", { name: "关于「backend」，你倾向哪种方案？" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/screenshots/repo-tech.png", fullPage: true });
});

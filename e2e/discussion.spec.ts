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
});

test("a new project walks the four stages, and editing a decision flags its dependents", async () => {
  await startTask("从零做一个团队需求管理平台");
  await expect(page.getByRole("combobox", { name: "通道" })).toHaveValue("full");
  await expect(page.getByText("A 定位与规模 · 第 1 轮")).toBeVisible();

  // Answer the first round by hand: pick a delivery form, let the AI decide another question.
  const round = page.locator("section").filter({ hasText: "第 1 轮" });
  await round.getByRole("radio", { name: /企业级系统/ }).check();
  await round.getByRole("group").nth(1).getByRole("radio").first().check();
  await round.getByRole("group").nth(2).getByLabel("交给 AI 决定").check();
  await page.screenshot({ path: "test-results/screenshots/full-round.png" });
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByText("本阶段的关键决策已确定")).toBeVisible();

  const ledger = page.getByRole("complementary", { name: "决策账本" });
  await expect(ledger.getByText("企业级系统")).toBeVisible();
  await expect(ledger.getByText("AI 决定", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "进入下一阶段" }).click();
  for (const stage of ["B 产品需求", "C 技术选型", "D 实现方案"]) {
    await expect(page.getByText(`${stage} · 第 1 轮`)).toBeVisible();
    await page.getByRole("button", { name: "全部采用推荐，进入下一阶段" }).click();
  }
  await expect(page.getByText("讨论完成")).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/full-done.png" });

  await ledger.getByRole("button", { name: "修改 交付形态" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("在线部署");
  await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  await expect(ledger.getByText("需复核").first()).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/needs-review.png" });

  await ledger.getByRole("button", { name: "复核此阶段" }).first().click();
  await expect(page.getByText(/复核/).first()).toBeVisible();
  await expect(page.getByText("这些决策依赖的内容变了")).toBeVisible();
});

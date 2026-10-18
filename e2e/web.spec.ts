import { expect, test } from "@playwright/test";

test.use({ locale: "zh-CN" });

test("the browser debug build runs a discussion with the simulated model and keeps it across reloads", async ({
  page,
}) => {
  await page.goto("./?simulated=1#/");
  await expect(page.getByText(/网页调试版/)).toBeVisible();
  await expect(page.getByText("当前使用模拟模型，不调用真实 API。")).toBeVisible();

  await page.getByRole("textbox", { name: "从一句话开始" }).fill("修复登录页按钮上的错别字");
  await page.getByRole("button", { name: "开始分诊" }).click();
  await expect(page.getByText("确认范围 · 第 1 轮")).toBeVisible();
  await page.getByRole("button", { name: "填入推荐答案" }).click();
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByText("本阶段的关键决策已确定")).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/web-round.png" });

  // Saves are deferred a moment; hiding the page flushes them, and a reload reads them back.
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "任务" }).getByText("修复登录页按钮上的错别字")).toBeVisible();
  await expect(page.getByText("本阶段的关键决策已确定")).toBeVisible();
});

test("the real-model build asks for a model first and offers the simulated one", async ({ page }) => {
  await page.goto("./#/");
  await expect(page.getByRole("link", { name: "改用模拟模型" })).toBeVisible();
  await page.getByRole("link", { name: "设置" }).click();
  await page.getByRole("tab", { name: "关于" }).click();
  await expect(page.getByText("IndexedDB · km0-web", { exact: true })).toBeVisible();
});

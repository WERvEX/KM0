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

test("documents are written after the discussion and can be edited, revised and versioned", async ({ page }) => {
  await page.goto("./?simulated=1#/");
  await page.getByRole("textbox", { name: "从一句话开始" }).fill("给现有的博客加上评论功能");
  await page.getByRole("button", { name: "开始分诊" }).click();
  await expect(page.getByText("需求与方案 · 第 1 轮")).toBeVisible();
  await page.getByRole("button", { name: "跳过剩余问题，进入下一阶段" }).click();

  // The light path writes one combined brief.
  await expect(page.getByRole("tab", { name: /需求与方案（精简版）/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "6. 待定问题" })).toBeVisible();

  const scope = page.getByRole("region", { name: "2. 范围" });
  await scope.getByRole("button", { name: "编辑" }).click();
  await scope.getByRole("textbox").fill("- 做：文章页评论\n- 不做：私信");
  await scope.getByRole("button", { name: "保存" }).click();
  await expect(scope.getByText("手动修改")).toBeVisible();
  await expect(scope.getByText("不做：私信")).toBeVisible();

  const approach = page.getByRole("region", { name: "3. 实现思路" });
  await approach.getByRole("button", { name: "AI 修订" }).click();
  await approach.getByRole("textbox").fill("说明要改哪些文件");
  await approach.getByRole("button", { name: "修订" }).click();
  await expect(approach.getByText("已按要求修订：说明要改哪些文件")).toBeVisible();
  // Revising one section leaves the hand-edited one alone.
  await expect(scope.getByText("不做：私信")).toBeVisible();

  const versions = page.getByRole("combobox", { name: "版本" });
  await expect(versions.locator("option")).toHaveCount(3);
  await versions.selectOption("1");
  await expect(page.getByText("正在查看 v1，旧版本只读。")).toBeVisible();
  await expect(scope.getByText("不做：私信")).toHaveCount(0);
  await page.getByRole("button", { name: "回到最新版本" }).click();

  // Changing a decision marks only the sections written from it.
  const ledger = page.getByRole("complementary", { name: "决策账本" });
  await ledger.getByRole("button", { name: "修改 范围" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("文章页评论，含楼中楼回复");
  await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  await expect(
    page.getByText("5 个小节依据的决策已改动：目标、范围、实现思路、验收标准、待定问题"),
  ).toBeVisible();
  await page.getByRole("button", { name: "按新决策更新这些小节" }).click();
  // The hand-edited scope section is about to be rewritten, so KM0 asks first.
  await expect(page.getByRole("dialog", { name: "将覆盖手动修改" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "继续" }).click();
  await expect(page.getByText(/个小节依据的决策已改动/)).toHaveCount(0);
  await expect(versions.locator("option")).toHaveCount(4);
  await page.screenshot({ path: "test-results/screenshots/web-documents.png", fullPage: true });
});

test("the real-model build asks for a model first and offers the simulated one", async ({ page }) => {
  await page.goto("./#/");
  await expect(page.getByRole("link", { name: "改用模拟模型" })).toBeVisible();
  await page.getByRole("link", { name: "设置" }).click();
  await page.getByRole("tab", { name: "关于" }).click();
  await expect(page.getByText("IndexedDB · km0-web", { exact: true })).toBeVisible();
});

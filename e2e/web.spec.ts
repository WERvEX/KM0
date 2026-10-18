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
  await expect(page.getByText("5 个小节依据的决策已改动：目标、范围、实现思路、验收标准、待定问题")).toBeVisible();
  await page.getByRole("button", { name: "按新决策更新这些小节" }).click();
  // The hand-edited scope section is about to be rewritten, so KM0 asks first.
  await expect(page.getByRole("dialog", { name: "将覆盖手动修改" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "继续" }).click();
  await expect(page.getByText(/个小节依据的决策已改动/)).toHaveCount(0);
  await expect(versions.locator("option")).toHaveCount(4);
  await page.screenshot({ path: "test-results/screenshots/web-documents.png", fullPage: true });
});

test("tasks are routed by rules, can be overridden, and show the saving once prices are set", async ({ page }) => {
  await page.goto("./?simulated=1#/");
  await page.getByRole("textbox", { name: "从一句话开始" }).fill("给现有的博客加上评论功能");
  await page.getByRole("button", { name: "开始分诊" }).click();
  await page.getByRole("button", { name: "跳过剩余问题，进入下一阶段" }).click();
  await expect(page.getByRole("heading", { name: "6. 待定问题" })).toBeVisible();

  await page.getByRole("tab", { name: "任务与路由" }).click();
  await page.getByRole("button", { name: "拆解任务并路由" }).click();
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(page.getByText("共 3 个任务")).toBeVisible();
  await expect(page.getByText("3 个任务的模型没有填价格，未计入合计。")).toBeVisible();
  await expect(table.getByText("claude-opus-5-5")).toBeVisible();
  await expect(table.getByText("建议拆分")).toBeVisible();

  // Open the design task, read why it is T3, and move it to T2 by hand.
  await table.getByRole("button", { name: "设计数据模型与权限" }).click();
  await expect(page.getByText("需要设计决策 → T3")).toBeVisible();
  await page.getByRole("combobox", { name: "档位" }).selectOption("T2");
  await expect(table.getByText("已手动调整")).toBeVisible();
  await expect(table.getByText("claude-sonnet-5-5")).toHaveCount(2);
  await page.screenshot({ path: "test-results/screenshots/web-routing.png", fullPage: true });
  await page.getByRole("button", { name: "恢复规则结果" }).click();
  await expect(table.getByText("已手动调整")).toHaveCount(0);

  // With prices for Claude Code the plan is totalled and compared with running all on T3.
  await page.getByRole("link", { name: "去设置 → Agent 填写价格" }).click();
  await page.getByRole("tab", { name: "Agent" }).click();
  const claude = page.getByRole("region", { name: "Claude Code" });
  for (const [tier, input, output] of [
    ["T1", "1", "5"],
    ["T2", "3", "15"],
    ["T3", "5", "25"],
  ]) {
    await claude.getByRole("textbox", { name: `Claude Code ${tier} 输入单价` }).fill(input);
    await claude.getByRole("textbox", { name: `Claude Code ${tier} 输出单价` }).fill(output);
  }
  await claude.getByRole("button", { name: "保存" }).click();
  await expect(claude.getByRole("button", { name: "保存" })).toHaveCount(0);

  await page.getByRole("navigation", { name: "任务" }).getByText("给现有的博客加上评论功能").click();
  await page.getByRole("tab", { name: "任务与路由" }).click();
  await expect(page.getByText(/预估成本 \$/)).toBeVisible();
  await expect(page.getByText(/节省约 \d+%/)).toBeVisible();

  // The hand-off package collects a brief per task and downloads as one zip.
  await page.getByRole("button", { name: "生成交接包" }).click();
  const files = page.getByRole("navigation", { name: "包内文件" });
  await expect(files.getByRole("button", { name: "km0/tasks/03.md" })).toBeVisible();
  await expect(files.getByRole("button", { name: "km0/agents/CLAUDE.md" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /任务 01：搭建项目骨架与说明文档/ })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 zip" }).click();
  expect((await download).suggestedFilename()).toMatch(/^km0-handoff-\d+\.zip$/);
  await page.screenshot({ path: "test-results/screenshots/web-handoff.png", fullPage: true });
});

test("the real-model build asks for a model first and offers the simulated one", async ({ page }) => {
  await page.goto("./#/");
  await expect(page.getByRole("link", { name: "改用模拟模型" })).toBeVisible();
  await page.getByRole("link", { name: "设置" }).click();
  await page.getByRole("tab", { name: "关于" }).click();
  await expect(page.getByText("IndexedDB · km0-web", { exact: true })).toBeVisible();
});

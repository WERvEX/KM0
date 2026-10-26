import { expect, test } from "./guards";

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

  // Open questions are listed above the document and answered in one revision.
  const open = page.getByRole("region", { name: "6. 待定问题" });
  await open.getByRole("button", { name: "编辑" }).click();
  await open.getByRole("textbox").fill("- 评论要审核吗？假设不审核。\n- 游客能评论吗？假设不能。");
  await open.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("这份文档还有 2 条待定问题，目前按文档里的假设处理：")).toBeVisible();
  await page.getByRole("button", { name: "回答这些问题" }).click();
  await page.getByRole("dialog", { name: "回答待定问题" }).getByRole("textbox").fill("评论先审核后显示");
  await page.getByRole("dialog").getByRole("button", { name: "更新文档" }).click();
  await expect(page.getByRole("dialog", { name: "将覆盖手动修改" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "继续" }).click();
  await expect(page.getByText(/条待定问题，目前按文档里的假设处理/)).toHaveCount(0);
  await expect(versions.locator("option")).toHaveCount(6);
  await page.screenshot({ path: "test-results/screenshots/web-documents.png", fullPage: true });
});

test("tasks are routed by rules, priced from the registry, and can be overridden", async ({ page }) => {
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
  // Claude Code's models are matched to the registry, so official prices total the plan straight away.
  await expect(page.getByText(/预估成本 \$/)).toBeVisible();
  await expect(page.getByText(/节省约 \d+%/)).toBeVisible();
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

  // Two failed runs on T1 move the scaffolding task up to T2; clearing them moves it back.
  await table.getByRole("button", { name: "搭建项目骨架与说明文档" }).click();
  await page.getByRole("button", { name: "记一次失败" }).click();
  await expect(table.getByText("失败 1 次")).toBeVisible();
  await page.getByRole("button", { name: "记一次失败" }).click();
  await expect(table.getByText("由 T1 升档")).toBeVisible();
  await expect(page.getByText("T1 已失败 2 次 → 升到 T2")).toBeVisible();
  await expect(table.getByText("claude-sonnet-5-5")).toHaveCount(2);
  await page.getByRole("button", { name: "清除失败记录" }).click();
  await expect(table.getByText("由 T1 升档")).toHaveCount(0);
  await expect(table.getByText("claude-haiku-5-5")).toBeVisible();

  // The hand-off package collects a brief per task and downloads as one zip.
  await page.getByRole("button", { name: "生成交接包" }).click();
  const files = page.getByRole("navigation", { name: "包内文件" });
  await expect(files.getByRole("button", { name: "km0/tasks/03.md" })).toBeVisible();
  await expect(files.getByRole("button", { name: "km0/agents/CLAUDE.md" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /任务 01：搭建项目骨架与说明文档/ })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存 zip" }).click();
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

test("technology questions are checked with a search service, which can be exported and imported", async ({ page }) => {
  // A remote MCP search server, answered in-page: initialize, then one result per search.
  const searches: string[] = [];
  await page.route("https://search.example.com/mcp", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fulfill({ status: 405 });
    const message = request.postDataJSON() as { id?: number; method: string; params?: { arguments?: { q?: string } } };
    if (message.id === undefined) return route.fulfill({ status: 202 });
    const reply = (result: unknown) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
      });
    if (message.method === "initialize") {
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-search", version: "1.0.0" },
      });
    }
    if (message.method === "tools/call") {
      const query = message.params?.arguments?.q ?? "";
      searches.push(query);
      return reply({
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { title: `关于 ${query}`, url: "https://docs.example.com/a", snippet: "最新稳定版" },
            ]),
          },
        ],
      });
    }
    return reply({});
  });

  await page.goto("./?simulated=1#/");
  await page.getByRole("link", { name: "设置" }).click();
  await page.getByRole("tab", { name: "搜索服务" }).click();
  await page.getByRole("button", { name: "添加搜索服务" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("名称").fill("测试搜索");
  await form.getByLabel("类型").selectOption("mcp_http");
  await form.getByLabel("服务器地址").fill("https://search.example.com/mcp");
  await form.getByLabel("搜索工具名").fill("web_search");
  await form.getByLabel("查询参数名").fill("q");
  await form.getByLabel("请求头（可选）").fill("Authorization=Bearer test");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("用于查证")).toBeVisible();
  await page.getByRole("button", { name: "测试" }).click();
  await expect(page.getByText(/可用 · 1 条结果/)).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/web-search.png", fullPage: true });

  // Export the settings, then import them back: the service is matched by name and updated.
  await page.getByRole("tab", { name: "通用" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出配置" }).click();
  const file = await (await download).path();
  // The browser build uses the browser's file chooser, the one place it may.
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入配置" }).click();
  await (await chooser).setFiles(file);
  await expect(page.getByText(/导入完成：.*更新 1 个搜索服务/)).toBeVisible();

  // A full-path project reaches the technology stage with its options checked.
  await page.getByRole("link", { name: "新建任务" }).click();
  await page.getByRole("textbox", { name: "从一句话开始" }).fill("从零做一个团队需求管理平台");
  await page.getByRole("button", { name: "开始分诊" }).click();
  await expect(page.getByText("A 定位与规模 · 第 1 轮")).toBeVisible();
  await page.getByRole("button", { name: "跳过剩余问题，进入下一阶段" }).click();
  await expect(page.getByText("B 产品需求 · 第 1 轮")).toBeVisible();
  await page.getByRole("button", { name: "跳过剩余问题，进入下一阶段" }).click();
  await expect(page.getByText("C 技术选型 · 第 1 轮")).toBeVisible();
  await expect(page.getByText("已查证 · 测试搜索")).toBeVisible();
  expect(searches.length).toBeGreaterThan(0);
  expect(searches.length).toBeLessThanOrEqual(3);
  await page.getByText("已查证 · 测试搜索").click();
  await expect(page.getByRole("link", { name: /^关于 / }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/web-research.png", fullPage: true });
});

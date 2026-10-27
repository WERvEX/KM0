import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";
import { guardNativeDialogs } from "./guards";

const appDir = join(import.meta.dirname, "../apps/desktop");
let app: ElectronApplication;
let page: Page;
let dataDir: string;
let checkDialogs: () => Promise<void>;

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "km0-e2e-"));
  app = await electron.launch({
    args: [appDir, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    cwd: appDir,
    env: { ...process.env, KM0_USER_DATA_DIR: dataDir, LANG: "zh_CN.UTF-8" },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1360, height: 860 });
  checkDialogs = await guardNativeDialogs(app, page);
});

test.afterAll(async () => {
  try {
    await checkDialogs?.();
  } finally {
    await app?.close();
  }
  rmSync(dataDir, { recursive: true, force: true });
});

test("shows the empty workspace and asks for a model first", async () => {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("KM0", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/workspace.png" });
});

test("adds a provider and a model, which becomes the router and is matched to the registry", async () => {
  await page.getByRole("link", { name: /设置|Settings/ }).click();
  await page.getByRole("button", { name: /添加服务商|Add provider/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("#apiKey").fill("sk-e2e-test-key-1234");
  await page.screenshot({ path: "test-results/screenshots/provider-form.png" });
  await dialog.getByRole("button", { name: /保存|Save/ }).click();
  await expect(dialog).toBeHidden();
  const provider = page.getByRole("listitem", { name: "DeepSeek" });
  await expect(provider.getByText(/••••1234/)).toBeVisible();

  await provider.getByRole("button", { name: /添加模型|Add model/ }).click();
  await dialog.locator("#modelId").fill("deepseek-v4-flash");
  await dialog.getByRole("button", { name: /保存|Save/ }).click();
  await expect(dialog).toBeHidden();
  const model = provider.getByRole("listitem", { name: "deepseek-v4-flash" });
  await expect(model.getByText("deepseek/deepseek-v4-flash")).toBeVisible();
  await expect(model.getByText(/官方价格|official price/)).toBeVisible();
  await expect(page.locator("#role-router")).toHaveValue(/\d+/);
  await page.screenshot({ path: "test-results/screenshots/settings.png", fullPage: true });
});

test("never exposes Node APIs to the page", async () => {
  const exposed = await page.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    bridge: Object.keys((globalThis as unknown as { km0: object }).km0),
  }));
  expect(exposed).toEqual({ require: "undefined", process: "undefined", bridge: ["invoke", "on"] });
});

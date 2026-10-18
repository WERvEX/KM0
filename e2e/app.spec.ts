import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";

const appDir = join(import.meta.dirname, "../apps/desktop");
let app: ElectronApplication;
let page: Page;
let dataDir: string;

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "km0-e2e-"));
  app = await electron.launch({
    args: [appDir, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    cwd: appDir,
    env: { ...process.env, KM0_USER_DATA_DIR: dataDir, LANG: "zh_CN.UTF-8" },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1360, height: 860 });
});

test.afterAll(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("shows the empty workspace and asks for a model first", async () => {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("KM0", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/workspace.png" });
});

test("adds a model profile and assigns it as the router", async () => {
  await page.getByRole("link", { name: /设置|Settings/ }).click();
  await page
    .getByRole("button", { name: /添加模型|Add model/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("#apiKey").fill("sk-e2e-test-key-1234");
  await page.screenshot({ path: "test-results/screenshots/profile-form.png" });
  await dialog.getByRole("button", { name: /保存|Save/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("••••1234")).toBeVisible();
  await expect(page.locator("#role-router")).toHaveValue(/\d+/);
  await page.screenshot({ path: "test-results/screenshots/settings.png" });
});

test("never exposes Node APIs to the page", async () => {
  const exposed = await page.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    bridge: Object.keys((globalThis as unknown as { km0: object }).km0),
  }));
  expect(exposed).toEqual({ require: "undefined", process: "undefined", bridge: ["invoke"] });
});

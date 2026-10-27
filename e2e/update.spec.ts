import { expect, type Page, test } from "@playwright/test";
import { type LaunchedApp, launchApp } from "./launch";

// A release that is always newer (KM0_FAKE_UPDATE): found on start, downloaded and installed from About.
let launched: LaunchedApp;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp({ KM0_FAKE_LLM: "1", KM0_FAKE_UPDATE: "1.0.1" });
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
});

const section = () => page.getByRole("region", { name: "更新" });

test("a newer version is announced on start and installed from the About page", async () => {
  await expect(page.getByText("KM0 1.0.1 可以更新了。")).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "test-results/screenshots/update-toast.png" });
  await page.getByRole("button", { name: "查看" }).click();

  await expect(section().getByRole("status")).toHaveText("KM0 1.0.1 可以更新了。");
  await section().getByText("更新说明").click();
  await expect(section().getByText("Fixes found after 1.0.0.")).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/update-available.png" });

  await section().getByRole("button", { name: "下载" }).click();
  await expect(section().getByRole("status")).toContainText("正在下载 1.0.1");
  await page.screenshot({ path: "test-results/screenshots/update-downloading.png" });
  await expect(section().getByRole("status")).toHaveText("1.0.1 已下载，重启 KM0 后安装。");
  await page.screenshot({ path: "test-results/screenshots/update-downloaded.png" });

  await section().getByRole("button", { name: "重启并安装" }).click();
  await expect.poll(() => launched.app.evaluate(() => process.env.KM0_FAKE_UPDATE_INSTALLED ?? null)).toBe("1");
});

test("checking on start can be turned off", async () => {
  const auto = section().getByRole("checkbox", { name: "启动时自动检查更新" });
  await expect(auto).toBeChecked();
  await auto.uncheck();
  await expect(auto).not.toBeChecked();
  await page.reload();
  await expect(section().getByRole("checkbox", { name: "启动时自动检查更新" })).not.toBeChecked();
});

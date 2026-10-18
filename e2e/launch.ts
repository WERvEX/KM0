import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, _electron as electron, type Page } from "@playwright/test";

const appDir = join(import.meta.dirname, "../apps/desktop");

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  close: () => Promise<void>;
}

/** Start the built app with an isolated data folder. */
export async function launchApp(env: Record<string, string> = {}): Promise<LaunchedApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "km0-e2e-"));
  const app = await electron.launch({
    args: [appDir, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    cwd: appDir,
    env: { ...process.env, KM0_USER_DATA_DIR: dataDir, LANG: "zh_CN.UTF-8", ...env },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1360, height: 860 });
  return {
    app,
    page,
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

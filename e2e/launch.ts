import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, _electron as electron, expect, type Page } from "@playwright/test";
import { guardNativeDialogs } from "./guards";

const appDir = join(import.meta.dirname, "../apps/desktop");

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  /** Closes the app; fails if it opened a system dialog at any point. */
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
  // The window stays hidden until its first paint; a screenshot of a hidden window fails.
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false))
    .toBe(true);
  await page.setViewportSize({ width: 1360, height: 860 });
  const checkDialogs = await guardNativeDialogs(app, page);
  return {
    app,
    page,
    dataDir,
    close: async () => {
      try {
        await checkDialogs();
      } finally {
        await app.close();
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

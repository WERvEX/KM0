import { defineConfig } from "@playwright/test";

const WEB_PORT = 4173;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  // The browser debug build; the Electron specs launch the app themselves.
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}/`,
    viewport: { width: 1360, height: 860 },
    // Lets a machine with a preinstalled Chromium skip `playwright install`.
    ...(process.env.KM0_CHROMIUM ? { launchOptions: { executablePath: process.env.KM0_CHROMIUM } } : {}),
  },
  webServer: {
    command: `pnpm web:build && pnpm --filter @km0/desktop web:preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
    url: `http://127.0.0.1:${WEB_PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

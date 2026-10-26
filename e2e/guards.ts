import { test as base, type ElectronApplication, expect, type Page } from "@playwright/test";

const DIALOG_METHODS = [
  "showOpenDialog",
  "showOpenDialogSync",
  "showSaveDialog",
  "showSaveDialogSync",
  "showMessageBox",
  "showMessageBoxSync",
  "showErrorBox",
  "showCertificateTrustDialog",
] as const;

/** What the page opened that is not KM0's own UI: alert / confirm / prompt, file choosers, downloads. */
function watchPage(page: Page, options: { files: boolean }): string[] {
  const seen: string[] = [];
  page.on("dialog", (dialog) => {
    seen.push(`page ${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  if (options.files) {
    page.on("filechooser", () => seen.push("page file chooser"));
    page.on("download", (download) => seen.push(`page download: ${download.suggestedFilename()}`));
  }
  return seen;
}

/**
 * Fails the test when the desktop app opens any system dialog. Electron's dialog functions are
 * replaced by ones that record the call and throw, so a stray call also breaks the flow under test.
 */
export async function guardNativeDialogs(app: ElectronApplication, page: Page): Promise<() => Promise<void>> {
  const seen = watchPage(page, { files: true });
  await app.evaluate(({ dialog }, methods) => {
    const calls: string[] = [];
    (globalThis as { __km0NativeDialogs?: string[] }).__km0NativeDialogs = calls;
    for (const method of methods) {
      (dialog as unknown as Record<string, unknown>)[method] = () => {
        calls.push(`electron dialog.${method}`);
        throw new Error(`KM0 must not open a system dialog (dialog.${method})`);
      };
    }
  }, DIALOG_METHODS);
  return async () => {
    const main = await app
      .evaluate(() => (globalThis as { __km0NativeDialogs?: string[] }).__km0NativeDialogs ?? [])
      .catch(() => []);
    expect([...seen, ...main], "native dialogs opened").toEqual([]);
  };
}

/**
 * The browser debug build may use the browser's file chooser and downloads (it has no other way to
 * reach the disk), but never alert / confirm / prompt or a leave-page prompt.
 */
export const test = base.extend<{ noBrowserDialogs: undefined }>({
  noBrowserDialogs: [
    async ({ page }, use) => {
      const seen = watchPage(page, { files: false });
      await use(undefined);
      expect(seen, "browser dialogs opened").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

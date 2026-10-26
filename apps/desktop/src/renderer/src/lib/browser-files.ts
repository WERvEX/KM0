/**
 * The browser debug build cannot reach the disk through KM0's main process, so it falls back to the
 * browser's own file chooser and downloads. This is the only place the renderer uses them; the
 * desktop app always uses KM0's file browser (see scripts/check-ui-rules.mjs).
 */

export function chooseFileInBrowser(extensions: string[]): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = extensions.map((ext) => `.${ext}`).join(",");
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      void file.text().then(
        (text) => resolve({ name: file.name, text }),
        () => resolve(null),
      );
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

export function downloadInBrowser(name: string, blob: Blob): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

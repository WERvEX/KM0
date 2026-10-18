import { readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as {
  version: string;
};

const OUT_DIR = resolve(import.meta.dirname, "out/web");

/** Static hosts serve index.html, so the web entry is renamed on the way out. */
function webIndex(): Plugin {
  return {
    name: "km0-web-index",
    apply: "build",
    closeBundle() {
      renameSync(resolve(OUT_DIR, "web.html"), resolve(OUT_DIR, "index.html"));
    },
  };
}

/**
 * The browser debug build: the renderer plus the services running in-page (see src/web).
 * Relative asset paths let it work under any sub-path, e.g. GitHub Pages.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  base: "./",
  resolve: { alias: { "@": resolve(import.meta.dirname, "src/renderer/src") } },
  define: { "import.meta.env.KM0_VERSION": JSON.stringify(version) },
  plugins: [react(), tailwindcss(), webIndex()],
  server: { open: "/web.html" },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    target: "es2022",
    // A debug build; one bundle is fine.
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { web: resolve(import.meta.dirname, "src/renderer/web.html") } },
  },
});

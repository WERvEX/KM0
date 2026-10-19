import { defineConfig } from "vitest/config";

/** Runs scripts/live-run.ts only; it calls a real model and is never part of `pnpm test`. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/live-run.ts"],
    testTimeout: 60 * 60 * 1000,
  },
});

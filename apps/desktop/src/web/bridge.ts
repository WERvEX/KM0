import { createGateway, createSimulatedLlm } from "@km0/core";
import type { Km0Bridge } from "@km0/shared";
import initSqlJs from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url";
import { migrations } from "../main/db/migrations";
import { migrate } from "../main/db/sql";
import { createHandlers } from "../main/handlers";
import { createDispatcher } from "../main/ipc/router";
import { llmPort } from "../main/services/llm-port";
import { ProjectService } from "../main/services/project-service";
import { PlainSecretStore } from "../main/services/secrets";
import { SettingsStore } from "../main/services/settings-store";
import { indexedDbStore, SqlJsAdapter } from "./sqljs-database";

export interface WebBridgeOptions {
  /** Use the deterministic stand-in model instead of a real one. */
  simulated: boolean;
  version: string;
}

export function storageName(simulated: boolean): string {
  // Demo data stays apart from real projects.
  return simulated ? "km0-web-simulated" : "km0-web";
}

/**
 * The browser debug build: the same services the desktop main process runs, wired in-page.
 * Data lives in IndexedDB and API keys are only obfuscated, so this is for testing, not daily use.
 */
export async function createWebBridge({ simulated, version }: WebBridgeOptions): Promise<Km0Bridge> {
  const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
  const db = await SqlJsAdapter.open(SQL, indexedDbStore(storageName(simulated)));
  migrate(db, migrations);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void db.flush();
  });
  window.addEventListener("pagehide", () => void db.flush());

  const secrets = new PlainSecretStore();
  const settings = new SettingsStore(db, secrets);
  const gateway = createGateway({
    recordCall: (record) => settings.recordCall(record),
    onModeDetected: (profileId, mode) => {
      if (settings.getProfile(profileId).structuredMode === "auto") settings.setStructuredMode(profileId, mode);
    },
  });
  const projects = new ProjectService(
    db,
    simulated ? () => createSimulatedLlm() : (projectId) => llmPort(gateway, settings, projectId),
    () => {
      const language = settings.getPreferences().language;
      if (language !== "system") return language;
      return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
    },
  );
  const dispatch = createDispatcher(
    createHandlers({
      settings,
      projects,
      gateway,
      appInfo: () => ({
        name: "KM0",
        version,
        platform: "web",
        dataDir: `IndexedDB · ${storageName(simulated)}`,
        secureStorage: false,
        simulatedModel: simulated,
      }),
    }),
    (channel, error) => console.warn(`[km0] ${channel} failed (${error.kind}): ${error.message}`),
  );
  return {
    // A structured clone mirrors what Electron IPC does, so the UI never shares objects with the services.
    invoke: async (channel, input) => structuredClone(await dispatch(channel, input)) as never,
  };
}

import { createGateway, createSimulatedLlm } from "@km0/core";
import type { EmitEvent, Km0Bridge } from "@km0/shared";
import initSqlJs from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url";
import { migrations } from "../main/db/migrations";
import { migrate } from "../main/db/sql";
import { createHandlers } from "../main/handlers";
import { createDispatcher } from "../main/ipc/router";
import { AgentStore } from "../main/services/agent-store";
import { ConfigService } from "../main/services/config-service";
import { DocumentService } from "../main/services/document-service";
import { HandoffService } from "../main/services/handoff-service";
import { llmPort } from "../main/services/llm-port";
import { ProjectService } from "../main/services/project-service";
import { RoutingService } from "../main/services/routing-service";
import { SearchStore } from "../main/services/search-store";
import { PlainSecretStore } from "../main/services/secrets";
import { SettingsStore } from "../main/services/settings-store";
import { webRepoAccess } from "./repo-access";
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
  const fake = simulated ? createSimulatedLlm({ streamDelayMs: 15 }) : null;
  const llmFor = (projectId: number | null) => fake ?? llmPort(gateway, settings, projectId);
  const language = () => {
    const preferred = settings.getPreferences().language;
    if (preferred !== "system") return preferred;
    return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  };
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const emit: EmitEvent = (event, payload) => {
    const copy = structuredClone(payload);
    for (const listener of listeners.get(event) ?? []) listener(copy);
  };
  // No local processes in a browser: only Bocha and remote MCP servers work here.
  const search = new SearchStore(db, secrets, {});
  const repo = webRepoAccess();
  const projects = new ProjectService(db, llmFor, language, { searchPort: () => search.activePort(), repo });
  const documents = new DocumentService(db, llmFor, language, emit);
  const agents = new AgentStore(db);
  const config = new ConfigService(settings, agents, search);
  const routing = new RoutingService(db, llmFor, language, agents, () => settings.getRoutingRules().rules);
  const handoff = new HandoffService(db, routing, language);
  const dispatch = createDispatcher(
    createHandlers({
      settings,
      projects,
      documents,
      routing,
      handoff,
      agents,
      search,
      config,
      repo,
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
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      const wrapped = listener as (payload: unknown) => void;
      set.add(wrapped);
      return () => {
        set.delete(wrapped);
      };
    },
  };
}

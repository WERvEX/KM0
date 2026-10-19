import { join } from "node:path";
import { createGateway, createSimulatedLlm } from "@km0/core";
import { type EmitEvent, IPC_EVENT, IPC_INVOKE } from "@km0/shared";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import log from "electron-log/main";
import { openDatabase } from "./db/database";
import { ElectronSecretStore } from "./electron-secrets";
import { createHandlers } from "./handlers";
import { createDispatcher } from "./ipc/router";
import { nodeRepoAccess } from "./node-repo-access";
import { nodeRunAccess } from "./node-run-access";
import { AgentStore } from "./services/agent-store";
import { ConfigService } from "./services/config-service";
import { DocumentService } from "./services/document-service";
import { HandoffService } from "./services/handoff-service";
import { llmPort } from "./services/llm-port";
import { ProjectService } from "./services/project-service";
import { RoutingService } from "./services/routing-service";
import { RunnerService } from "./services/runner-service";
import { SearchStore } from "./services/search-store";
import { SettingsStore } from "./services/settings-store";

const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL;

// Keep data in a stable, readable folder: %APPDATA%\KM0, ~/Library/Application Support/KM0, ~/.config/KM0.
app.setName("KM0");
// KM0_USER_DATA_DIR isolates end-to-end test runs from the real profile.
app.setPath("userData", process.env.KM0_USER_DATA_DIR ?? join(app.getPath("appData"), "KM0"));
log.initialize();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

function isAppUrl(url: string): boolean {
  if (DEV_SERVER_URL) return url.startsWith(DEV_SERVER_URL);
  return url.startsWith("file://");
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "KM0",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // Links open in the user's browser; the app window never navigates away from the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  if (DEV_SERVER_URL) void window.loadURL(DEV_SERVER_URL);
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return window;
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("web-contents-created", (_event, contents) => {
  // No <webview> tags: the renderer never needs to embed foreign pages.
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

void app.whenReady().then(() => {
  const dataDir = app.getPath("userData");
  const db = openDatabase(join(dataDir, "km0.db"));
  const secrets = new ElectronSecretStore();
  const settings = new SettingsStore(db, secrets);
  const gateway = createGateway({
    recordCall: (record) => settings.recordCall(record),
    onModeDetected: (profileId, mode) => {
      if (settings.getProfile(profileId).structuredMode === "auto") settings.setStructuredMode(profileId, mode);
    },
  });
  // KM0_FAKE_LLM=1 swaps in a deterministic model for end-to-end tests and demos without an API key.
  const simulated = process.env.KM0_FAKE_LLM === "1" ? createSimulatedLlm({ streamDelayMs: 15 }) : null;
  const llmFor = (projectId: number | null) => simulated ?? llmPort(gateway, settings, projectId);
  const language = () => {
    const preferred = settings.getPreferences().language;
    if (preferred !== "system") return preferred;
    return app.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  };
  const emit: EmitEvent = (event, payload) => mainWindow?.webContents.send(IPC_EVENT, { event, payload });
  const search = new SearchStore(db, secrets, {
    // Local MCP servers inherit a minimal safe environment plus the variables the user configured.
    stdio: (command, args, env) =>
      new StdioClientTransport({ command, args, env: { ...getDefaultEnvironment(), ...env }, stderr: "ignore" }),
  });
  const pickFolder = async () => {
    const options = { title: "KM0", properties: ["openDirectory" as const] };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };
  const repo = nodeRepoAccess(pickFolder);
  const projects = new ProjectService(db, llmFor, language, { searchPort: () => search.activePort(), repo });
  const documents = new DocumentService(db, llmFor, language, emit);
  const agents = new AgentStore(db);
  const config = new ConfigService(settings, agents, search);
  const routing = new RoutingService(db, llmFor, language, agents, () => settings.getRoutingRules().rules);
  const handoff = new HandoffService(db, routing, language);
  const runner = new RunnerService(db, nodeRunAccess(pickFolder), routing, llmFor, language, () =>
    simulated ? "simulated" : settings.profileForRole("planner").model,
  );

  const dispatch = createDispatcher(
    createHandlers({
      settings,
      projects,
      documents,
      routing,
      handoff,
      runner,
      agents,
      search,
      config,
      repo,
      gateway,
      appInfo: () => ({
        name: "KM0",
        version: app.getVersion(),
        platform: process.platform,
        dataDir,
        secureStorage: secrets.secure,
        simulatedModel: process.env.KM0_FAKE_LLM === "1",
      }),
    }),
    (channel, error) => log.warn(`[ipc] ${channel} failed (${error.kind}): ${error.message}`),
  );

  ipcMain.handle(IPC_INVOKE, (event, payload: { channel?: unknown; input?: unknown } | undefined) => {
    // Only our own page may call into the main process.
    const frameUrl = event.senderFrame?.url ?? "";
    if (!isAppUrl(frameUrl)) throw new Error("Rejected IPC call from an unexpected origin");
    return dispatch(payload?.channel, payload?.input);
  });

  mainWindow = createWindow();
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
  app.on("will-quit", () => db.close());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

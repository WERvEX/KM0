import { join } from "node:path";
import { createGateway } from "@km0/core";
import { IPC_INVOKE } from "@km0/shared";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import log from "electron-log/main";
import { openDatabase } from "./db/database";
import { ElectronSecretStore } from "./electron-secrets";
import { createHandlers } from "./handlers";
import { createDispatcher } from "./ipc/router";
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
  const gateway = createGateway({ recordCall: (record) => settings.recordCall(record) });

  const dispatch = createDispatcher(
    createHandlers({
      db,
      settings,
      gateway,
      appInfo: () => ({
        name: "KM0",
        version: app.getVersion(),
        platform: process.platform,
        dataDir,
        secureStorage: secrets.secure,
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

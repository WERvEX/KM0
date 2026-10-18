import type { Km0Bridge } from "@km0/shared";
import { IPC_INVOKE } from "@km0/shared/bridge";
import { contextBridge, ipcRenderer } from "electron";

const bridge: Km0Bridge = {
  invoke: (channel, input) => ipcRenderer.invoke(IPC_INVOKE, { channel, input }),
};

contextBridge.exposeInMainWorld("km0", bridge);

import type { Km0Bridge } from "@km0/shared";
import { IPC_EVENT, IPC_INVOKE } from "@km0/shared/bridge";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

const bridge: Km0Bridge = {
  invoke: (channel, input) => ipcRenderer.invoke(IPC_INVOKE, { channel, input }),
  on: (event, listener) => {
    const handler = (_event: IpcRendererEvent, message: { event: string; payload: unknown }) => {
      if (message.event === event) listener(message.payload as never);
    };
    ipcRenderer.on(IPC_EVENT, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT, handler);
    };
  },
};

contextBridge.exposeInMainWorld("km0", bridge);

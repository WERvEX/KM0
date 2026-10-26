import type { AppNotice, FolderRequest } from "@km0/shared";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileBrowserDialog, type FileBrowserRequest } from "@/components/files/FileBrowserDialog";
import { useToast } from "@/components/ui/toast";
import { chooseFileInBrowser, downloadInBrowser } from "./browser-files";
import { call, errorMessage } from "./ipc";
import { useIpcQuery } from "./queries";

interface OpenFileOptions {
  title: string;
  extensions: string[];
  memoryKey: string;
}

interface SaveFileOptions {
  title: string;
  defaultName: string;
  /** Text, or bytes for binary files such as a zip. */
  content: string | Uint8Array;
  mimeType: string;
  memoryKey: string;
}

interface FileDialogs {
  /** Null when the user cancels. */
  openFile(options: OpenFileOptions): Promise<{ name: string; text: string } | null>;
  /** The saved path, or null when the user cancels. The browser build downloads instead and returns the name. */
  saveFile(options: SaveFileOptions): Promise<string | null>;
}

const FilesContext = createContext<FileDialogs | null>(null);

type Pending =
  | { kind: "path"; request: FileBrowserRequest; resolve: (path: string | null) => void }
  | { kind: "save"; request: FileBrowserRequest; options: SaveFileOptions; resolve: (path: string | null) => void };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Opening and saving files, and the folder requests the main process sends, all through KM0's own
 * file browser. Nothing here opens a system dialog in the desktop app.
 */
export function FileDialogProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const toast = useToast();
  const info = useIpcQuery("app.info");
  const web = info.data?.platform === "web";
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  // The browser unmounts outright when it closes, so it puts focus back where it was itself.
  const returnFocus = useRef<HTMLElement | null>(null);

  const open = useCallback((next: Pending) => {
    pendingRef.current?.resolve(null);
    if (!pendingRef.current) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    pendingRef.current = next;
    setPending(next);
  }, []);
  const finish = useCallback((path: string | null) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(path);
    const target = returnFocus.current;
    returnFocus.current = null;
    setTimeout(() => {
      if (target?.isConnected) target.focus();
    }, 0);
  }, []);

  const choosePath = useCallback(
    (request: FileBrowserRequest) => new Promise<string | null>((resolve) => open({ kind: "path", request, resolve })),
    [open],
  );

  const dialogs = useMemo<FileDialogs>(
    () => ({
      async openFile({ title, extensions, memoryKey }) {
        if (web) return chooseFileInBrowser(extensions);
        const path = await choosePath({ mode: "open", title, extensions, memoryKey });
        return path ? call("files.read", { path }) : null;
      },
      saveFile(options) {
        if (web) {
          downloadInBrowser(options.defaultName, new Blob([options.content as BlobPart], { type: options.mimeType }));
          return Promise.resolve(options.defaultName);
        }
        const extension = options.defaultName.split(".").pop() ?? "";
        const request: FileBrowserRequest = {
          mode: "save",
          title: options.title,
          extensions: extension ? [extension] : [],
          defaultName: options.defaultName,
          memoryKey: options.memoryKey,
        };
        return new Promise((resolve) => open({ kind: "save", request, options, resolve }));
      },
    }),
    [web, choosePath, open],
  );

  // The main process asks for a folder when a service needs one (linking a repository, importing a run).
  useEffect(() => {
    if (web) return;
    return window.km0.on("folder.request", ({ requestId, purpose }: FolderRequest) => {
      const request: FileBrowserRequest =
        purpose === "repo"
          ? { mode: "folder", title: t("files.chooseRepo"), memoryKey: "repo" }
          : { mode: "folder", title: t("files.chooseRun"), hint: t("files.chooseRunHint"), memoryKey: "run" };
      void choosePath(request).then((path) => call("folder.answer", { requestId, path }));
    });
  }, [web, t, choosePath]);

  useEffect(() => {
    return window.km0.on("app.notice", (notice: AppNotice) => {
      toast({
        kind: notice.kind === "error" ? "error" : "info",
        message: t(`notice.${notice.code}`, { detail: notice.detail ?? "" }),
      });
    });
  }, [t, toast]);

  const save = async (dir: string, name: string, overwrite: boolean) => {
    if (pending?.kind !== "save") return;
    const { content } = pending.options;
    const { path } =
      typeof content === "string"
        ? await call("files.save", { dir, name, content, encoding: "utf8", overwrite })
        : await call("files.save", { dir, name, content: toBase64(content), encoding: "base64", overwrite });
    finish(path);
    toast({
      kind: "success",
      message: t("files.saved", { path }),
      action: {
        label: t("files.reveal"),
        onClick: () =>
          void call("files.reveal", { path }).catch((error) => toast({ kind: "error", message: errorMessage(error) })),
      },
    });
  };

  return (
    <FilesContext.Provider value={dialogs}>
      {children}
      <FileBrowserDialog
        request={pending?.request ?? null}
        onCancel={() => finish(null)}
        onChoose={(path) => finish(path)}
        onSave={save}
      />
    </FilesContext.Provider>
  );
}

export function useFiles(): FileDialogs {
  const dialogs = useContext(FilesContext);
  if (!dialogs) throw new Error("useFiles needs a FileDialogProvider");
  return dialogs;
}

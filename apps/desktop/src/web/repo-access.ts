import type { RepoFs } from "@km0/core";
import { AppError } from "@km0/shared";
import type { RepoAccess } from "../main/services/repo-access";

/** The parts of the File System Access API used here; not every TypeScript DOM lib declares them. */
interface DirHandle {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterable<DirHandle | FileHandle>;
  getDirectoryHandle(name: string): Promise<DirHandle>;
  getFileHandle(name: string): Promise<FileHandle>;
}
interface FileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<Blob>;
}
type PickerWindow = Window & { showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<DirHandle> };

function handleFs(root: DirHandle): RepoFs {
  const dirAt = async (path: string) => {
    let handle = root;
    for (const part of path.split("/").filter(Boolean)) handle = await handle.getDirectoryHandle(part);
    return handle;
  };
  return {
    async list(dir) {
      const entries: { name: string; dir: boolean }[] = [];
      for await (const entry of (await dirAt(dir)).values()) {
        entries.push({ name: entry.name, dir: entry.kind === "directory" });
      }
      return entries;
    },
    async read(file, maxBytes) {
      try {
        const parts = file.split("/");
        const name = parts.pop() as string;
        const handle = await (await dirAt(parts.join("/"))).getFileHandle(name);
        return await (await handle.getFile()).slice(0, maxBytes).text();
      } catch {
        return null;
      }
    },
  };
}

/**
 * Folders picked in the browser (Chrome and Edge). The page cannot see real paths, so a picked
 * folder is known by a label such as "web:my-app", valid until the page reloads.
 */
export function webRepoAccess(): RepoAccess {
  const picked = new Map<string, DirHandle>();
  return {
    async pick() {
      const picker = (window as PickerWindow).showDirectoryPicker;
      if (!picker) {
        throw new AppError("config", "This browser cannot open local folders. Use Chrome or Edge, or the desktop app.");
      }
      let handle: DirHandle;
      try {
        handle = await picker.call(window, { mode: "read" });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return null;
        throw error;
      }
      let label = `web:${handle.name}`;
      for (let n = 2; picked.has(label); n += 1) label = `web:${handle.name}#${n}`;
      picked.set(label, handle);
      return label;
    },
    async open(path) {
      const handle = picked.get(path);
      if (!handle) {
        throw new AppError("validation", "This folder is no longer available in the page. Choose it again.");
      }
      return { name: handle.name, fs: handleFs(handle) };
    },
  };
}

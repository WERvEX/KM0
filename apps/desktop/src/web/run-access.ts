import { AppError } from "@km0/shared";
import type { RunAccess } from "../main/services/run-access";

/** The parts of the File System Access API used here; not every TypeScript DOM lib declares them. */
interface DirHandle {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterable<DirHandle | FileHandle>;
  getDirectoryHandle(name: string): Promise<DirHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
}
interface FileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<Blob>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
type PickerWindow = Window & { showDirectoryPicker?: (options?: { mode?: "readwrite" }) => Promise<DirHandle> };

/**
 * Run folders picked in the browser (Chrome and Edge), with write access for acceptance.jsonl. Like
 * repositories, a picked folder is known by a label until the page reloads.
 */
export function webRunAccess(): RunAccess {
  const picked = new Map<string, DirHandle>();
  return {
    async pick() {
      const picker = (window as PickerWindow).showDirectoryPicker;
      if (!picker) {
        throw new AppError("config", "This browser cannot open local folders. Use Chrome or Edge, or the desktop app.");
      }
      let handle: DirHandle;
      try {
        handle = await picker.call(window, { mode: "readwrite" });
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
      const root = picked.get(path);
      if (!root) throw new AppError("validation", "This folder is no longer available in the page. Choose it again.");
      const dirAt = async (parts: string[]) => {
        let handle = root;
        for (const part of parts) handle = await handle.getDirectoryHandle(part);
        return handle;
      };
      const split = (file: string) => {
        const parts = file.split("/").filter(Boolean);
        return { dir: parts.slice(0, -1), name: parts.at(-1) as string };
      };
      return {
        async list(dir) {
          const names: string[] = [];
          try {
            for await (const entry of (await dirAt(dir.split("/").filter(Boolean))).values()) {
              if (entry.kind === "file") names.push(entry.name);
            }
          } catch {
            return [];
          }
          return names;
        },
        async read(file, maxBytes) {
          try {
            const { dir, name } = split(file);
            const handle = await (await dirAt(dir)).getFileHandle(name);
            return await (await handle.getFile()).slice(0, maxBytes).text();
          } catch {
            return null;
          }
        },
        async write(file, content) {
          const { dir, name } = split(file);
          const writable = await (await (await dirAt(dir)).getFileHandle(name, { create: true })).createWritable();
          await writable.write(content);
          await writable.close();
        },
      };
    },
  };
}

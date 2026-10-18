import { open, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import type { RepoFs } from "@km0/core";
import { AppError } from "@km0/shared";
import type { RepoAccess } from "./services/repo-access";

/** Reads a folder on disk. Nothing is written, and symbolic links are not followed out of the folder. */
export function nodeRepoFs(root: string): RepoFs {
  const inside = (relative: string) => {
    const full = resolve(root, ...relative.split("/").filter(Boolean));
    if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) {
      throw new Error(`Path escapes the repository: ${relative}`);
    }
    return full;
  };
  return {
    async list(dir) {
      const entries = await readdir(inside(dir), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }));
    },
    async read(file, maxBytes) {
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        handle = await open(inside(file), "r");
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
      } catch {
        return null;
      } finally {
        await handle?.close();
      }
    },
  };
}

export function nodeRepoAccess(pickFolder: () => Promise<string | null>): RepoAccess {
  return {
    pick: pickFolder,
    async open(path) {
      if (!isAbsolute(path)) throw new AppError("validation", "Choose the repository folder with its full path.");
      const root = resolve(path);
      const info = await stat(root).catch(() => null);
      if (!info?.isDirectory()) throw new AppError("validation", `The folder ${root} does not exist.`);
      return { name: basename(root) || root, fs: nodeRepoFs(root) };
    },
  };
}

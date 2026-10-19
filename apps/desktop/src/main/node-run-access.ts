import { readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { AppError } from "@km0/shared";
import { nodeRepoFs } from "./node-repo-access";
import type { RunAccess } from "./services/run-access";

/** Run directories on disk. Only files inside the picked folder are read or written. */
export function nodeRunAccess(pickFolder: () => Promise<string | null>): RunAccess {
  return {
    pick: pickFolder,
    async open(path) {
      if (!isAbsolute(path)) throw new AppError("validation", "Choose the run folder with its full path.");
      const root = resolve(path);
      const info = await stat(root).catch(() => null);
      if (!info?.isDirectory()) throw new AppError("validation", `The folder ${root} does not exist.`);
      const files = nodeRepoFs(root);
      const inside = (relative: string) => {
        const full = resolve(root, ...relative.split("/").filter(Boolean));
        if (!full.startsWith(root.endsWith(sep) ? root : root + sep)) {
          throw new AppError("validation", `Path escapes the run folder: ${relative}`);
        }
        return full;
      };
      return {
        async list(dir) {
          const entries = await readdir(inside(dir), { withFileTypes: true }).catch(() => []);
          return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
        },
        read: (file, maxBytes) => files.read(file, maxBytes),
        write: (file, content) => writeFile(inside(file), content, "utf8"),
      };
    },
  };
}

import { open, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from "node:path";
import { AppError, type FileEntry, type FilePlace, MAX_READ_BYTES } from "@km0/shared";
import type { FilePort } from "./services/file-port";

/** Entries beyond this are left out of a listing; a folder that large is better reached by typing its path. */
const MAX_ENTRIES = 2000;

const isDir = (path: string) =>
  stat(path)
    .then((info) => info.isDirectory())
    .catch(() => false);

function absolute(path: string, what: string): string {
  if (!isAbsolute(path)) throw new AppError("validation", `Enter the ${what} as a full path.`);
  return resolve(path);
}

async function places(home: string): Promise<FilePlace[]> {
  const result: FilePlace[] = [{ id: "home", label: basename(home) || home, path: home }];
  for (const [id, name] of [
    ["desktop", "Desktop"],
    ["documents", "Documents"],
    ["downloads", "Downloads"],
  ] as const) {
    const path = join(home, name);
    if (await isDir(path)) result.push({ id, label: name, path });
  }
  if (process.platform === "win32") {
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const path = `${letter}:\\`;
      if (await isDir(path)) result.push({ id: "drive", label: `${letter}:`, path });
    }
  } else {
    result.push({ id: "root", label: "/", path: "/" });
    if (process.platform === "darwin") {
      const volumes = await readdir("/Volumes").catch(() => []);
      for (const name of volumes) result.push({ id: "volume", label: name, path: join("/Volumes", name) });
    }
  }
  return result;
}

/** Folders and files on disk for KM0's file browser. Listing and reading never follow a path outside what was asked. */
export function nodeFiles(reveal: (path: string) => void): FilePort {
  const home = homedir();
  return {
    async browse({ path, extensions, showHidden }) {
      const dir = path ? absolute(path, "folder") : home;
      let names: { name: string; dir: boolean; link: boolean }[];
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        names = entries
          .filter((entry) => entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())
          .map((entry) => ({ name: entry.name, dir: entry.isDirectory(), link: entry.isSymbolicLink() }));
      } catch {
        throw new AppError("validation", `The folder ${dir} cannot be opened.`);
      }
      const wanted = new Set(extensions.map((ext) => ext.toLowerCase()));
      const visible = names.filter((entry) => showHidden || !entry.name.startsWith("."));
      const result: FileEntry[] = [];
      for (const entry of visible) {
        const full = join(dir, entry.name);
        // A link counts as a folder only when it points at one.
        const folder = entry.dir || (entry.link && (await isDir(full)));
        if (folder) {
          result.push({ name: entry.name, path: full, dir: true, git: false });
        } else if (wanted.has(extname(entry.name).slice(1).toLowerCase())) {
          result.push({ name: entry.name, path: full, dir: false, git: false });
        }
      }
      const compare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;
      result.sort((a, b) => (a.dir === b.dir ? compare(a.name, b.name) : a.dir ? -1 : 1));
      const shown = result.slice(0, MAX_ENTRIES);
      await Promise.all(
        shown
          .filter((entry) => entry.dir)
          .map(async (entry) => {
            entry.git = await stat(join(entry.path, ".git"))
              .then(() => true)
              .catch(() => false);
          }),
      );
      const top = parse(dir).root === dir;
      return {
        path: dir,
        parent: top ? null : dirname(dir),
        entries: shown,
        truncated: result.length > shown.length,
        places: await places(home),
      };
    },

    async read(path) {
      const file = absolute(path, "file");
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) throw new AppError("validation", `The file ${file} does not exist.`);
      if (info.size > MAX_READ_BYTES) throw new AppError("validation", `The file ${file} is too large to import.`);
      const handle = await open(file, "r");
      try {
        return { name: basename(file), text: (await handle.readFile()).toString("utf8") };
      } finally {
        await handle.close();
      }
    },

    async save({ dir, name, content, encoding, overwrite }) {
      const folder = absolute(dir, "folder");
      if (!(await isDir(folder))) throw new AppError("validation", `The folder ${folder} does not exist.`);
      const file = join(folder, name);
      if (dirname(file) !== folder) throw new AppError("validation", "The file name cannot contain a folder.");
      const data = encoding === "base64" ? Buffer.from(content, "base64") : content;
      try {
        await writeFile(file, data, { flag: overwrite ? "w" : "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new AppError("conflict", `${name} already exists in this folder.`);
        }
        throw new AppError("validation", `KM0 cannot write to ${folder}.`, { cause: error });
      }
      return file;
    },

    async reveal(path) {
      reveal(absolute(path, "file"));
    },
  };
}

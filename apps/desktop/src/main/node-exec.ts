import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { access, constants, mkdir, open, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { killProcessTree } from "./dispatch/claude-code";
import type { ExecPort, RunningProcess, SpawnOptions } from "./services/exec-port";

/** Longest line kept from a process's output; longer ones are cut. */
const MAX_LINE = 4000;

function follow(
  child: ChildProcess,
  onLine: (line: string) => void,
  options: { killOnWin32Terminate?: boolean } = {},
): RunningProcess {
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) onLine(line.slice(0, MAX_LINE));
    });
    stream?.on("end", () => {
      if (buffer) onLine(buffer.slice(0, MAX_LINE));
      buffer = "";
    });
  }
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("error", (error) => {
      onLine(error.message);
      resolve({ code: null, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    terminate: () => {
      if (process.platform === "win32") {
        if (options.killOnWin32Terminate) killProcessTree(child, "SIGKILL");
      } else {
        killProcessTree(child, "SIGTERM");
      }
    },
    kill: () => killProcessTree(child, "SIGKILL"),
    exited,
  };
}

const environment = (env: Record<string, string>) => ({ ...process.env, ...env, PYTHONUNBUFFERED: "1" });

/**
 * Node refuses to spawn a .cmd or .bat file directly on Windows (it throws EINVAL), and npm installs tools such as
 * pi as .cmd shims, so those go through cmd.exe with every part quoted.
 */
function launch(program: string, args: string[], options: Parameters<typeof spawnChild>[2]): ChildProcess {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(program)) {
    const quote = (part: string) => `"${part.replace(/"/g, '""')}"`;
    return spawnChild([program, ...args].map(quote).join(" "), { ...options, shell: true });
  }
  return spawnChild(program, args, { ...options, detached: process.platform !== "win32" });
}

export function nodeExec(): ExecPort {
  return {
    platform: process.platform,
    async which(name) {
      const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
      for (const rawDir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        const dir = process.platform === "win32" ? rawDir.replace(/^"+|"+$/g, "") : rawDir;
        if (!dir) continue;
        for (const extension of extensions) {
          const candidate = join(dir, name + extension.toLowerCase());
          const info = await stat(candidate).catch(() => null);
          if (!info?.isFile()) continue;
          if (process.platform !== "win32") {
            const executable = await access(candidate, constants.X_OK).then(
              () => true,
              () => false,
            );
            if (!executable) continue;
          }
          return candidate;
        }
      }
      return null;
    },
    capture(command, timeoutMs = 20_000) {
      return new Promise((resolve) => {
        const [program, ...args] = command;
        if (!program) return resolve({ code: null, output: "" });
        let output = "";
        let child: ChildProcess;
        try {
          child = launch(program, args, { env: environment({}), windowsHide: true });
        } catch (error) {
          return resolve({ code: null, output: (error as Error).message });
        }
        const timer = setTimeout(() => killProcessTree(child, "SIGKILL"), timeoutMs);
        child.stdout?.on("data", (chunk) => (output += chunk));
        child.stderr?.on("data", (chunk) => (output += chunk));
        child.on("error", (error) => {
          clearTimeout(timer);
          resolve({ code: null, output: error.message });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, output: output.slice(-20_000) });
        });
      });
    },
    spawn(command: string[], options: SpawnOptions) {
      const [program, ...args] = command;
      const child = launch(program ?? "", args, {
        cwd: options.cwd,
        env: environment(options.env),
        windowsHide: true,
      });
      return follow(child, options.onLine);
    },
    spawnShell(commandLine: string, options: SpawnOptions) {
      const child = spawnChild(commandLine, {
        cwd: options.cwd,
        env: environment(options.env),
        shell: true,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      return follow(child, options.onLine, { killOnWin32Terminate: true });
    },
    async writeFile(path, content) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    },
    exists: (path) =>
      access(path).then(
        () => true,
        () => false,
      ),
    async readFrom(path, offset) {
      const size = await stat(path).then(
        (info) => info.size,
        () => 0,
      );
      if (size <= offset) return { text: "", size };
      let file: Awaited<ReturnType<typeof open>>;
      try {
        file = await open(path, "r");
      } catch {
        return { text: "", size: 0 };
      }
      try {
        const buffer = Buffer.alloc(size - offset);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        return { text: buffer.subarray(0, bytesRead).toString("utf8"), size: offset + bytesRead };
      } finally {
        await file.close();
      }
    },
    join: (...parts) => join(...parts),
    quote: (value) =>
      process.platform === "win32" ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`,
  };
}

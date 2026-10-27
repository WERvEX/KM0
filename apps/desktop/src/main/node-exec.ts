import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { access, mkdir, open, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { ExecPort, RunningProcess, SpawnOptions } from "./services/exec-port";

/** Longest line kept from a process's output; longer ones are cut. */
const MAX_LINE = 4000;

function follow(child: ChildProcess, onLine: (line: string) => void): RunningProcess {
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
      if (process.platform !== "win32") child.kill("SIGTERM");
    },
    kill: () => child.kill("SIGKILL"),
    exited,
  };
}

const environment = (env: Record<string, string>) => ({ ...process.env, ...env, PYTHONUNBUFFERED: "1" });

export function nodeExec(): ExecPort {
  return {
    platform: process.platform,
    async which(name) {
      const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
      for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        for (const extension of extensions) {
          const candidate = join(dir, name + extension.toLowerCase());
          const ok = await access(candidate).then(
            () => true,
            () => false,
          );
          if (ok) return candidate;
        }
      }
      return null;
    },
    capture(command, timeoutMs = 20_000) {
      return new Promise((resolve) => {
        const [program, ...args] = command;
        if (!program) return resolve({ code: null, output: "" });
        let output = "";
        const child = spawnChild(program, args, { env: environment({}), windowsHide: true });
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
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
      const child = spawnChild(program ?? "", args, {
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
        windowsHide: true,
      });
      return follow(child, options.onLine);
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
      const file = await open(path, "r");
      try {
        const buffer = Buffer.alloc(size - offset);
        await file.read(buffer, 0, buffer.length, offset);
        return { text: buffer.toString("utf8"), size };
      } finally {
        await file.close();
      }
    },
    join: (...parts) => join(...parts),
    quote: (value) =>
      process.platform === "win32" ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`,
  };
}

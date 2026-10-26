/** A process KM0 started. */
export interface RunningProcess {
  /** Ask it to stop: SIGTERM where there is one; on Windows nothing, the run's stop file does it. */
  terminate(): void;
  /** End it at once. */
  kill(): void;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

export interface SpawnOptions {
  cwd: string;
  /** Added to KM0's own environment. */
  env: Record<string, string>;
  /** Each line it prints, stdout and stderr alike. */
  onLine: (line: string) => void;
}

/** Starting local programs and the files around a run. Desktop only. */
export interface ExecPort {
  /** A program on PATH, as a full path; null when there is none. */
  which(name: string): Promise<string | null>;
  /** Run a short command to its end, with a timeout; its exit code and everything it printed. */
  capture(command: string[], timeoutMs?: number): Promise<{ code: number | null; output: string }>;
  spawn(command: string[], options: SpawnOptions): RunningProcess;
  /** A command line run by the system shell, for the custom executor. */
  spawnShell(commandLine: string, options: SpawnOptions): RunningProcess;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Text of a file from a byte offset on, and its size; empty and 0 when it does not exist. */
  readFrom(path: string, offset: number): Promise<{ text: string; size: number }>;
  join(...parts: string[]): string;
  /** Quote a value for the system shell. */
  quote(value: string): string;
  platform: string;
}

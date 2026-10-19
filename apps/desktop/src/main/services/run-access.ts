/** A KM0 Runner run directory (`runs/<run_id>`), opened for reading its reports and writing KM0's verdicts. */
export interface RunFs {
  /** File names in a folder of the run directory; empty when it does not exist. */
  list(dir: string): Promise<string[]>;
  /** A file's text, cut at `maxBytes`; null when it does not exist. */
  read(file: string, maxBytes: number): Promise<string | null>;
  write(file: string, content: string): Promise<void>;
}

/** Where run directories come from: a folder dialog, and access to a picked folder. */
export interface RunAccess {
  /** Ask the user for a folder; null when they cancel. */
  pick(): Promise<string | null>;
  /** Throws a validation error when the folder cannot be opened. */
  open(path: string): Promise<RunFs>;
}

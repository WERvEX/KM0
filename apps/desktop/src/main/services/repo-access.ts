import { type RepoFs, scanRepo } from "@km0/core";
import type { RepoScan } from "@km0/shared";

/** Where repositories come from: a folder dialog and read-only file access. */
export interface RepoAccess {
  /** Ask the user for a folder; null when they cancel. */
  pick(): Promise<string | null>;
  /** Read-only access to a picked folder. Throws a validation error when it cannot be opened. */
  open(path: string): Promise<{ name: string; fs: RepoFs }>;
}

export async function scanPath(access: RepoAccess, path: string): Promise<RepoScan> {
  const { name, fs } = await access.open(path);
  return scanRepo(fs, { root: path, name });
}

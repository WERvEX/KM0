import { z } from "zod";

/**
 * Files and folders chosen inside KM0's own window. The desktop app never opens the system's file
 * dialogs: the renderer lists folders through these channels and draws its own browser.
 */

export const FileEntry = z.object({
  name: z.string(),
  path: z.string(),
  dir: z.boolean(),
  /** A folder that holds a `.git` entry. */
  git: z.boolean(),
});
export type FileEntry = z.infer<typeof FileEntry>;

/** A shortcut shown beside the listing: the home folder, Downloads, drives. */
export const FilePlace = z.object({
  id: z.enum(["home", "desktop", "documents", "downloads", "root", "drive", "volume"]),
  label: z.string(),
  path: z.string(),
});
export type FilePlace = z.infer<typeof FilePlace>;

export const FolderListing = z.object({
  path: z.string(),
  /** Null at the top of a drive or the file system. */
  parent: z.string().nullable(),
  /** Folders first, then files matching the requested extensions; both sorted by name. */
  entries: z.array(FileEntry),
  /** More entries existed than the listing returns. */
  truncated: z.boolean(),
  places: z.array(FilePlace),
});
export type FolderListing = z.infer<typeof FolderListing>;

export const BrowseInput = z.object({
  /** Null starts in the home folder. */
  path: z.string().max(4096).nullable(),
  /** Files with these extensions (without the dot) are listed too; none lists folders only. */
  extensions: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9]+$/i)
        .max(10),
    )
    .max(10)
    .default([]),
  showHidden: z.boolean().default(false),
});
export type BrowseInput = z.input<typeof BrowseInput>;

export const ReadFileInput = z.object({ path: z.string().min(1).max(4096) });
export const ReadFileResult = z.object({ name: z.string(), text: z.string() });
export type ReadFileResult = z.infer<typeof ReadFileResult>;

/** Largest file KM0 reads for an import. */
export const MAX_READ_BYTES = 5 * 1024 * 1024;

export const SaveFileInput = z.object({
  dir: z.string().min(1).max(4096),
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((name) => !/[\\/:*?"<>|]/.test(name) && name !== "." && name !== "..", {
      message: 'The file name cannot contain \\ / : * ? " < > |',
    }),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  /** Without it, saving over an existing file fails with a conflict error. */
  overwrite: z.boolean().default(false),
});
export type SaveFileInput = z.input<typeof SaveFileInput>;
export const SaveFileResult = z.object({ path: z.string() });

/** The main process asks the window to let the user choose a folder. */
export const FolderRequest = z.object({ requestId: z.string(), purpose: z.enum(["repo", "run"]) });
export type FolderRequest = z.infer<typeof FolderRequest>;
export const FolderAnswer = z.object({ requestId: z.string(), path: z.string().max(4096).nullable() });
export type FolderAnswer = z.infer<typeof FolderAnswer>;

/** Something the main process tells the user about outside of a call: shown as an in-app message. */
export const AppNotice = z.object({
  kind: z.enum(["error", "info"]),
  code: z.enum(["main_error", "renderer_restarted", "download_saved"]),
  detail: z.string().optional(),
});
export type AppNotice = z.infer<typeof AppNotice>;

import { AppError, type BrowseInput, type FolderListing, type ReadFileResult, type SaveFileInput } from "@km0/shared";
import type { z } from "zod";

/** Files on the user's disk, for KM0's own file browser. Desktop only. */
export interface FilePort {
  browse(input: z.output<typeof BrowseInput>): Promise<FolderListing>;
  read(path: string): Promise<ReadFileResult>;
  /** Returns the saved file's path. Throws a conflict error when the file exists and `overwrite` is off. */
  save(input: z.output<typeof SaveFileInput>): Promise<string>;
  reveal(path: string): Promise<void>;
}

const desktopOnly = () =>
  Promise.reject(new AppError("config", "The file browser is only available in the desktop app."));

/** The browser debug build uses the browser's own file access instead. */
export const noFilePort: FilePort = {
  browse: desktopOnly,
  read: desktopOnly,
  save: desktopOnly,
  reveal: desktopOnly,
};

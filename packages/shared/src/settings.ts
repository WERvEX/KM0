import { z } from "zod";

export const Language = z.enum(["system", "zh-CN", "en"]);
export type Language = z.infer<typeof Language>;

export const Theme = z.enum(["system", "light", "dark"]);
export type Theme = z.infer<typeof Theme>;

export const Preferences = z.object({
  language: Language,
  theme: Theme,
});
export type Preferences = z.infer<typeof Preferences>;

export const DEFAULT_PREFERENCES: Preferences = { language: "system", theme: "system" };

export const AppInfo = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string(),
  dataDir: z.string(),
  /** Whether the OS credential store protects API keys (false on Linux without a keyring). */
  secureStorage: z.boolean(),
});
export type AppInfo = z.infer<typeof AppInfo>;

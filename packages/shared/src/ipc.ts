import { z } from "zod";
import { ProjectSummary } from "./domain";
import type { AppErrorShape } from "./errors";
import { ConnectionTestResult, LlmProfile, LlmProfileInput, RoleAssignment } from "./llm";
import { AppInfo, Preferences } from "./settings";

interface ChannelSpec<I extends z.ZodType, O extends z.ZodType> {
  input: I;
  output: O;
}

function channel<I extends z.ZodType, O extends z.ZodType>(input: I, output: O): ChannelSpec<I, O> {
  return { input, output };
}

const Id = z.object({ id: z.number().int().positive() });

/**
 * Every renderer → main call. The main process validates `input` before a handler runs;
 * handlers return `output`. Adding a channel here is the only way to expose a capability.
 */
export const ipcContract = {
  "app.info": channel(z.void(), AppInfo),

  "settings.profiles.list": channel(z.void(), z.array(LlmProfile)),
  "settings.profiles.create": channel(LlmProfileInput, LlmProfile),
  "settings.profiles.update": channel(Id.extend({ data: LlmProfileInput }), LlmProfile),
  "settings.profiles.delete": channel(Id, z.void()),
  "settings.profiles.test": channel(Id, ConnectionTestResult),
  "settings.roles.get": channel(z.void(), RoleAssignment),
  "settings.roles.set": channel(RoleAssignment, RoleAssignment),
  "settings.preferences.get": channel(z.void(), Preferences),
  "settings.preferences.set": channel(Preferences.partial(), Preferences),

  "project.list": channel(z.void(), z.array(ProjectSummary)),
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]["input"]>;
export type IpcOutput<C extends IpcChannel> = z.output<IpcContract[C]["output"]>;

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: AppErrorShape };

/** main → renderer push events (streaming document generation arrives here in P2). */
export const ipcEvents = {} as const;

export { IPC_INVOKE } from "./bridge";

/** API exposed on `window.km0` by the preload script. */
export interface Km0Bridge {
  invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcResult<IpcOutput<C>>>;
}

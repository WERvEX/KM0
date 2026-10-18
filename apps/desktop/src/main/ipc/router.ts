import {
  AppError,
  type IpcChannel,
  type IpcContract,
  type IpcInput,
  type IpcOutput,
  type IpcResult,
  ipcContract,
  toAppError,
} from "@km0/shared";
import type { z } from "zod";

export type Handlers = {
  [C in IpcChannel]: (input: z.output<IpcContract[C]["input"]>) => Promise<IpcOutput<C>> | IpcOutput<C>;
};

export type Dispatch = (channel: unknown, input: unknown) => Promise<IpcResult<unknown>>;

/**
 * Validates every call against the shared contract before a handler runs, and turns any
 * failure into a serializable result instead of a rejected promise.
 */
export function createDispatcher(handlers: Handlers, onError?: (channel: string, error: AppError) => void): Dispatch {
  return async (channel, input) => {
    if (typeof channel !== "string" || !Object.hasOwn(ipcContract, channel)) {
      return { ok: false, error: new AppError("validation", `Unknown channel: ${String(channel)}`).toShape() };
    }
    const name = channel as IpcChannel;
    const parsed = ipcContract[name].input.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      return { ok: false, error: new AppError("validation", "Invalid request.", { detail }).toShape() };
    }
    try {
      const handler = handlers[name] as (value: unknown) => unknown;
      const data = await handler(parsed.data);
      return { ok: true, data };
    } catch (error) {
      const appError = toAppError(error);
      onError?.(name, appError);
      return { ok: false, error: appError.toShape() };
    }
  };
}

export type { IpcInput };

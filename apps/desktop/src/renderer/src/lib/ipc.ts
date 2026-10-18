import type { AppErrorShape, IpcChannel, IpcInput, IpcOutput, Km0Bridge } from "@km0/shared";

declare global {
  interface Window {
    km0: Km0Bridge;
  }
}

/** A failed main-process call, carrying the error kind so the UI can react appropriately. */
export class IpcError extends Error {
  readonly shape: AppErrorShape;

  constructor(shape: AppErrorShape) {
    super(shape.message);
    this.name = "IpcError";
    this.shape = shape;
  }
}

export async function call<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>> {
  const result = await window.km0.invoke(channel, input);
  if (!result.ok) throw new IpcError(result.error);
  return result.data;
}

export function errorMessage(error: unknown): string {
  if (error instanceof IpcError) {
    return error.shape.detail ? `${error.shape.message} (${error.shape.detail})` : error.shape.message;
  }
  return error instanceof Error ? error.message : String(error);
}

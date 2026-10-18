import { z } from "zod";

/**
 * How the UI should react to a failure:
 * - config: the user must fix a setting (model, key, URL)
 * - upstream: a provider or network failure; retrying may help
 * - validation: input or model output did not match the expected shape
 * - conflict: the request targets stale state (for example an old question round)
 */
export const AppErrorKind = z.enum(["config", "upstream", "validation", "not_found", "conflict", "internal"]);
export type AppErrorKind = z.infer<typeof AppErrorKind>;

export const AppErrorShape = z.object({
  kind: AppErrorKind,
  message: z.string(),
  retryable: z.boolean(),
  detail: z.string().optional(),
});
export type AppErrorShape = z.infer<typeof AppErrorShape>;

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly retryable: boolean;
  readonly detail: string | undefined;

  constructor(
    kind: AppErrorKind,
    message: string,
    options: { retryable?: boolean; detail?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.kind = kind;
    this.retryable = options.retryable ?? kind === "upstream";
    this.detail = options.detail;
  }

  toShape(): AppErrorShape {
    return {
      kind: this.kind,
      message: this.message,
      retryable: this.retryable,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppError("internal", message, { cause: error });
}

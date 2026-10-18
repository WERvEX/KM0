import { AppError } from "@km0/shared";
import { ProviderError } from "./types";

/** Map a provider failure to what the user can do about it. */
export function providerErrorToAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (!(error instanceof ProviderError)) {
    const message = error instanceof Error ? error.message : String(error);
    return new AppError("upstream", message, { retryable: true, cause: error });
  }
  switch (error.kind) {
    case "auth":
      return new AppError("config", `API key rejected: ${error.message}`, { retryable: false, cause: error });
    case "not_found":
      return new AppError("config", `Model or endpoint not found: ${error.message}`, {
        retryable: false,
        cause: error,
      });
    case "bad_request":
      return new AppError("config", `Request rejected by the provider: ${error.message}`, {
        retryable: false,
        cause: error,
      });
    case "rate_limit":
      return new AppError("upstream", `Rate limited: ${error.message}`, { retryable: true, cause: error });
    case "server":
    case "network":
    case "timeout":
    case "unknown":
      return new AppError("upstream", error.message, { retryable: true, cause: error });
  }
}

export function classifyHttpStatus(status: number): ProviderError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "unknown";
}

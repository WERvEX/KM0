import type { DocumentLlm, Gateway } from "@km0/core";
import type { SettingsStore } from "./settings-store";

/** Binds the engine's role-based calls to the configured profiles and logs them against a project. */
export function llmPort(gateway: Gateway, settings: SettingsStore, projectId: number | null): DocumentLlm {
  return {
    structured: (role, call) => gateway.structured({ ...call, profile: settings.profileForRole(role), projectId }),
    stream: (role, call, onDelta) =>
      gateway.stream({ ...call, profile: settings.profileForRole(role), projectId }, onDelta),
  };
}

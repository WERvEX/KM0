import { createGateway, createSimulatedLlm, FakeProvider, ProviderError, toolReply } from "@km0/core";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database";
import { createHandlers } from "../handlers";
import { ProjectService } from "../services/project-service";
import { PlainSecretStore } from "../services/secrets";
import { SettingsStore } from "../services/settings-store";
import { createDispatcher } from "./router";

function setup(provider = new FakeProvider([])) {
  const db = openDatabase(":memory:");
  const settings = new SettingsStore(db, new PlainSecretStore());
  const gateway = createGateway({ providerFor: () => provider, recordCall: (record) => settings.recordCall(record) });
  const dispatch = createDispatcher(
    createHandlers({
      settings,
      projects: new ProjectService(
        db,
        () => createSimulatedLlm(),
        () => "zh-CN",
      ),
      gateway,
      appInfo: () => ({
        name: "KM0",
        version: "0.0.0",
        platform: "test",
        dataDir: "/tmp",
        secureStorage: false,
        simulatedModel: false,
      }),
    }),
  );
  return { dispatch, settings, provider };
}

const profileInput = { name: "Local", provider: "openai", baseUrl: "http://localhost:8080/v1", model: "m" };

describe("IPC dispatcher", () => {
  it("rejects unknown channels and invalid input without calling a handler", async () => {
    const { dispatch } = setup();
    await expect(dispatch("fs.readFile", {})).resolves.toMatchObject({ ok: false, error: { kind: "validation" } });
    await expect(dispatch("settings.profiles.create", { name: "" })).resolves.toMatchObject({
      ok: false,
      error: { kind: "validation" },
    });
  });

  it("returns handler data and serializes domain errors", async () => {
    const { dispatch } = setup();
    const created = await dispatch("settings.profiles.create", profileInput);
    expect(created).toMatchObject({ ok: true, data: { name: "Local", hasApiKey: false } });
    await expect(dispatch("settings.profiles.delete", { id: 999 })).resolves.toMatchObject({
      ok: false,
      error: { kind: "not_found" },
    });
    await expect(dispatch("project.list", undefined)).resolves.toEqual({ ok: true, data: [] });
  });

  it("stores the structured mode found by a connection test", async () => {
    const provider = new FakeProvider([
      new ProviderError("bad_request", "json_schema unsupported", { status: 400 }),
      toolReply({ ok: true }),
    ]);
    const { dispatch, settings } = setup(provider);
    const created = (await dispatch("settings.profiles.create", profileInput)) as { ok: true; data: { id: number } };
    const result = await dispatch("settings.profiles.test", { id: created.data.id });
    expect(result).toMatchObject({ ok: true, data: { ok: true, detectedMode: "tool" } });
    expect(settings.getProfile(created.data.id).structuredMode).toBe("tool");
  });
});

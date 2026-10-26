import { createGateway, createSimulatedLlm, FakeProvider, ProviderError, toolReply } from "@km0/core";
import bundledRegistry from "@km0/registry/model-registry.json";
import { ModelRegistry } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database";
import { createHandlers } from "../handlers";
import { AgentStore } from "../services/agent-store";
import { ConfigService } from "../services/config-service";
import { DocumentService } from "../services/document-service";
import { ExecutionService } from "../services/execution-service";
import { noFilePort } from "../services/file-port";
import { HandoffService } from "../services/handoff-service";
import { ProjectService } from "../services/project-service";
import { RegistryService } from "../services/registry-service";
import { RoutingService } from "../services/routing-service";
import { RunRecordStore } from "../services/run-records";
import { RunnerService } from "../services/runner-service";
import { SearchStore } from "../services/search-store";
import { PlainSecretStore } from "../services/secrets";
import { SettingsStore } from "../services/settings-store";
import { createDispatcher } from "./router";

function setup(provider = new FakeProvider([])) {
  const db = openDatabase(":memory:");
  const settings = new SettingsStore(db, new PlainSecretStore());
  const gateway = createGateway({ providerFor: () => provider, recordCall: (record) => settings.recordCall(record) });
  const routing = new RoutingService(
    db,
    () => createSimulatedLlm(),
    () => "zh-CN",
    new AgentStore(db),
  );
  const agents = new AgentStore(db);
  const search = new SearchStore(db, new PlainSecretStore(), {});
  const records = new RunRecordStore(db);
  const handoff = new HandoffService(db, routing, () => "zh-CN");
  const runner = new RunnerService(
    db,
    {
      pick: async () => null,
      open: async () => {
        throw new Error("no run folders in this test");
      },
    },
    routing,
    () => createSimulatedLlm(),
    () => "zh-CN",
    () => "simulated",
  );
  const dispatch = createDispatcher(
    createHandlers({
      settings,
      records,
      projects: new ProjectService(
        db,
        () => createSimulatedLlm(),
        () => "zh-CN",
      ),
      documents: new DocumentService(
        db,
        () => createSimulatedLlm(),
        () => "zh-CN",
        () => undefined,
      ),
      routing,
      handoff,
      runner,
      execution: new ExecutionService(db, null, settings, routing, handoff, runner, () => "zh-CN", "runs"),
      quit: async () => undefined,
      agents,
      search,
      config: new ConfigService(settings, agents, search),
      registry: new RegistryService(db, ModelRegistry.parse(bundledRegistry), async () => ""),
      repo: {
        pick: async () => null,
        open: async () => {
          throw new Error("no repositories in this test");
        },
      },
      files: noFilePort,
      folders: null,
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

const providerInput = { name: "Local", kind: "openai", baseUrl: "http://localhost:8080/v1" };

describe("IPC dispatcher", () => {
  it("rejects unknown channels and invalid input without calling a handler", async () => {
    const { dispatch } = setup();
    await expect(dispatch("fs.readFile", {})).resolves.toMatchObject({ ok: false, error: { kind: "validation" } });
    await expect(dispatch("settings.providers.create", { name: "" })).resolves.toMatchObject({
      ok: false,
      error: { kind: "validation" },
    });
  });

  it("returns handler data and serializes domain errors", async () => {
    const { dispatch } = setup();
    const created = await dispatch("settings.providers.create", providerInput);
    expect(created).toMatchObject({ ok: true, data: { name: "Local", hasApiKey: false } });
    await expect(dispatch("settings.models.delete", { id: 999 })).resolves.toMatchObject({
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
    const local = (await dispatch("settings.providers.create", providerInput)) as { ok: true; data: { id: number } };
    const created = (await dispatch("settings.models.create", { providerId: local.data.id, modelId: "m" })) as {
      ok: true;
      data: { id: number };
    };
    const result = await dispatch("settings.models.test", { id: created.data.id });
    expect(result).toMatchObject({ ok: true, data: { ok: true, detectedMode: "tool" } });
    expect(settings.getModel(created.data.id).structuredMode).toBe("tool");
  });
});

import { AbilityKind, type Estimate, type ModelRegistry, REGISTRY_UPDATE_URL } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database";
import { RegistryService } from "./registry-service";

const abilities = Object.fromEntries(AbilityKind.options.map((kind) => [kind, { mean: 0, sd: 1 }])) as Record<
  AbilityKind,
  Estimate
>;

function registry(dataDate: string, models = 1): ModelRegistry {
  return {
    schemaVersion: 1,
    generatedAt: `${dataDate}T00:00:00Z`,
    dataDate,
    sources: [
      {
        id: "s",
        name: "Board",
        url: "https://example.com",
        measures: "m",
        fetchedAt: "x",
        newestEntry: dataDate,
        entries: 1,
        unmatched: 0,
      },
    ],
    difficulty: { bands: [] },
    vendors: [],
    agents: [],
    models: Array.from({ length: models }, (_, i) => ({
      id: `v/m${i}`,
      name: `M${i}`,
      vendor: "v",
      aliases: [],
      released: null,
      contextWindow: null,
      pricing: { input: null, output: null, cacheRead: null },
      abilities,
      coverage: i === 0 ? ("measured" as const) : ("none" as const),
      observations: [],
    })),
  };
}

function setup(download: (url: string) => Promise<string>) {
  const db = openDatabase(":memory:");
  return new RegistryService(db, registry("2026-10-01"), download);
}

describe("RegistryService", () => {
  it("starts on the bundled registry", () => {
    const service = setup(async () => "");
    expect(service.info()).toMatchObject({
      origin: "bundled",
      dataDate: "2026-10-01",
      models: { total: 1, measured: 1 },
    });
  });

  it("downloads a newer registry and keeps it, but ignores one that is not newer", async () => {
    const urls: string[] = [];
    let served = registry("2026-09-01");
    const service = setup(async (url) => {
      urls.push(url);
      return JSON.stringify(served);
    });
    expect((await service.update()).status).toBe("current");
    served = registry("2026-11-02", 3);
    const result = await service.update();
    expect(result.status).toBe("updated");
    expect(result.info).toMatchObject({ origin: "downloaded", dataDate: "2026-11-02", models: { total: 3 } });
    expect(urls).toEqual([REGISTRY_UPDATE_URL, REGISTRY_UPDATE_URL]);
  });

  it("rejects files that are not a registry or have another format version", () => {
    const service = setup(async () => "");
    expect(() => service.import("{}")).toThrow(/not a KM0 model registry/);
    expect(() => service.import(JSON.stringify({ ...registry("2026-12-01"), schemaVersion: 2 }))).toThrow(
      /format version 2/,
    );
  });

  it("imports a newer file, refuses an older one, and goes back to the bundled registry", () => {
    const service = setup(async () => "");
    expect(service.import(JSON.stringify(registry("2026-10-20")))).toMatchObject({ origin: "imported" });
    expect(() => service.import(JSON.stringify(registry("2026-01-01")))).toThrow(/older than the one shipped/);
    expect(service.reset()).toMatchObject({ origin: "bundled", dataDate: "2026-10-01" });
  });

  it("reports download failures as retryable", async () => {
    const service = setup(async () => {
      throw new Error("offline");
    });
    await expect(service.update()).rejects.toMatchObject({ kind: "upstream", retryable: true });
  });
});

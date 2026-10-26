import {
  AppError,
  ModelRegistry,
  REGISTRY_SCHEMA_VERSION,
  REGISTRY_UPDATE_URL,
  type RegistryInfo,
  type RegistryUpdateResult,
} from "@km0/shared";
import { type Database, nowIso } from "../db/sql";

type Origin = RegistryInfo["origin"];

interface Stored {
  registry: ModelRegistry;
  origin: Origin;
  importedAt: string;
}

/**
 * The model registry in use. KM0 ships one; a newer one can be downloaded or imported from a file
 * and is kept in the database. Whichever has the newer leaderboard data wins, so installing a newer
 * KM0 never leaves the user on stale downloaded data.
 */
export class RegistryService {
  private cache: { registry: ModelRegistry; origin: Origin; importedAt: string | null } | null = null;

  constructor(
    private readonly db: Database,
    private readonly bundled: ModelRegistry,
    private readonly download: (url: string) => Promise<string>,
  ) {}

  current(): { registry: ModelRegistry; origin: Origin; importedAt: string | null } {
    if (this.cache) return this.cache;
    const stored = this.readStored();
    this.cache =
      stored && stored.registry.dataDate >= this.bundled.dataDate
        ? stored
        : { registry: this.bundled, origin: "bundled", importedAt: null };
    return this.cache;
  }

  info(): RegistryInfo {
    const { registry, origin, importedAt } = this.current();
    const count = (coverage: string) => registry.models.filter((model) => model.coverage === coverage).length;
    return {
      dataDate: registry.dataDate,
      generatedAt: registry.generatedAt,
      origin,
      importedAt,
      models: {
        total: registry.models.length,
        measured: count("measured"),
        inferred: count("inferred"),
        none: count("none"),
      },
      sources: registry.sources.map(({ name, url, newestEntry }) => ({ name, url, newestEntry })),
    };
  }

  async update(): Promise<RegistryUpdateResult> {
    let text: string;
    try {
      text = await this.download(REGISTRY_UPDATE_URL);
    } catch (error) {
      throw new AppError("upstream", "The model registry could not be downloaded.", {
        retryable: true,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const registry = parse(text);
    if (registry.dataDate <= this.current().registry.dataDate) return { status: "current", info: this.info() };
    this.store(registry, "downloaded");
    return { status: "updated", info: this.info() };
  }

  /** Use a registry from a file, even an older one: the user chose it. */
  import(text: string): RegistryInfo {
    this.store(parse(text), "imported");
    if (this.current().origin !== "imported") {
      throw new AppError("validation", "This registry is older than the one shipped with KM0, so it is not used.");
    }
    return this.info();
  }

  reset(): RegistryInfo {
    this.db.prepare("DELETE FROM model_registry").run();
    this.cache = null;
    return this.info();
  }

  private store(registry: ModelRegistry, origin: Origin): void {
    this.db
      .prepare(
        `INSERT INTO model_registry (id, json, origin, imported_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET json = excluded.json, origin = excluded.origin, imported_at = excluded.imported_at`,
      )
      .run(JSON.stringify(registry), origin, nowIso());
    this.cache = null;
  }

  private readStored(): Stored | null {
    const row = this.db.prepare("SELECT json, origin, imported_at FROM model_registry WHERE id = 1").get() as
      | { json: string; origin: Origin; imported_at: string }
      | undefined;
    if (!row) return null;
    const parsed = ModelRegistry.safeParse(safeJson(row.json));
    // A registry written by another KM0 version that no longer parses is ignored, not fatal.
    return parsed.success ? { registry: parsed.data, origin: row.origin, importedAt: row.imported_at } : null;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parse(text: string): ModelRegistry {
  const value = safeJson(text) as { schemaVersion?: unknown } | null;
  if (value && typeof value.schemaVersion === "number" && value.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new AppError(
      "validation",
      `This registry has format version ${value.schemaVersion}; this version of KM0 reads version ${REGISTRY_SCHEMA_VERSION}.`,
    );
  }
  const parsed = ModelRegistry.safeParse(value);
  if (!parsed.success) throw new AppError("validation", "This file is not a KM0 model registry.");
  return parsed.data;
}

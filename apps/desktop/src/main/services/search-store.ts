import type { SearchPort } from "@km0/core";
import {
  AppError,
  type SearchService,
  SearchServiceConfig,
  type SearchServiceFields,
  SearchServiceInput,
  type SearchTestResult,
} from "@km0/shared";
import { type Database, nowIso } from "../db/sql";
import { createSearchPort, type SearchPortDeps } from "./search-ports";
import { keyHint, type SecretStore } from "./secrets";

interface ServiceRow {
  id: number;
  name: string;
  kind: SearchServiceConfig["kind"];
  config_json: string;
  secret_encrypted: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function parseConfig(row: ServiceRow): SearchServiceConfig {
  return SearchServiceConfig.parse({ ...JSON.parse(row.config_json), kind: row.kind });
}

/** Search services used to check technology choices. Secrets are encrypted like model API keys. */
export class SearchStore {
  constructor(
    private readonly db: Database,
    private readonly secrets: SecretStore,
    private readonly deps: SearchPortDeps,
  ) {}

  list(): SearchService[] {
    const rows = this.db.prepare("SELECT * FROM search_services ORDER BY id").all() as unknown as ServiceRow[];
    return rows.map((row) => this.toService(row));
  }

  create(input: SearchServiceInput): SearchService {
    const data = SearchServiceInput.parse(input);
    const secret = data.secret?.trim() ? data.secret.trim() : null;
    const now = nowIso();
    try {
      const result = this.db
        .prepare(
          `INSERT INTO search_services (name, kind, config_json, secret_encrypted, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          data.name,
          data.config.kind,
          JSON.stringify(data.config),
          secret ? this.secrets.encrypt(secret) : null,
          data.enabled ? 1 : 0,
          now,
          now,
        );
      return this.toService(this.row(Number(result.lastInsertRowid)));
    } catch (error) {
      throw uniqueNameError(error) ?? error;
    }
  }

  /** `secret` omitted keeps the stored one; an empty string removes it. */
  update(id: number, input: SearchServiceInput): SearchService {
    const existing = this.row(id);
    const data = SearchServiceInput.parse(input);
    let encrypted = existing.secret_encrypted;
    if (data.secret !== undefined) {
      const secret = data.secret.trim();
      encrypted = secret ? this.secrets.encrypt(secret) : null;
    }
    try {
      this.db
        .prepare(
          `UPDATE search_services SET name = ?, kind = ?, config_json = ?, secret_encrypted = ?, enabled = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(data.name, data.config.kind, JSON.stringify(data.config), encrypted, data.enabled ? 1 : 0, nowIso(), id);
    } catch (error) {
      throw uniqueNameError(error) ?? error;
    }
    return this.toService(this.row(id));
  }

  delete(id: number): void {
    this.row(id);
    this.db.prepare("DELETE FROM search_services WHERE id = ?").run(id);
  }

  /** Run one query against a service so the user can see it works. */
  async test(id: number, query: string): Promise<SearchTestResult> {
    const started = Date.now();
    let port: SearchPort | null = null;
    try {
      port = this.portFor(this.row(id));
      const results = await port.search(query);
      return { ok: true, latencyMs: Date.now() - started, results: results.slice(0, 5), error: null };
    } catch (error) {
      const detail = error instanceof AppError && error.detail ? ` (${error.detail})` : "";
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, latencyMs: Date.now() - started, results: [], error: `${message}${detail}` };
    } finally {
      await port?.close?.().catch(() => undefined);
    }
  }

  /** The first enabled service, or null when research should be skipped. */
  activePort(): SearchPort | null {
    const rows = this.db
      .prepare("SELECT * FROM search_services WHERE enabled = 1 ORDER BY id")
      .all() as unknown as ServiceRow[];
    // Local MCP servers are skipped where processes cannot be started (the web build).
    const row = rows.find((item) => item.kind !== "mcp_stdio" || this.deps.stdio);
    return row ? this.portFor(row) : null;
  }

  /** Every service as importable input; secrets only when asked for. */
  exportAll(includeSecrets: boolean): SearchServiceFields[] {
    const rows = this.db.prepare("SELECT * FROM search_services ORDER BY id").all() as unknown as ServiceRow[];
    return rows.map((row) => {
      const secret = includeSecrets ? this.decrypt(row) : null;
      return {
        name: row.name,
        config: parseConfig(row),
        enabled: row.enabled === 1,
        ...(secret ? { secret } : {}),
      };
    });
  }

  /**
   * Create or update by name. A local MCP server runs a command on this computer, so one that is new
   * or whose command changed arrives disabled until the user has looked at it.
   */
  upsertByName(input: SearchServiceInput): { created: boolean; disabled: boolean } {
    const data = SearchServiceInput.parse(input);
    const existing = this.db.prepare("SELECT * FROM search_services WHERE name = ?").get(data.name) as
      | ServiceRow
      | undefined;
    const before = existing ? parseConfig(existing) : null;
    const sameCommand =
      before?.kind === "mcp_stdio" &&
      data.config.kind === "mcp_stdio" &&
      before.command === data.config.command &&
      JSON.stringify(before.args) === JSON.stringify(data.config.args);
    const disabled = data.config.kind === "mcp_stdio" && data.enabled && !sameCommand;
    const safe = disabled ? { ...data, enabled: false } : data;
    if (existing) this.update(existing.id, safe);
    else this.create(safe);
    return { created: !existing, disabled };
  }

  private portFor(row: ServiceRow): SearchPort {
    return createSearchPort(row.name, parseConfig(row), this.decrypt(row), this.deps);
  }

  private decrypt(row: ServiceRow): string | null {
    if (!row.secret_encrypted) return null;
    try {
      return this.secrets.decrypt(row.secret_encrypted);
    } catch (error) {
      throw new AppError("config", `The secret of "${row.name}" cannot be decrypted on this device; enter it again.`, {
        cause: error,
      });
    }
  }

  private toService(row: ServiceRow): SearchService {
    let hint: string | null = null;
    if (row.secret_encrypted) {
      try {
        const secret = this.secrets.decrypt(row.secret_encrypted);
        hint = row.kind === "bocha" ? keyHint(secret) : Object.keys(lines(secret)).join(", ") || "••••";
      } catch {
        hint = "••••";
      }
    }
    return {
      id: row.id,
      name: row.name,
      config: parseConfig(row),
      enabled: row.enabled === 1,
      hasSecret: row.secret_encrypted !== null,
      secretHint: hint,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private row(id: number): ServiceRow {
    const row = this.db.prepare("SELECT * FROM search_services WHERE id = ?").get(id) as ServiceRow | undefined;
    if (!row) throw new AppError("not_found", `Search service ${id} does not exist.`);
    return row;
  }
}

/** The names of `NAME=value` lines, for a hint that reveals no values. */
function lines(secret: string): Record<string, true> {
  const names: Record<string, true> = {};
  for (const line of secret.split(/\r?\n/)) {
    const name = line.split("=")[0]?.trim();
    if (name && line.includes("=")) names[name] = true;
  }
  return names;
}

function uniqueNameError(error: unknown): AppError | null {
  if (error instanceof Error && /UNIQUE constraint failed: search_services\.name/.test(error.message)) {
    return new AppError("conflict", "A search service with this name already exists.");
  }
  return null;
}

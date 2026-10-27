import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { migrations } from "../main/db/migrations";
import { migrate } from "../main/db/sql";
import { PlainSecretStore } from "../main/services/secrets";
import { SettingsStore } from "../main/services/settings-store";
import { type BlobStore, SqlJsAdapter } from "./sqljs-database";

function memoryStore(): BlobStore & { saves: number } {
  let bytes: Uint8Array | null = null;
  return {
    saves: 0,
    load: async () => bytes,
    async save(next) {
      bytes = next;
      this.saves += 1;
    },
  };
}

const profile = { name: "DeepSeek", kind: "openai" as const, baseUrl: "https://api.deepseek.com" };

describe("SqlJsAdapter", () => {
  it("runs the desktop migrations and services, and survives a reload", async () => {
    const SQL = await initSqlJs();
    const store = memoryStore();
    const db = await SqlJsAdapter.open(SQL, store);
    migrate(db, migrations);
    const settings = new SettingsStore(db, new PlainSecretStore());
    const provider = settings.createProvider({ ...profile, apiKey: "sk-测试-1234" });
    const created = settings.createModel({ providerId: provider.id, modelId: "deepseek-v4-flash", name: "DeepSeek" });
    await db.flush();
    expect(store.saves).toBe(1);

    const reopened = await SqlJsAdapter.open(SQL, store);
    migrate(reopened, migrations);
    const again = new SettingsStore(reopened, new PlainSecretStore());
    expect(again.listModels().find((item) => item.id === created.id)?.name).toBe("DeepSeek");
    expect(again.resolveProfile(created.id).apiKey).toBe("sk-测试-1234");
  });

  it("keeps foreign keys on after saving, and reports changes like node:sqlite", async () => {
    const db = await SqlJsAdapter.open(await initSqlJs(), memoryStore());
    migrate(db, migrations);
    await db.flush();
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").run();
    const result = db.prepare("INSERT INTO t (v) VALUES (?), (?)").run("a", null);
    expect(result).toEqual({ changes: 2, lastInsertRowid: 2 });
    expect(db.prepare("SELECT v FROM t WHERE id = ?").get(9)).toBeUndefined();
    expect(db.prepare("SELECT v FROM t ORDER BY id").all()).toEqual([{ v: "a" }, { v: null }]);
  });
});

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { openDatabase } from "../db/database";
import { createSearchPort, parseSecretLines } from "./search-ports";
import { SearchStore } from "./search-store";
import { PlainSecretStore } from "./secrets";

/** A tiny MCP search server in memory, standing in for a local process. */
function memoryMcp(seen: { query?: string; env?: Record<string, string> }) {
  return (_command: string, _args: string[], env: Record<string, string>) => {
    seen.env = env;
    const [client, server] = InMemoryTransport.createLinkedPair();
    const mcp = new McpServer({ name: "search", version: "1.0.0" });
    mcp.registerTool("web_search", { inputSchema: { q: z.string() } }, async ({ q }) => {
      seen.query = q;
      return {
        content: [
          { type: "text", text: JSON.stringify([{ title: `About ${q}`, url: "https://ex.dev/a", snippet: "s" }]) },
        ],
      };
    });
    void mcp.connect(server);
    return client;
  };
}

function setup(deps = {}) {
  const db = openDatabase(":memory:");
  return { db, store: new SearchStore(db, new PlainSecretStore(), deps) };
}

describe("SearchStore", () => {
  it("keeps secrets encrypted, shows only a hint, and keeps them on update when omitted", () => {
    const { db, store } = setup();
    const created = store.create({ name: "Bocha", config: { kind: "bocha" }, secret: "sk-bocha-1234567" });
    expect(created).toMatchObject({ hasSecret: true, secretHint: "••••4567", enabled: true });
    const raw = db.prepare("SELECT secret_encrypted FROM search_services").get() as { secret_encrypted: string };
    expect(raw.secret_encrypted).not.toContain("sk-bocha");

    const updated = store.update(created.id, { name: "Bocha 2", config: { kind: "bocha" }, enabled: false });
    expect(updated).toMatchObject({ name: "Bocha 2", hasSecret: true, enabled: false });
    expect(store.update(created.id, { name: "Bocha 2", config: { kind: "bocha" }, secret: "" }).hasSecret).toBe(false);
  });

  it("names the variables of an MCP secret without revealing values", () => {
    const { store } = setup();
    const service = store.create({
      name: "Remote",
      config: { kind: "mcp_http", url: "https://mcp.example.com/mcp", toolName: "search" },
      secret: "Authorization=Bearer abc\nX-Team=7",
    });
    expect(service.secretHint).toBe("Authorization, X-Team");
    expect(service.config).toMatchObject({ queryArg: "query" });
  });

  it("rejects duplicate names", () => {
    const { store } = setup();
    store.create({ name: "A", config: { kind: "bocha" }, secret: "k" });
    expect(() => store.create({ name: "A", config: { kind: "bocha" }, secret: "k" })).toThrow(
      expect.objectContaining({ kind: "conflict" }),
    );
  });

  it("uses the first enabled service for research", () => {
    const { store } = setup();
    expect(store.activePort()).toBeNull();
    store.create({ name: "Off", config: { kind: "bocha" }, secret: "k", enabled: false });
    store.create({ name: "On", config: { kind: "bocha" }, secret: "k" });
    expect(store.activePort()?.name).toBe("On");
  });

  it("skips local MCP servers where no process can be started", () => {
    const { store } = setup();
    store.create({ name: "Local", config: { kind: "mcp_stdio", command: "npx", toolName: "search" } });
    expect(store.activePort()).toBeNull();
    store.create({ name: "Bocha", config: { kind: "bocha" }, secret: "k" });
    expect(store.activePort()?.name).toBe("Bocha");
  });

  it("searches through an MCP server and passes the configured environment", async () => {
    const seen: { query?: string; env?: Record<string, string> } = {};
    const { store } = setup({ stdio: memoryMcp(seen) });
    const service = store.create({
      name: "Local",
      config: { kind: "mcp_stdio", command: "npx", args: ["-y", "some-search"], toolName: "web_search", queryArg: "q" },
      secret: "API_KEY=secret",
    });
    const result = await store.test(service.id, "vite 8");
    expect(result).toMatchObject({ ok: true, error: null });
    expect(result.results).toEqual([{ title: "About vite 8", url: "https://ex.dev/a", snippet: "s" }]);
    expect(seen).toEqual({ query: "vite 8", env: { API_KEY: "secret" } });
  });

  it("reports a failing test instead of throwing", async () => {
    const { store } = setup();
    const service = store.create({
      name: "Local",
      config: { kind: "mcp_stdio", command: "npx", toolName: "web_search" },
    });
    // No process launcher (as in the web build).
    const result = await store.test(service.id, "x");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("desktop app");
  });
});

describe("search ports", () => {
  it("parses NAME=value lines", () => {
    expect(parseSecretLines("# comment\nA=1\n  B = two=2 \n\nbad line")).toEqual({ A: "1", B: "two=2" });
  });

  it("needs a key for Bocha", () => {
    expect(() => createSearchPort("Bocha", { kind: "bocha" }, null, {})).toThrow(
      expect.objectContaining({ kind: "config" }),
    );
  });
});

import { bochaSearch, parseMcpContent, type SearchPort } from "@km0/core";
import { AppError, type SearchServiceConfig } from "@km0/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Starts a local MCP server process. Only the desktop app can; the web build passes none. */
export type StdioTransportFactory = (command: string, args: string[], env: Record<string, string>) => Transport;

export interface SearchPortDeps {
  stdio?: StdioTransportFactory;
  fetch?: typeof fetch;
}

/** `NAME=value` per line → a record. Blank lines and lines starting with # are ignored. */
export function parseSecretLines(secret: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of (secret ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const split = trimmed.indexOf("=");
    if (split <= 0) continue;
    result[trimmed.slice(0, split).trim()] = trimmed.slice(split + 1).trim();
  }
  return result;
}

export function createSearchPort(
  name: string,
  config: SearchServiceConfig,
  secret: string | null,
  deps: SearchPortDeps,
): SearchPort {
  if (config.kind === "bocha") {
    if (!secret) throw new AppError("config", `The search service "${name}" has no API key.`);
    const port = bochaSearch(secret, { fetch: deps.fetch });
    return { ...port, name };
  }
  const vars = parseSecretLines(secret);
  let transport: () => Transport;
  if (config.kind === "mcp_stdio") {
    const stdio = deps.stdio;
    if (!stdio) {
      throw new AppError("config", `"${name}" starts a local MCP server, which only the desktop app can do.`);
    }
    transport = () => stdio(config.command, config.args, vars);
  } else {
    transport = () => new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: vars } });
  }
  return mcpSearch(name, transport, config.toolName, config.queryArg);
}

/** Calls one tool of an MCP server per search. The connection opens on first use and is reused until `close`. */
function mcpSearch(name: string, transport: () => Transport, toolName: string, queryArg: string): SearchPort {
  let client: Promise<Client> | null = null;
  const connect = () => {
    client ??= (async () => {
      const instance = new Client({ name: "km0", version: "1.0.0" });
      try {
        await instance.connect(transport());
      } catch (error) {
        client = null;
        throw new AppError("upstream", `Could not connect to the MCP server "${name}".`, {
          cause: error,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return instance;
    })();
    return client;
  };
  return {
    name,
    async search(query) {
      const instance = await connect();
      const result = await instance.callTool({ name: toolName, arguments: { [queryArg]: query } });
      const content = Array.isArray(result.content) ? result.content : [];
      if (result.isError) {
        const text = parseMcpContent(content)[0]?.snippet ?? "";
        throw new AppError("upstream", `The MCP tool "${toolName}" reported an error.`, { detail: text });
      }
      const structured = result.structuredContent
        ? [{ type: "text", text: JSON.stringify(result.structuredContent) }]
        : [];
      return parseMcpContent([...structured, ...content]);
    },
    async close() {
      const pending = client;
      client = null;
      if (pending) await (await pending.catch(() => null))?.close();
    },
  };
}

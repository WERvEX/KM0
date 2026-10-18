import { z } from "zod";

/** bocha: Bocha web search API · mcp_stdio: a local MCP server started as a process · mcp_http: a remote MCP server. */
export const SearchServiceKind = z.enum(["bocha", "mcp_stdio", "mcp_http"]);
export type SearchServiceKind = z.infer<typeof SearchServiceKind>;

/** Which MCP tool runs the search, and the name of its query argument. */
const McpTool = z.object({
  toolName: z.string().trim().min(1).max(120),
  queryArg: z.string().trim().min(1).max(60).default("query"),
});

/** Non-secret settings per kind. API keys and auth headers go in the separately encrypted secret. */
export const SearchServiceConfig = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bocha") }),
  McpTool.extend({
    kind: z.literal("mcp_stdio"),
    command: z.string().trim().min(1).max(500),
    args: z.array(z.string().max(500)).max(40).default([]),
  }),
  McpTool.extend({
    kind: z.literal("mcp_http"),
    url: z.url(),
  }),
]);
export type SearchServiceConfig = z.output<typeof SearchServiceConfig>;

export const SearchServiceInput = z.object({
  name: z.string().trim().min(1).max(80),
  config: SearchServiceConfig,
  enabled: z.boolean().default(true),
  /**
   * Bocha: the API key. MCP: environment variables (stdio) or HTTP headers (http), one `NAME=value`
   * per line. Omitted keeps the stored secret; an empty string removes it.
   */
  secret: z.string().max(8000).optional(),
});
export type SearchServiceInput = z.input<typeof SearchServiceInput>;
export type SearchServiceFields = z.output<typeof SearchServiceInput>;

/** A search service as the renderer sees it: never the secret itself. */
export const SearchService = z.object({
  id: z.number().int(),
  name: z.string(),
  config: SearchServiceConfig,
  enabled: z.boolean(),
  hasSecret: z.boolean(),
  secretHint: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SearchService = z.infer<typeof SearchService>;

export const SearchResult = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const SearchTestResult = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nonnegative(),
  results: z.array(SearchResult),
  error: z.string().nullable(),
});
export type SearchTestResult = z.infer<typeof SearchTestResult>;

export const ResearchFinding = z.object({
  query: z.string(),
  results: z.array(SearchResult),
  error: z.string().nullable(),
});
export type ResearchFinding = z.infer<typeof ResearchFinding>;

/**
 * Evidence gathered before technology questions are asked.
 * verified: at least one search returned results · unverified: no search service is enabled ·
 * failed: searches ran but none returned anything usable.
 */
export const Research = z.object({
  status: z.enum(["verified", "unverified", "failed"]),
  service: z.string().nullable(),
  findings: z.array(ResearchFinding),
});
export type Research = z.infer<typeof Research>;

/** At most this many searches per technology stage. */
export const MAX_RESEARCH_CALLS = 3;

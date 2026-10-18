import { AppError, type SearchResult } from "@km0/shared";

/** One search backend. KM0 only ever sends it a query and reads back titles, links and snippets. */
export interface SearchPort {
  /** Shown next to the evidence, e.g. the service name the user gave. */
  readonly name: string;
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
  /** Release a connection kept open between searches. */
  close?(): Promise<void>;
}

const SNIPPET_LIMIT = 400;

function clip(text: string, limit = SNIPPET_LIMIT): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

const BOCHA_URL = "https://api.bochaai.com/v1/web-search";

interface BochaPage {
  name?: unknown;
  url?: unknown;
  snippet?: unknown;
  summary?: unknown;
}

/** Bocha web search (https://open.bochaai.com). Works from Node and from the browser debug build. */
export function bochaSearch(apiKey: string, options: { fetch?: typeof fetch; count?: number } = {}): SearchPort {
  const doFetch = options.fetch ?? fetch;
  return {
    name: "Bocha",
    async search(query, signal) {
      let response: Response;
      try {
        response = await doFetch(BOCHA_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, summary: true, count: options.count ?? 5 }),
          signal,
        });
      } catch (error) {
        throw new AppError("upstream", "Could not reach the Bocha search API.", { cause: error });
      }
      if (response.status === 401 || response.status === 403) {
        throw new AppError("config", "Bocha rejected the API key.");
      }
      if (!response.ok) {
        throw new AppError("upstream", `Bocha search failed with HTTP ${response.status}.`);
      }
      const body = (await response.json()) as { data?: { webPages?: { value?: BochaPage[] } } };
      return parseBochaPages(body.data?.webPages?.value ?? []);
    },
  };
}

export function parseBochaPages(pages: BochaPage[]): SearchResult[] {
  const results: SearchResult[] = [];
  for (const page of pages) {
    if (typeof page.url !== "string" || !page.url) continue;
    const text = typeof page.summary === "string" && page.summary ? page.summary : page.snippet;
    results.push({
      title: typeof page.name === "string" ? clip(page.name, 160) : page.url,
      url: page.url,
      snippet: typeof text === "string" ? clip(text) : "",
    });
  }
  return results;
}

/**
 * Turn an MCP tool result into search results. Search servers answer in many shapes: JSON arrays,
 * one JSON object per text block, or plain text. Links found anywhere are kept; text without a
 * link becomes a single result so the model still sees it.
 */
export function parseMcpContent(content: unknown): SearchResult[] {
  const texts: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") texts.push(text);
      }
    }
  }
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const add = (item: SearchResult) => {
    if (seen.has(item.url) || results.length >= 8) return;
    seen.add(item.url);
    results.push(item);
  };
  for (const text of texts) {
    const parsed = tryJson(text);
    const found = parsed === undefined ? [] : collectPages(parsed);
    if (found.length > 0) {
      for (const item of found) add(item);
      continue;
    }
    const links = [...text.matchAll(/https?:\/\/[^\s)<>"'\]]+/g)].map((match) => match[0]);
    if (links.length === 0) {
      if (text.trim()) add({ title: clip(text, 80), url: "", snippet: clip(text) });
      continue;
    }
    for (const url of links) add({ title: url, url, snippet: clip(text) });
  }
  return results;
}

function tryJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Find objects with a url-like field anywhere in a JSON value. */
function collectPages(value: unknown, depth = 0): SearchResult[] {
  if (depth > 5 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectPages(item, depth + 1));
  const record = value as Record<string, unknown>;
  const url = [record.url, record.link, record.href].find((item) => typeof item === "string" && /^https?:/.test(item));
  if (typeof url === "string") {
    const title = [record.title, record.name].find((item) => typeof item === "string") as string | undefined;
    const snippet = [record.summary, record.snippet, record.content, record.description, record.text].find(
      (item) => typeof item === "string",
    ) as string | undefined;
    return [{ title: clip(title ?? url, 160), url, snippet: clip(snippet ?? "") }];
  }
  return Object.values(record).flatMap((item) => collectPages(item, depth + 1));
}

/** A leaderboard result as published, before names are matched. */
export interface Entry {
  /** The model as the source spells it. */
  model: string;
  /** The agent or harness as the source spells it; null for model-only measurements. */
  agent: string | null;
  column: string;
  /** As published: a percentage, an index or an Elo rating. */
  value: number;
  /** Standard error of `value`, when the source gives one. */
  se: number | null;
  effort: string | null;
  date: string | null;
}

export interface SourceInfo {
  id: string;
  name: string;
  url: string;
  measures: string;
}

export interface ParsedSource {
  info: SourceInfo;
  fetchedAt: string;
  entries: Entry[];
}

const USER_AGENT = "KM0-registry/1.0 (+https://github.com/WERvEX/KM0)";
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_ATTEMPTS = 3;

export async function fetchText(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.ok) return await response.text();
      lastError = new Error(`${url}: HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < FETCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(`${url}: fetch failed`);
}

export async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T;
}

/** The React Server Components payload a Next.js page streams in `self.__next_f.push([1, "…"])` calls. */
export function nextFlight(html: string): string {
  const pattern = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let flight = "";
  for (const match of html.matchAll(pattern)) flight += JSON.parse(`"${match[1]}"`) as string;
  return flight;
}

/** The JSON value that starts right after `marker` in `text`. */
export function jsonAfter<T>(text: string, marker: string, from = 0): T {
  const start = text.indexOf(marker, from);
  if (start < 0) throw new Error(`Marker not found: ${marker}`);
  let index = start + marker.length;
  const open = text[index];
  if (open !== "{" && open !== "[") throw new Error(`No JSON after ${marker}`);
  let depth = 0;
  let inString = false;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start + marker.length, index + 1)) as T;
    }
  }
  throw new Error(`Unterminated JSON after ${marker}`);
}

export const isoDate = (value: number | string | null | undefined): string | null => {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

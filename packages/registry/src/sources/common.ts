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

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
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

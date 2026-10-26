import { type Entry, fetchText, type ParsedSource } from "./common";

/** Aider's polyglot leaderboard: 225 exercises in six languages, edited through Aider. Updates stopped in late 2025. */

export interface AiderRow {
  model: string;
  passRate: number;
  date: string | null;
  editFormat: string | null;
}

export interface AiderRaw {
  fetchedAt: string;
  rows: AiderRow[];
}

export const AIDER = {
  id: "aider-polyglot",
  name: "Aider Polyglot",
  url: "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml",
  measures: "Small coding exercises in six languages, edited through Aider (general coding; older models only).",
};

/** The leaderboard file is a flat YAML list of scalar maps; that much YAML is parsed here. */
export function parseFlatYamlList(text: string): Record<string, string>[] {
  const items: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const line of text.split("\n")) {
    const item = line.match(/^- (\w[\w-]*):\s*(.*)$/);
    const field = line.match(/^ {2}(\w[\w-]*):\s*(.*)$/);
    if (item) {
      current = {};
      items.push(current);
      current[item[1] as string] = unquote(item[2] ?? "");
    } else if (field && current) {
      current[field[1] as string] = unquote(field[2] ?? "");
    }
  }
  return items;
}

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, "$2");

export async function fetchAider(): Promise<AiderRaw> {
  const rows = parseFlatYamlList(await fetchText(AIDER.url))
    .filter((row) => row.model && row.pass_rate_2)
    .map((row) => ({
      model: row.model as string,
      passRate: Number(row.pass_rate_2),
      date: row.date ?? null,
      editFormat: row.edit_format ?? null,
    }));
  return { fetchedAt: new Date().toISOString(), rows };
}

export function parseAider(raw: AiderRaw): ParsedSource {
  const entries: Entry[] = raw.rows.map((row) => ({
    model: row.model,
    agent: null,
    column: "aider_polyglot",
    value: row.passRate,
    se: null,
    effort: null,
    date: row.date,
  }));
  return { info: AIDER, fetchedAt: raw.fetchedAt, entries };
}

import { type Entry, fetchText, isoDate, jsonAfter, nextFlight, type ParsedSource } from "./common";

/**
 * SWE-rebench (swe-rebench.com): fresh GitHub tasks collected after each model's release, run in one
 * harness, so contamination is unlikely. Results are kept per language.
 */

export interface SweRebenchItem {
  model: string;
  developer: string | null;
  kind: string;
  release: string | null;
  windowFrom: string | null;
  windowTo: string | null;
  /** Resolved rate (%) and its standard error, per language and for all tasks ("all"). */
  rates: Record<string, { rate: number; sem: number }>;
}

export interface SweRebenchRaw {
  fetchedAt: string;
  items: SweRebenchItem[];
}

export const SWE_REBENCH = {
  id: "swe-rebench",
  name: "SWE-rebench",
  url: "https://swe-rebench.com/",
  measures:
    "Fresh GitHub issues collected after each model's release, in one harness (backend, debugging); its TypeScript tasks inform frontend.",
};

interface Item {
  modelName: string;
  agentVersion?: string;
  release?: { date?: string };
  meta?: { developer?: string; instance_type?: string };
  taskRangeTimestamp?: { from: number; to: number };
  rangeStats?: Record<string, Record<string, { resolvedRate: number; sem: number }>>;
}

export async function fetchSweRebench(): Promise<SweRebenchRaw> {
  const flight = nextFlight(await fetchText(SWE_REBENCH.url));
  const items = jsonAfter<Item[]>(flight, '"items":', flight.indexOf('"items":[{"modelId"'));
  return {
    fetchedAt: new Date().toISOString(),
    items: items
      .filter((item) => item.taskRangeTimestamp && item.rangeStats)
      .map((item) => {
        const range = item.taskRangeTimestamp as { from: number; to: number };
        const key = `${range.from}:${range.to}`;
        const rates: SweRebenchItem["rates"] = {};
        for (const [language, windows] of Object.entries(item.rangeStats ?? {})) {
          const stats = windows[key];
          if (stats && stats.resolvedRate > 0) rates[language] = { rate: stats.resolvedRate, sem: stats.sem };
        }
        return {
          model: item.modelName,
          developer: item.meta?.developer ?? null,
          kind: `${item.meta?.instance_type ?? "model"}:${item.agentVersion ?? ""}`,
          release: item.release?.date ?? null,
          windowFrom: isoDate(range.from),
          windowTo: isoDate(range.to),
          rates,
        };
      }),
  };
}

export function parseSweRebench(raw: SweRebenchRaw): ParsedSource {
  const entries: Entry[] = [];
  for (const item of raw.items) {
    // Model runs only: the tool-calling harness; agent products and the old text mode are left out.
    if (item.kind !== "model:tools") continue;
    const add = (column: string, stats: { rate: number; sem: number } | undefined) => {
      if (stats) {
        entries.push({
          model: item.model,
          agent: null,
          column,
          value: stats.rate,
          se: stats.sem,
          effort: null,
          date: item.windowTo,
        });
      }
    };
    add("swe_rebench", item.rates.all);
    add("swe_rebench_ts", item.rates.typescript);
  }
  return { info: SWE_REBENCH, fetchedAt: raw.fetchedAt, entries };
}

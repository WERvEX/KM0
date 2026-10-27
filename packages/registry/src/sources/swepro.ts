import { type Entry, fetchText, isoDate, jsonAfter, nextFlight, type ParsedSource } from "./common";

/** SWE-Bench Pro (Scale): long, multi-file changes in professional repositories; rows name the agent. */

export interface SweProEntry {
  variant: "full" | "hard";
  /** As published, such as "Opus 5 (Claude Code) xhigh". */
  label: string;
  score: number;
  ci: number | null;
  company: string;
  date: string | null;
}

export interface SweProRaw {
  fetchedAt: string;
  entries: SweProEntry[];
}

export const SWE_PRO = {
  id: "swe-bench-pro",
  name: "SWE-Bench Pro V2",
  url: "https://labs.scale.com/leaderboard/swe_bench_pro_public_v2",
  measures:
    "Long, multi-file changes in professional codebases (backend). The hard subset separates strong models; rows name the agent.",
};

interface Variant {
  key: string;
  entries: { model: string; score: number; confidenceInterval_upper?: number; company: string; createdAt?: string }[];
}

export async function fetchSwePro(): Promise<SweProRaw> {
  const flight = nextFlight(await fetchText(SWE_PRO.url));
  const variants = jsonAfter<Variant[]>(flight, '"variants":');
  const entries: SweProEntry[] = [];
  for (const variant of variants) {
    if (variant.key !== "full" && variant.key !== "hard") continue;
    for (const entry of variant.entries) {
      entries.push({
        variant: variant.key,
        label: entry.model.trim(),
        score: entry.score,
        ci: entry.confidenceInterval_upper ?? null,
        company: entry.company,
        date: isoDate(entry.createdAt),
      });
    }
  }
  return { fetchedAt: new Date().toISOString(), entries };
}

/** "Opus 5 (Claude Code) xhigh" → model, agent and effort. */
export function splitLabel(label: string): { model: string; agent: string | null; effort: string | null } {
  const match = label.match(/^(.*?)\s*\(([^)]+)\)\s*([\w-]+)?\s*$/);
  if (!match) return { model: label.replace(/\*$/, "").trim(), agent: null, effort: null };
  return {
    model: (match[1] ?? "").replace(/\*$/, "").trim(),
    agent: match[2]?.trim() ?? null,
    effort: match[3] ?? null,
  };
}

export function parseSwePro(raw: SweProRaw): ParsedSource {
  const entries: Entry[] = raw.entries.map((entry) => {
    const { model, agent, effort } = splitLabel(entry.label);
    return {
      model,
      agent,
      column: entry.variant === "full" ? "swe_pro" : "swe_pro_hard",
      value: entry.score,
      // A zero interval means the source did not compute one.
      se: entry.ci ? entry.ci / 1.96 : null,
      effort,
      date: entry.date,
    };
  });
  return { info: SWE_PRO, fetchedAt: raw.fetchedAt, entries };
}

import { type Entry, fetchText, jsonAfter, nextFlight, type ParsedSource } from "./common";

/** Terminal-Bench (tbench.ai): hard tasks in a terminal, run by named agents with named models. */

export interface TerminalBenchRow {
  date: string | null;
  agent: string;
  model: string;
  effort: string | null;
  accuracy: number;
  ci95: number | null;
  costUsd: number | null;
}

export interface TerminalBenchRaw {
  fetchedAt: string;
  title: string;
  rows: TerminalBenchRow[];
}

export const TERMINAL_BENCH = {
  id: "terminal-bench",
  name: "Terminal-Bench",
  url: "https://www.tbench.ai/",
  measures:
    "Long tasks in a terminal: building, configuring, debugging systems (deployment and configuration). Rows name the agent, so it also measures agents.",
};

interface Row {
  metadata: {
    date?: string;
    agent_display?: { label?: string };
    model_display?: { label?: string };
    reasoning_effort?: string;
  };
  metrics: { accuracy?: number; accuracy_ci95_half_width?: number; total_cost_usd?: number };
}

export async function fetchTerminalBench(): Promise<TerminalBenchRaw> {
  const flight = nextFlight(await fetchText(TERMINAL_BENCH.url));
  const board = flight.indexOf('"leaderboard":{');
  const leaderboard = jsonAfter<{ title: string }>(flight, '"leaderboard":', board);
  const rows = jsonAfter<Row[]>(flight, '"rows":', board);
  return {
    fetchedAt: new Date().toISOString(),
    title: leaderboard.title,
    rows: rows
      .filter((row) => typeof row.metrics.accuracy === "number")
      .map((row) => ({
        date: row.metadata.date ?? null,
        agent: row.metadata.agent_display?.label ?? "",
        model: row.metadata.model_display?.label ?? "",
        effort: row.metadata.reasoning_effort ?? null,
        accuracy: row.metrics.accuracy as number,
        ci95: row.metrics.accuracy_ci95_half_width ?? null,
        costUsd: row.metrics.total_cost_usd ?? null,
      })),
  };
}

export function parseTerminalBench(raw: TerminalBenchRaw): ParsedSource {
  const entries: Entry[] = raw.rows.map((row) => ({
    model: row.model,
    agent: row.agent,
    column: "terminal_bench",
    value: row.accuracy,
    se: row.ci95 === null ? null : row.ci95 / 1.96,
    effort: row.effort,
    date: row.date,
  }));
  return { info: { ...TERMINAL_BENCH, name: raw.title || TERMINAL_BENCH.name }, fetchedAt: raw.fetchedAt, entries };
}

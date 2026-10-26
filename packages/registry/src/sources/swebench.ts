import { type Entry, fetchJson, fetchText, type ParsedSource } from "./common";

/**
 * SWE-bench (swebench.com): real GitHub issues in Python repositories. KM0 uses Verified as the
 * anchor of its ability scale, because its tasks carry human time estimates and the leaderboard
 * publishes, for runs with the neutral mini-SWE-agent harness, which task each run solved.
 */

export interface SweBenchSubmission {
  board: "Verified" | "Multilingual";
  name: string;
  agent: string;
  /** Model names from the submission's tags ("Model: …"); several for multi-model systems. */
  models: string[];
  modelDisplay: string;
  date: string | null;
  resolved: number;
  effort: string | null;
  /** For Verified runs with per-task results: "1" or "0" per task, in the order of `tasks`. */
  solved: string | null;
}

export interface SweBenchTask {
  id: string;
  /** Human estimate of the time a developer needs: "<15 min fix", "15 min - 1 hour", "1-4 hours", ">4 hours". */
  difficulty: string;
  /** Files the reference patch changes. */
  files: number;
}

export interface SweBenchRaw {
  fetchedAt: string;
  tasks: SweBenchTask[];
  submissions: SweBenchSubmission[];
}

export const SWEBENCH = {
  id: "swebench",
  name: "SWE-bench Verified and Multilingual",
  url: "https://www.swebench.com/",
  measures:
    "Fixing real GitHub issues (backend, debugging). Verified anchors KM0's ability scale and, through its human time estimates, the difficulty of tasks.",
};

const DATASET_ROWS =
  "https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/SWE-bench_Verified&config=default&split=test";

interface SiteResult {
  name: string;
  agent?: string;
  model_display?: string;
  date?: string;
  resolved?: number;
  reasoning_effort?: string;
  tags?: string[];
  per_instance_details?: Record<string, { resolved: boolean }> | null;
}

export async function fetchSweBench(): Promise<SweBenchRaw> {
  const tasks: SweBenchTask[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await fetchJson<{ rows: { row: { instance_id: string; difficulty: string; patch: string } }[] }>(
      `${DATASET_ROWS}&offset=${offset}&length=100`,
    );
    for (const { row } of page.rows) {
      tasks.push({
        id: row.instance_id,
        difficulty: row.difficulty,
        files: (row.patch.match(/^diff --git /gm) ?? []).length,
      });
    }
    if (page.rows.length < 100) break;
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));

  const html = await fetchText(SWEBENCH.url);
  const match = html.match(/<script type="application\/json" id="leaderboard-data">([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("swebench.com: leaderboard data not found");
  const boards = JSON.parse(match[1]) as { name: string; results: SiteResult[] }[];
  const submissions: SweBenchSubmission[] = [];
  for (const board of boards) {
    if (board.name !== "Verified" && board.name !== "Multilingual") continue;
    for (const result of board.results) {
      if (typeof result.resolved !== "number") continue;
      const details = result.per_instance_details;
      const solved =
        board.name === "Verified" && details && Object.keys(details).length > 0
          ? tasks.map((task) => (details[task.id]?.resolved ? "1" : "0")).join("")
          : null;
      submissions.push({
        board: board.name,
        name: result.name,
        agent: result.agent ?? "",
        models: (result.tags ?? []).filter((tag) => tag.startsWith("Model: ")).map((tag) => tag.slice(7)),
        modelDisplay: result.model_display ?? "",
        date: result.date ?? null,
        resolved: result.resolved,
        effort: result.reasoning_effort ?? null,
        solved,
      });
    }
  }
  submissions.sort((a, b) => `${a.board}${a.date}${a.name}`.localeCompare(`${b.board}${b.date}${b.name}`));
  return { fetchedAt: new Date().toISOString(), tasks, submissions };
}

export function parseSweBench(raw: SweBenchRaw): ParsedSource {
  const entries: Entry[] = [];
  for (const submission of raw.submissions) {
    // Systems that combine several models say nothing about any one of them.
    if (submission.models.length !== 1 || submission.modelDisplay === "Multiple") continue;
    entries.push({
      model: submission.models[0] ?? submission.modelDisplay,
      agent: submission.agent,
      column: submission.board === "Verified" ? "swebench_verified" : "swebench_multilingual",
      value: submission.resolved,
      se: null,
      effort: submission.effort,
      date: submission.date,
    });
  }
  return { info: SWEBENCH, fetchedAt: raw.fetchedAt, entries };
}

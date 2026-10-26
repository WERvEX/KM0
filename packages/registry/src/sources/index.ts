import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AiderRaw, fetchAider, parseAider } from "./aider";
import type { ParsedSource } from "./common";
import { fetchOpenRouter, type OpenRouterRaw, parseOpenRouter } from "./openrouter";
import { fetchSweBench, parseSweBench, type SweBenchRaw } from "./swebench";
import { fetchSwePro, parseSwePro, type SweProRaw } from "./swepro";
import { fetchSweRebench, parseSweRebench, type SweRebenchRaw } from "./swerebench";
import { fetchTerminalBench, parseTerminalBench, type TerminalBenchRaw } from "./tbench";

export type { Entry, ParsedSource, SourceInfo } from "./common";
export type { OpenRouterModel, OpenRouterRaw } from "./openrouter";
export type { SweBenchRaw, SweBenchTask } from "./swebench";

/** Every source, in the order the report lists them. Each snapshot is data/raw/<id>.json. */
const SOURCES = {
  openrouter: { fetch: fetchOpenRouter, parse: (raw: unknown) => parseOpenRouter(raw as OpenRouterRaw) },
  "terminal-bench": { fetch: fetchTerminalBench, parse: (raw: unknown) => parseTerminalBench(raw as TerminalBenchRaw) },
  "swe-bench-pro": { fetch: fetchSwePro, parse: (raw: unknown) => parseSwePro(raw as SweProRaw) },
  "swe-rebench": { fetch: fetchSweRebench, parse: (raw: unknown) => parseSweRebench(raw as SweRebenchRaw) },
  swebench: { fetch: fetchSweBench, parse: (raw: unknown) => parseSweBench(raw as SweBenchRaw) },
  "aider-polyglot": { fetch: fetchAider, parse: (raw: unknown) => parseAider(raw as AiderRaw) },
} as const;

export type SourceId = keyof typeof SOURCES;
export const SOURCE_IDS = Object.keys(SOURCES) as SourceId[];

export interface Snapshots {
  openrouter: OpenRouterRaw;
  swebench: SweBenchRaw;
  parsed: ParsedSource[];
}

/** Download every source; a source that fails keeps its previous snapshot and is reported. */
export async function fetchAll(rawDir: string, log: (line: string) => void): Promise<string[]> {
  const failed: string[] = [];
  for (const id of SOURCE_IDS) {
    try {
      const raw = await SOURCES[id].fetch();
      await writeFile(join(rawDir, `${id}.json`), `${JSON.stringify(raw, null, 1)}\n`);
      log(`fetched ${id}: ${SOURCES[id].parse(raw).entries.length} entries`);
    } catch (error) {
      failed.push(id);
      log(`FAILED ${id}: ${error instanceof Error ? error.message : String(error)} (keeping the previous snapshot)`);
    }
  }
  return failed;
}

export async function loadSnapshots(rawDir: string): Promise<Snapshots> {
  const raws = new Map<SourceId, unknown>();
  for (const id of SOURCE_IDS) raws.set(id, JSON.parse(await readFile(join(rawDir, `${id}.json`), "utf8")));
  return {
    openrouter: raws.get("openrouter") as OpenRouterRaw,
    swebench: raws.get("swebench") as SweBenchRaw,
    parsed: SOURCE_IDS.map((id) => SOURCES[id].parse(raws.get(id))),
  };
}

import { type CatalogModel, createMatcher, looseKey, nameWords } from "@km0/shared";
import type { ColumnSpec, Observation } from "./fit";
import type { Entry, OpenRouterModel, ParsedSource } from "./sources";

export interface AgentDef {
  id: string;
  name: string;
  labels: string[];
  nativeVendors: string[];
  reference?: boolean;
}

export interface VendorDef {
  id: string;
  name: string;
  families: string[];
  nativeAgents: string[];
}

export interface Tables {
  aliases: Record<string, string>;
  agents: AgentDef[];
  vendors: VendorDef[];
  columns: Record<string, ColumnSpec>;
}

export interface Problem {
  source: string;
  name: string;
  kind: "unmatched-model" | "ambiguous-model" | "unknown-agent";
  candidates: string[];
}

export interface Aligned {
  observations: Observation[];
  /** Raw spellings that matched each canonical model. */
  spellings: Map<string, Set<string>>;
  /** Models that appear on leaderboards but not in the catalog; they help link columns and are not published. */
  unlisted: Set<string>;
  problems: Problem[];
  /** Matched entries per source, and entries left out. */
  counts: Map<string, { matched: number; unmatched: number; newest: string | null }>;
}

const UNLISTED = "unlisted/";

/** The vendor of a canonical ID, or of an unlisted model by the family words in its name. */
export function vendorOf(id: string, vendors: VendorDef[]): string | null {
  if (!id.startsWith(UNLISTED)) return id.split("/")[0] ?? null;
  const words = nameWords(id.slice(UNLISTED.length));
  for (const vendor of vendors) {
    if (vendor.families.some((family) => words.some((word) => word.startsWith(family)))) return vendor.id;
  }
  return null;
}

/**
 * Turns every source's entries into observations of canonical models: names matched, agents
 * resolved, and repeated results for the same model, column and agent (other efforts, reruns)
 * reduced to the best one, which is what a user who picks the setting gets.
 */
export function align(sources: ParsedSource[], catalog: OpenRouterModel[], tables: Tables): Aligned {
  const catalogModels: CatalogModel[] = catalog.map((model) => ({ id: model.id, name: model.name }));
  const matcher = createMatcher(catalogModels, tables.aliases);
  const agentByLabel = new Map<string, AgentDef>();
  for (const agent of tables.agents) for (const label of agent.labels) agentByLabel.set(label.toLowerCase(), agent);
  const problems: Problem[] = [];
  const spellings = new Map<string, Set<string>>();
  const counts = new Map<string, { matched: number; unmatched: number; newest: string | null }>();

  // Unmatched names that recur across sources become unlisted models, grouped by their loosest spelling.
  const unmatchedSources = new Map<string, Set<string>>();
  const resolved: { source: string; entry: Entry; model: string | null; agent: AgentDef | null }[] = [];
  for (const source of sources) {
    const count = { matched: 0, unmatched: 0, newest: null as string | null };
    counts.set(source.info.id, count);
    for (const entry of source.entries) {
      if (entry.date && (!count.newest || entry.date > count.newest)) count.newest = entry.date;
      let agent: AgentDef | null = null;
      if (entry.agent) {
        agent = agentByLabel.get(entry.agent.toLowerCase()) ?? null;
        if (!agent) {
          problems.push({ source: source.info.id, name: entry.agent, kind: "unknown-agent", candidates: [] });
          count.unmatched += 1;
          continue;
        }
      }
      const result = matcher.match(entry.model);
      if ("id" in result) {
        resolved.push({ source: source.info.id, entry, model: result.id, agent });
        continue;
      }
      problems.push({
        source: source.info.id,
        name: entry.model,
        kind: result.problem === "ambiguous" ? "ambiguous-model" : "unmatched-model",
        candidates: result.candidates,
      });
      if (result.problem === "unmatched") {
        const key = [...looseKey(entry.model).split(" ")].sort().join(" ");
        const seenIn = unmatchedSources.get(key) ?? new Set<string>();
        seenIn.add(source.info.id);
        unmatchedSources.set(key, seenIn);
        resolved.push({ source: source.info.id, entry, model: null, agent });
      } else {
        count.unmatched += 1;
      }
    }
  }

  const unlisted = new Set<string>();
  const best = new Map<string, Observation>();
  for (const { source, entry, model, agent } of resolved) {
    const count = counts.get(source) as { matched: number; unmatched: number };
    let id = model;
    if (!id) {
      const key = [...looseKey(entry.model).split(" ")].sort().join(" ");
      if ((unmatchedSources.get(key)?.size ?? 0) < 2 || !key) {
        count.unmatched += 1;
        continue;
      }
      id = `${UNLISTED}${key}`;
      unlisted.add(id);
    } else {
      const names = spellings.get(id) ?? new Set<string>();
      names.add(entry.model);
      spellings.set(id, names);
    }
    count.matched += 1;
    if (!tables.columns[entry.column]) continue;
    const agentId = agent && !agent.reference ? agent.id : null;
    const vendor = vendorOf(id, tables.vendors);
    const observation: Observation = {
      model: id,
      column: entry.column,
      agent: agentId,
      native: Boolean(agent && vendor && agent.nativeVendors.includes(vendor)),
      value: entry.value,
      source,
      effort: entry.effort,
      date: entry.date,
    };
    const key = `${id}|${entry.column}|${agentId ?? ""}`;
    const previous = best.get(key);
    if (!previous || observation.value > previous.value) best.set(key, observation);
  }

  return {
    observations: [...best.values()].sort((a, b) =>
      `${a.model}|${a.column}|${a.agent}`.localeCompare(`${b.model}|${b.column}|${b.agent}`),
    ),
    spellings,
    unlisted,
    problems,
    counts,
  };
}

/**
 * Matching the names leaderboards use ("Opus 5.5", "Claude Opus 4.6-high", "gpt-5.4-2026-03-05-medium",
 * "DeepSeek-V4 Pro [high]") to canonical model IDs. Matching is by fixed normalization rules plus a
 * hand-kept alias table; nothing is matched by similarity, so a wrong merge cannot creep in. Names
 * that match nothing, or more than one model, are listed in the report for a person to settle.
 */

/** Reasoning effort words that leaderboards append to a model name. */
const EFFORT = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "none", "default"]);
/** Words that only say how a model is packaged. */
const FILLER = new Set(["instruct", "it", "chat", "preview", "exp", "latest", "beta", "think", "thinking", "no"]);
/** Words that name a vendor or product line rather than the model. */
const VENDOR_WORDS = new Set([
  "anthropic",
  "claude",
  "openai",
  "google",
  "deepmind",
  "meta",
  "xai",
  "moonshotai",
  "moonshot",
  "zhipu",
  "zai",
  "alibaba",
  "mistralai",
  "xiaomi",
]);

export interface WordOptions {
  dates?: boolean;
  efforts?: boolean;
  filler?: boolean;
  /** Four-digit snapshot tags such as "0905" or "2512". */
  snapshots?: boolean;
}

/** Words of a model name, with the chosen kinds of words removed. */
export function nameWords(raw: string, remove: WordOptions = {}): string[] {
  let name = raw.toLowerCase().trim();
  // A Hugging Face link names the model by its last path segment.
  name = name.replace(/^https?:\/\/[^/]+\/[^/]+\//, "");
  // "MoonshotAI: Kimi K3.1 Pro" → "Kimi K3.1 Pro"; "anthropic/claude-opus-5.5" → "claude-opus-5.5".
  name = name.replace(/^[^:/]{1,40}:\s+/, "").replace(/^[\w.-]+\//, "");
  // Notes in brackets: effort levels, harnesses, thinking budgets.
  name = name.replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
  // Dates become one token, so "2025-08-07" is not mistaken for version numbers below.
  name = name.replace(/\b((?:19|20)\d{2})-?(\d{2})-?(\d{2})\b/g, " d$1$2$3 ");
  // Anthropic writes versions with a dash: "opus-4-5" is "opus 4.5".
  name = name.replace(/(?<![\d.])(\d)-(\d)(?![\d.])/g, "$1.$2");
  // Letters before a version number are a separate word, but "k3", "v4", "m2.5", "o4" stay whole.
  name = name.replace(/([a-z]{2,})(\d)/g, "$1 $2");
  return name
    .split(/[\s_/,:-]+/)
    .map((word) => word.replace(/[^a-z0-9.+]/g, "").replace(/^\.+|\.+$/g, ""))
    .filter((word) => {
      if (!word || VENDOR_WORDS.has(word)) return false;
      if (/^d\d{8}$/.test(word)) return !remove.dates;
      if (remove.efforts && EFFORT.has(word)) return false;
      if (remove.filler && FILLER.has(word)) return false;
      if (remove.snapshots && /^\d{4}$/.test(word)) return false;
      return true;
    });
}

/** Rules tried in order for a leaderboard name; the first that points at exactly one model wins. */
const TIERS: WordOptions[] = [
  {},
  { dates: true },
  { dates: true, efforts: true },
  { dates: true, efforts: true, filler: true },
  { dates: true, efforts: true, filler: true, snapshots: true },
];

const exactKey = (words: string[]) => words.join(" ");
const sortedKey = (words: string[]) => [...words].sort().join(" ");

/** The loosest normal form of a name; unmatched names that share it are treated as one model. */
export const looseKey = (raw: string) => exactKey(nameWords(raw, TIERS[TIERS.length - 1]));

export interface CatalogModel {
  id: string;
  name: string;
}

export type MatchResult = { id: string } | { problem: "unmatched" | "ambiguous"; candidates: string[] };

export interface Matcher {
  match(raw: string): MatchResult;
}

/**
 * Builds the lookup from a catalog of canonical models and the alias table (keys in any spelling,
 * values canonical IDs). Catalog names keep every word, so "o4-mini" and "o4-mini-high" stay apart;
 * leaderboard names lose dates, efforts and filler words tier by tier until one model matches.
 */
export function createMatcher(catalog: CatalogModel[], aliases: Record<string, string>): Matcher {
  const exact = new Map<string, Set<string>>();
  const sorted = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, id: string) => {
    if (!key) return;
    const ids = map.get(key) ?? new Set<string>();
    ids.add(id);
    map.set(key, ids);
  };
  for (const model of catalog) {
    for (const spelling of [model.id, model.name]) {
      const words = nameWords(spelling);
      add(exact, exactKey(words), model.id);
      add(sorted, sortedKey(words), model.id);
    }
  }
  const aliasTable = new Map<string, string>();
  for (const [key, id] of Object.entries(aliases)) {
    for (const tier of TIERS) aliasTable.set(exactKey(nameWords(key, tier)), id);
  }
  const known = new Set(catalog.map((model) => model.id));

  return {
    match(raw) {
      for (const tier of TIERS) {
        const words = nameWords(raw, tier);
        const alias = aliasTable.get(exactKey(words));
        if (alias) return known.has(alias) ? { id: alias } : { problem: "unmatched", candidates: [alias] };
        for (const ids of [exact.get(exactKey(words)), sorted.get(sortedKey(words))]) {
          if (ids?.size === 1) return { id: [...ids][0] as string };
          if (ids && ids.size > 1) return { problem: "ambiguous", candidates: [...ids].sort() };
        }
      }
      return { problem: "unmatched", candidates: [] };
    },
  };
}

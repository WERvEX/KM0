import { type Entry, fetchJson, isoDate, type ParsedSource } from "./common";

/**
 * OpenRouter's model list: the catalog of models with prices, context windows and release dates,
 * plus the Artificial Analysis indices and Design Arena ratings it carries for many of them.
 */

export interface OpenRouterModel {
  id: string;
  name: string;
  created: number;
  contextLength: number | null;
  /** USD per token, as published. */
  pricing: { prompt: number | null; completion: number | null; cacheRead: number | null };
  aa: { intelligence: number | null; coding: number | null; agentic: number | null };
  designArena: { arena: string; category: string; elo: number }[];
}

export interface OpenRouterRaw {
  fetchedAt: string;
  models: OpenRouterModel[];
}

export const OPENROUTER = {
  id: "openrouter",
  name: "OpenRouter models (with Artificial Analysis and Design Arena)",
  url: "https://openrouter.ai/api/v1/models",
  measures:
    "Model catalog, prices and context windows; Artificial Analysis intelligence, coding and agentic indices; Design Arena ratings for websites, UI components and web apps (frontend).",
};

/** Design Arena categories that are frontend work. */
const FRONTEND_CATEGORIES = new Set(["website", "uicomponent", "webapps", "fullstack", "codecategories"]);

const number = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

interface ApiModel {
  id: string;
  name: string;
  created: number;
  context_length?: number | null;
  architecture?: { output_modalities?: string[] };
  pricing?: Record<string, string | undefined>;
  benchmarks?: {
    artificial_analysis?: {
      intelligence_index?: number | null;
      coding_index?: number | null;
      agentic_index?: number | null;
    };
    design_arena?: { arena: string; category: string; elo: number }[];
  };
}

export async function fetchOpenRouter(): Promise<OpenRouterRaw> {
  const { data } = await fetchJson<{ data: ApiModel[] }>(OPENROUTER.url);
  const models = data
    // Text models only; batch and free variants repeat a model at another price.
    .filter((model) => (model.architecture?.output_modalities ?? ["text"]).includes("text"))
    .filter((model) => !/:(batch|free|extended|beta|thinking)$/.test(model.id))
    .map(
      (model): OpenRouterModel => ({
        id: model.id,
        name: model.name,
        created: model.created,
        contextLength: model.context_length ?? null,
        pricing: {
          prompt: number(model.pricing?.prompt),
          completion: number(model.pricing?.completion),
          cacheRead: number(model.pricing?.input_cache_read),
        },
        aa: {
          intelligence: model.benchmarks?.artificial_analysis?.intelligence_index ?? null,
          coding: model.benchmarks?.artificial_analysis?.coding_index ?? null,
          agentic: model.benchmarks?.artificial_analysis?.agentic_index ?? null,
        },
        designArena: (model.benchmarks?.design_arena ?? [])
          .filter((rating) => FRONTEND_CATEGORIES.has(rating.category))
          .map(({ arena, category, elo }) => ({ arena, category, elo })),
      }),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  return { fetchedAt: new Date().toISOString(), models };
}

export function parseOpenRouter(raw: OpenRouterRaw): ParsedSource {
  const entries: Entry[] = [];
  for (const model of raw.models) {
    const date = isoDate(model.created * 1000);
    const add = (column: string, value: number | null) => {
      if (value !== null) entries.push({ model: model.id, agent: null, column, value, se: null, effort: null, date });
    };
    add("aa_intelligence", model.aa.intelligence);
    add("aa_coding", model.aa.coding);
    add("aa_agentic", model.aa.agentic);
    // One frontend rating per model: the mean over the frontend categories it was rated in.
    if (model.designArena.length > 0) {
      const mean = model.designArena.reduce((sum, rating) => sum + rating.elo, 0) / model.designArena.length;
      add("design_arena_frontend", Math.round(mean));
    }
  }
  return { info: OPENROUTER, fetchedAt: raw.fetchedAt, entries };
}

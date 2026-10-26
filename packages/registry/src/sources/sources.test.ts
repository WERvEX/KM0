import { describe, expect, it } from "vitest";
import { parseFlatYamlList } from "./aider";
import { jsonAfter, nextFlight } from "./common";
import { parseOpenRouter } from "./openrouter";
import { parseSwePro, splitLabel } from "./swepro";
import { parseSweRebench } from "./swerebench";

describe("page data helpers", () => {
  it("joins a Next.js flight payload and reads JSON out of it", () => {
    const html = `<script>self.__next_f.push([1,"a:{\\"rows\\":[{\\"x\\":\\"}\\"},"])</script><script>self.__next_f.push([1,"{\\"x\\":2}]}"])</script>`;
    const flight = nextFlight(html);
    expect(flight).toBe('a:{"rows":[{"x":"}"},{"x":2}]}');
    expect(jsonAfter(flight, '"rows":')).toEqual([{ x: "}" }, { x: 2 }]);
  });

  it("reads Aider's flat YAML list", () => {
    const yaml = "- dirname: one\n  model: gpt-5 (high)\n  pass_rate_2: 88.0\n- dirname: two\n  model: 'o3'\n";
    expect(parseFlatYamlList(yaml)).toEqual([
      { dirname: "one", model: "gpt-5 (high)", pass_rate_2: "88.0" },
      { dirname: "two", model: "o3" },
    ]);
  });
});

describe("source parsers", () => {
  it("splits SWE-Bench Pro labels into model, agent and effort", () => {
    expect(splitLabel("Opus 5 (Claude Code) xhigh")).toEqual({
      model: "Opus 5",
      agent: "Claude Code",
      effort: "xhigh",
    });
    expect(splitLabel("Muse Spark 1.1*")).toEqual({ model: "Muse Spark 1.1", agent: null, effort: null });
    const parsed = parseSwePro({
      fetchedAt: "2026-10-26T00:00:00Z",
      entries: [
        { variant: "hard", label: "GLM-5.3 (mini-swe-agent) max", score: 84.3, ci: 0, company: "zai", date: null },
      ],
    });
    expect(parsed.entries).toEqual([
      {
        model: "GLM-5.3",
        agent: "mini-swe-agent",
        column: "swe_pro_hard",
        value: 84.3,
        se: null,
        effort: "max",
        date: null,
      },
    ]);
  });

  it("keeps SWE-rebench model runs only, overall and for TypeScript", () => {
    const item = (kind: string) => ({
      model: "Opus 5 [high]",
      developer: "anthropic",
      kind,
      release: "2026-07-24",
      windowFrom: "2026-05-15",
      windowTo: "2026-07-01",
      rates: { all: { rate: 63.4, sem: 1.4 }, typescript: { rate: 55, sem: 3 }, go: { rate: 70, sem: 4 } },
    });
    const parsed = parseSweRebench({
      fetchedAt: "x",
      items: [item("model:tools"), item("agent:tools"), item("model:text")],
    });
    expect(parsed.entries.map((e) => [e.column, e.value])).toEqual([
      ["swe_rebench", 63.4],
      ["swe_rebench_ts", 55],
    ]);
  });

  it("turns OpenRouter's benchmark fields into index and frontend rating entries", () => {
    const parsed = parseOpenRouter({
      fetchedAt: "x",
      models: [
        {
          id: "a/model",
          name: "A: Model",
          created: 1_790_000_000,
          contextLength: 1000,
          pricing: { prompt: 0.000001, completion: 0.000002, cacheRead: null },
          aa: { intelligence: 50, coding: null, agentic: 40 },
          designArena: [
            { arena: "models", category: "website", elo: 1300 },
            { arena: "agents", category: "webapps", elo: 1200 },
          ],
        },
      ],
    });
    expect(parsed.entries.map((e) => [e.column, e.value])).toEqual([
      ["aa_intelligence", 50],
      ["aa_agentic", 40],
      ["design_arena_frontend", 1250],
    ]);
  });
});

import type { Decision } from "@km0/shared";
import { describe, expect, it, vi } from "vitest";
import { createSimulatedLlm } from "../discussion/simulator";
import { bochaSearch, parseBochaPages, parseMcpContent, type SearchPort } from "./search";
import { evidenceBlock, type ResearchContext, researchTech } from "./verify";

const ctx: ResearchContext = {
  language: "zh-CN",
  description: "做一个团队记账网站",
  decisions: [] as Decision[],
  targetKeys: ["frontend", "backend", "storage", "deployment"],
  repoSummary: null,
};

function fakeLlm(queries: string[]) {
  return {
    structured: vi.fn(async (_role: unknown, call: { schema: { parse: (value: unknown) => unknown } }) =>
      call.schema.parse({ queries }),
    ),
  } as never;
}

function port(results: (query: string) => Promise<{ title: string; url: string; snippet: string }[]>): SearchPort & {
  calls: string[];
  closed: boolean;
} {
  const state = {
    name: "Test search",
    calls: [] as string[],
    closed: false,
    async search(query: string) {
      state.calls.push(query);
      return results(query);
    },
    async close() {
      state.closed = true;
    },
  };
  return state;
}

describe("researchTech", () => {
  it("is unverified without a search service and calls no model", async () => {
    const llm = fakeLlm(["x"]);
    await expect(researchTech(llm, null, ctx)).resolves.toEqual({ status: "unverified", service: null, findings: [] });
    expect((llm as { structured: ReturnType<typeof vi.fn> }).structured).not.toHaveBeenCalled();
  });

  it("runs at most three searches and closes the connection", async () => {
    const search = port(async (query) => [{ title: query, url: `https://example.com/${query}`, snippet: "ok" }]);
    const result = await researchTech(fakeLlm(["q1", "q2", "q3"]), search, ctx);
    expect(search.calls).toEqual(["q1", "q2", "q3"]);
    expect(search.closed).toBe(true);
    expect(result).toMatchObject({ status: "verified", service: "Test search" });
    expect(result.findings).toHaveLength(3);
  });

  it("records failing searches without throwing", async () => {
    const search = port(async () => {
      throw new Error("quota exceeded");
    });
    const result = await researchTech(fakeLlm(["q1"]), search, ctx);
    expect(result).toEqual({
      status: "failed",
      service: "Test search",
      findings: [{ query: "q1", results: [], error: "quota exceeded" }],
    });
  });

  it("works with the simulated model", async () => {
    const search = port(async () => [{ title: "t", url: "https://e.com", snippet: "s" }]);
    const result = await researchTech(createSimulatedLlm(), search, ctx);
    expect(search.calls.length).toBeGreaterThan(0);
    expect(result.status).toBe("verified");
  });
});

describe("evidenceBlock", () => {
  it("lists results for the prompt and says when nothing was checked", () => {
    expect(evidenceBlock(null)).toBe("");
    expect(evidenceBlock({ status: "unverified", service: null, findings: [] })).toContain("no search service");
    const text = evidenceBlock({
      status: "verified",
      service: "Bocha",
      findings: [
        { query: "react 19", results: [{ title: "React", url: "https://react.dev", snippet: "v19" }], error: null },
      ],
    });
    expect(text).toContain('Search "react 19"');
    expect(text).toContain("React (https://react.dev): v19");
  });
});

describe("search result parsing", () => {
  it("reads Bocha pages, preferring the summary", () => {
    expect(
      parseBochaPages([
        { name: "Vite", url: "https://vite.dev", snippet: "short", summary: "longer summary" },
        { name: "no url" },
      ]),
    ).toEqual([{ title: "Vite", url: "https://vite.dev", snippet: "longer summary" }]);
  });

  it("calls the Bocha API with the key", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { webPages: { value: [{ name: "A", url: "https://a.dev", snippet: "x" }] } } }),
        ),
    );
    const results = await bochaSearch("sk-test", { fetch: fetch as never }).search("vite");
    expect(results).toEqual([{ title: "A", url: "https://a.dev", snippet: "x" }]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.bochaai.com/v1/web-search");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-test" });
    expect(JSON.parse(String(init.body))).toMatchObject({ query: "vite" });
  });

  it("reports a rejected Bocha key as a configuration problem", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(bochaSearch("bad", { fetch: fetch as never }).search("x")).rejects.toMatchObject({ kind: "config" });
  });

  it("understands MCP results as JSON, JSON per block, or plain text", () => {
    const json = [
      { type: "text", text: JSON.stringify({ results: [{ title: "T", url: "https://t.dev", content: "c" }] }) },
    ];
    expect(parseMcpContent(json)).toEqual([{ title: "T", url: "https://t.dev", snippet: "c" }]);
    const text = [{ type: "text", text: "See https://docs.dev/page for details" }];
    expect(parseMcpContent(text)).toEqual([
      {
        title: "https://docs.dev/page",
        url: "https://docs.dev/page",
        snippet: "See https://docs.dev/page for details",
      },
    ]);
    expect(parseMcpContent([{ type: "text", text: "No links here" }])).toEqual([
      { title: "No links here", url: "", snippet: "No links here" },
    ]);
    expect(parseMcpContent([{ type: "image", data: "" }])).toEqual([]);
  });
});

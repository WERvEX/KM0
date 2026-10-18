import { type Decision, MAX_RESEARCH_CALLS, type Research, type ResearchFinding } from "@km0/shared";
import { z } from "zod";
import type { DiscussionLlm } from "../discussion/engine";
import { type Language, languageRule } from "../discussion/prompts";
import type { SearchPort } from "./search";

export const ResearchQueries = z.object({
  queries: z.array(z.string().trim().min(2).max(200)).max(MAX_RESEARCH_CALLS),
});

export interface ResearchContext {
  language: Language;
  description: string;
  decisions: Decision[];
  /** Technology keys still to settle. */
  targetKeys: string[];
  repoSummary: string | null;
}

/**
 * Look things up before the technology questions are written: the router model picks at most
 * three queries, each runs once. Without a search service nothing is called and the stage is
 * marked "unverified". A failing search never blocks the discussion.
 */
export async function researchTech(
  llm: DiscussionLlm,
  port: SearchPort | null,
  ctx: ResearchContext,
): Promise<Research> {
  if (!port) return { status: "unverified", service: null, findings: [] };
  const output = await llm.structured("router", {
    purpose: "research.queries",
    name: "research_queries",
    description: "Web searches that would check the technology choices for this task",
    system: researchSystem(ctx.language),
    prompt: researchPrompt(ctx),
    schema: ResearchQueries,
    maxTokens: 400,
    effort: "low",
  });
  const queries = [...new Set(output.queries.map((query) => query.trim()))].slice(0, MAX_RESEARCH_CALLS);
  const findings: ResearchFinding[] = [];
  try {
    for (const query of queries) {
      try {
        const results = (await port.search(query)).slice(0, 5);
        findings.push({ query, results, error: null });
      } catch (error) {
        findings.push({ query, results: [], error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    await port.close?.().catch(() => undefined);
  }
  const anyResults = findings.some((finding) => finding.results.length > 0);
  return { status: anyResults ? "verified" : "failed", service: port.name, findings };
}

function researchSystem(language: Language): string {
  return [
    "You are KM0's research step. Before the user is asked to choose technologies, you pick web searches that check the options are current: latest stable versions, whether a library is maintained, known limits, pricing or platform support.",
    `Return at most ${MAX_RESEARCH_CALLS} short search queries, the ones most likely to change a recommendation. Name concrete technologies. Return none if nothing needs checking.`,
    languageRule(language),
  ].join("\n");
}

function researchPrompt(ctx: ResearchContext): string {
  const decided = ctx.decisions.map((decision) => `- ${decision.key}: ${decision.value.text}`).join("\n");
  return [
    `Task description:\n${ctx.description}`,
    ctx.repoSummary ? `Existing codebase:\n${ctx.repoSummary}` : "",
    `Decisions so far:\n${decided || "(none yet)"}`,
    `Technology keys to settle: ${ctx.targetKeys.join(", ") || "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The evidence block given to the question and fill prompts. */
export function evidenceBlock(research: Research | null | undefined): string {
  if (!research) return "";
  if (research.status === "unverified") {
    return "Research: no search service is configured. Recommend from your own knowledge and say so in a description when a version or status may be out of date.";
  }
  const lines = research.findings.flatMap((finding) => [
    `Search "${finding.query}":${finding.error ? ` failed (${finding.error})` : finding.results.length === 0 ? " no results" : ""}`,
    ...finding.results.map((result) => `  - ${result.title} (${result.url}): ${result.snippet}`),
  ]);
  return [
    "Research results (web search, may be incomplete). Prefer them over your memory for versions, maintenance status and limits; mention the source in an option description when it shaped a recommendation:",
    ...lines,
  ].join("\n");
}

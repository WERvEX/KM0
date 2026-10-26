import { describe, expect, it } from "vitest";
import { createMatcher, looseKey, nameWords } from "./model-names";

const catalog = [
  { id: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5" },
  { id: "anthropic/claude-opus-4.5", name: "Anthropic: Claude Opus 4.5" },
  { id: "anthropic/claude-haiku-4.5", name: "Anthropic: Claude Haiku 4.5" },
  { id: "openai/gpt-5.4", name: "OpenAI: GPT-5.4" },
  { id: "openai/gpt-5.1-codex", name: "OpenAI: GPT-5.1-Codex" },
  { id: "openai/gpt-5.1-codex-max", name: "OpenAI: GPT-5.1-Codex-Max" },
  { id: "openai/o4-mini", name: "OpenAI: o4 Mini" },
  { id: "openai/o4-mini-high", name: "OpenAI: o4 Mini High" },
  { id: "openai/gpt-4o", name: "OpenAI: GPT-4o" },
  { id: "openai/gpt-4o-2024-08-06", name: "OpenAI: GPT-4o (2024-08-06)" },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek: DeepSeek V4 Pro" },
  { id: "moonshotai/kimi-k2-0905", name: "MoonshotAI: Kimi K2 0905" },
  { id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3" },
];

describe("nameWords", () => {
  it("drops vendor prefixes, notes in brackets and the vendor's product word", () => {
    expect(nameWords("anthropic/claude-opus-5.5")).toEqual(["opus", "5.5"]);
    expect(nameWords("MoonshotAI: Kimi K3.1 Pro")).toEqual(["kimi", "k3.1", "pro"]);
    expect(nameWords("Opus 5 (Claude Code) xhigh")).toEqual(["opus", "5", "xhigh"]);
  });

  it("reads dashed versions and keeps dates apart from them", () => {
    expect(nameWords("claude-opus-4-5")).toEqual(["opus", "4.5"]);
    expect(nameWords("claude-haiku-4-5-20251001")).toEqual(["haiku", "4.5", "d20251001"]);
    expect(nameWords("claude-haiku-4-5-20251001", { dates: true })).toEqual(["haiku", "4.5"]);
    expect(nameWords("gpt-5.4-2026-03-05-medium", { dates: true, efforts: true })).toEqual(["gpt", "5.4"]);
  });

  it("names a Hugging Face link by its last segment", () => {
    expect(nameWords("https://huggingface.co/zai-org/GLM-4.6")).toEqual(["glm", "4.6"]);
  });

  it("gives one loose key to spellings of the same model", () => {
    expect(looseKey("Claude Sonnet 4")).toBe("sonnet 4");
    expect(looseKey("claude-sonnet-4-20250514 (no thinking)")).toBe("sonnet 4");
  });
});

describe("createMatcher", () => {
  const matcher = createMatcher(catalog, {
    "minimax-2.5": "minimax/minimax-m2.5",
    "Opus Five": "anthropic/claude-opus-5.5",
  });
  const id = (raw: string) => {
    const result = matcher.match(raw);
    return "id" in result ? result.id : result.problem;
  };

  it("matches the spellings leaderboards use", () => {
    expect(id("Opus 5.5")).toBe("anthropic/claude-opus-5.5");
    expect(id("Claude 4.5 Opus")).toBe("anthropic/claude-opus-4.5");
    expect(id("claude-opus-4-5-20251101")).toBe("anthropic/claude-opus-4.5");
    expect(id("Claude Haiku 4.5 (high)")).toBe("anthropic/claude-haiku-4.5");
    expect(id("gpt-5.4-2026-03-05-medium")).toBe("openai/gpt-5.4");
    expect(id("DeepSeek-V4 Pro [high]")).toBe("deepseek/deepseek-v4-pro");
    expect(id("Kimi K2 Instruct 0905")).toBe("moonshotai/kimi-k2-0905");
    expect(id("GLM-5.3")).toBe("z-ai/glm-5.3");
  });

  it("keeps models apart whose names differ by a word leaderboards also use for effort", () => {
    expect(id("gpt-5.1-codex")).toBe("openai/gpt-5.1-codex");
    expect(id("gpt-5.1-codex-max")).toBe("openai/gpt-5.1-codex-max");
    expect(id("o4-mini (high)")).toBe("openai/o4-mini");
    expect(id("gpt-4o-2024-08-06")).toBe("openai/gpt-4o-2024-08-06");
  });

  it("uses the alias table, in any spelling, and never guesses", () => {
    expect(id("Opus five")).toBe("anthropic/claude-opus-5.5");
    expect(matcher.match("minimax-2.5")).toEqual({ problem: "unmatched", candidates: ["minimax/minimax-m2.5"] });
    expect(id("Opus 5.6")).toBe("unmatched");
    expect(id("Gemini 9 Ultra")).toBe("unmatched");
  });

  it("reports a name that fits several models", () => {
    const loose = createMatcher(
      [
        { id: "a/gpt-9", name: "GPT 9" },
        { id: "b/gpt-9", name: "GPT 9" },
      ],
      {},
    );
    expect(loose.match("gpt-9")).toEqual({ problem: "ambiguous", candidates: ["a/gpt-9", "b/gpt-9"] });
  });
});

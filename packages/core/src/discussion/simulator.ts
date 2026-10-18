import type { z } from "zod";
import type { DiscussionLlm } from "./engine";

/**
 * A deterministic stand-in for the model, used by tests and by `KM0_FAKE_LLM=1` end-to-end runs.
 * It reads the keys listed in the prompt and answers with plausible, fixed structures.
 */
export function createSimulatedLlm(): DiscussionLlm {
  return {
    async structured<S extends z.ZodType>(_role: unknown, call: { purpose: string; prompt: string; schema: S }) {
      return call.schema.parse(simulate(call.purpose, call.prompt));
    },
  } as DiscussionLlm;
}

function listedKeys(prompt: string, heading: string): string[] {
  const start = prompt.indexOf(heading);
  if (start === -1) return [];
  const keys: string[] = [];
  for (const line of prompt
    .slice(start + heading.length)
    .split("\n")
    .slice(1)) {
    const match = /^- ([a-z_]+)/.exec(line);
    if (!match) break;
    keys.push(match[1] as string);
  }
  return keys;
}

function simulate(purpose: string, prompt: string): unknown {
  if (purpose === "triage") {
    const text = prompt.toLowerCase();
    const small = /修复|错别字|typo|fix|改个|按钮/.test(text);
    const big = /新项目|从零|平台|系统|new app|platform/.test(text);
    return {
      title: prompt.trim().slice(0, 20),
      task_type: small ? "bugfix" : big ? "new_project" : "feature",
      complexity: small ? "S" : big ? "L" : "M",
      has_codebase: !big,
      summary: prompt.trim().slice(0, 60),
      reasons: [small ? "改动集中在一处" : big ? "需要从零搭建多个模块" : "涉及几个文件的功能改动"],
    };
  }
  if (purpose.startsWith("questions.")) {
    const keys = listedKeys(prompt, "Keys to settle now:").slice(0, 3);
    return {
      inferred: [],
      questions: keys.map((key) => ({
        key,
        prompt: `关于「${key}」，你倾向哪种方案？`,
        type: "single",
        options: [
          { label: `${key} 方案 A`, description: "最简单，适合起步", recommended: true },
          { label: `${key} 方案 B`, description: "更灵活，成本更高" },
          { label: `${key} 方案 C`, description: "适合大规模场景" },
        ],
        allow_custom: true,
      })),
    };
  }
  if (purpose.startsWith("fill.")) {
    return {
      decisions: listedKeys(prompt, "Keys to decide:").map((key) => ({
        key,
        value: `${key}（AI 决定）`,
        rationale: "按当前决策选择最简单可行的方案",
      })),
    };
  }
  throw new Error(`The simulated model has no answer for ${purpose}`);
}

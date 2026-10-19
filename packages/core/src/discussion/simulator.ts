import { SECTION_MARKER } from "@km0/shared";
import type { z } from "zod";
import type { DocumentLlm } from "../documents/engine";

export interface SimulatedLlmOptions {
  /** Pause between streamed pieces, so the UI shows a document arriving. */
  streamDelayMs?: number;
}

/**
 * A deterministic stand-in for the model, used by tests and by `KM0_FAKE_LLM=1` end-to-end runs.
 * It reads the keys listed in the prompt and answers with plausible, fixed structures.
 */
export function createSimulatedLlm(options: SimulatedLlmOptions = {}): DocumentLlm {
  const delay = options.streamDelayMs ?? 0;
  return {
    async structured<S extends z.ZodType>(_role: unknown, call: { purpose: string; prompt: string; schema: S }) {
      return call.schema.parse(simulate(call.purpose, call.prompt));
    },
    async stream(_role: unknown, call: { purpose: string; prompt: string }, onDelta: (text: string) => void) {
      const text = simulateDocument(call.prompt);
      for (const piece of text.match(/[\s\S]{1,60}/g) ?? []) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        onDelta(piece);
      }
      return text;
    },
  } as DocumentLlm;
}

/** One marker-delimited body per listed section, quoting the instruction of a revision. */
function simulateDocument(prompt: string): string {
  const revising = prompt.includes("Sections to rewrite:");
  const ids = listedKeys(prompt, revising ? "Sections to rewrite:" : "Sections, in order:");
  const instruction = /^Instruction: (.*)$/m.exec(prompt)?.[1] ?? "";
  const ledger = listedLines(prompt, "Decision ledger:").slice(0, 3);
  return ids
    .map((id) => {
      const lines = [`${SECTION_MARKER}${id}`, `（模拟）本节「${id}」根据决策账本生成。`, ""];
      if (revising) lines.push(`已按要求修订：${instruction}`, "");
      lines.push(...ledger.map((line) => line.replace(/ \[.*\]$/, "")));
      lines.push("", "- 当用户提交表单时，系统应当保存内容并提示成功。");
      return lines.join("\n");
    })
    .join("\n\n");
}

function listedLines(prompt: string, heading: string): string[] {
  const start = prompt.indexOf(heading);
  if (start === -1) return [];
  const lines: string[] = [];
  for (const line of prompt
    .slice(start + heading.length)
    .split("\n")
    .slice(1)) {
    if (!line.startsWith("- ")) break;
    lines.push(line);
  }
  return lines;
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
    // A linked repository's summary follows the description; the title comes from the description alone.
    const description = prompt.trim().split("\n")[0] ?? "";
    const text = prompt.toLowerCase();
    const small = /修复|错别字|typo|fix|改个|按钮/.test(text);
    const big = /新项目|从零|平台|系统|new app|platform/.test(text);
    return {
      title: description.slice(0, 20),
      task_type: small ? "bugfix" : big ? "new_project" : "feature",
      complexity: small ? "S" : big ? "L" : "M",
      has_codebase: !big,
      summary: description.slice(0, 60),
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
  if (purpose === "research.queries") {
    const keys = /^Technology keys to settle: (.*)$/m.exec(prompt)?.[1] ?? "";
    return {
      queries: keys
        .split(", ")
        .filter((key) => key && key !== "(none)")
        .slice(0, 2)
        .map((key) => `${key} 选型 最新稳定版本`),
    };
  }
  if (purpose === "breakdown") return simulateBreakdown(prompt);
  if (purpose === "acceptance") {
    // Accept a change whose tests passed; reject an empty one or one whose tests failed.
    if (prompt.includes("(no changes)")) return { accepted: false, reason: "（模拟）没有任何改动。" };
    if (/^Test run:\nFailed/m.test(prompt)) return { accepted: false, reason: "（模拟）测试没有通过。" };
    return { accepted: true, reason: "（模拟）改动满足验收标准。" };
  }
  throw new Error(`The simulated model has no answer for ${purpose}`);
}

/** One small task on the fast path; otherwise three tasks that land on T1, T2 and T3. */
function simulateBreakdown(prompt: string): unknown {
  const features = (overrides: Record<string, unknown>) => ({
    scope: "single_file",
    ambiguity: "low",
    reasoning: "follow",
    context: "small",
    has_tests: false,
    risks: [],
    kind: "code",
    ...overrides,
  });
  const acceptance = ["当用户完成操作时，系统应当保存结果并提示成功。"];
  if (/^Path: fast$/m.test(prompt)) {
    return {
      tasks: [
        {
          title: "按确认的范围完成改动",
          goal: "（模拟）按决策账本中的范围完成改动。",
          acceptance,
          features: features({}),
        },
      ],
    };
  }
  return {
    tasks: [
      {
        title: "搭建项目骨架与说明文档",
        goal: "（模拟）初始化目录结构、依赖和 README。",
        acceptance,
        files: ["README.md", "package.json"],
        sections: ["tech_design.modules", "brief.approach"],
        features: features({ scope: "few_files", kind: "boilerplate" }),
      },
      {
        title: "实现核心功能",
        goal: "（模拟）实现 MVP 的主要功能。",
        acceptance,
        files: ["src/features/**"],
        depends_on: [1],
        sections: ["prd.functional", "brief.scope"],
        features: features({ scope: "few_files", ambiguity: "medium", reasoning: "judgement" }),
      },
      {
        title: "设计数据模型与权限",
        goal: "（模拟）设计数据表、迁移和访问控制。",
        acceptance,
        files: ["src/db/**", "src/auth/**"],
        depends_on: [1, 2],
        sections: ["tech_design.data_model", "tech_design.security"],
        features: features({ scope: "new_subsystem", reasoning: "design", context: "large", risks: ["security"] }),
      },
    ],
  };
}

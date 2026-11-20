import { readFile } from "node:fs/promises";

/**
 * Structured hand-off summary produced when a direct-run task settles, and delivered to downstream tasks
 * (both in `km0/upstream.md` inside their worktree and in their prompt header) so different agents and models
 * stay aligned on changed files, exported contracts and caveats.
 */
export interface TaskHandoffNote {
  version: 1;
  task_id: string;
  seq: number;
  title: string;
  agent: string;
  model: string | null;
  branch: string;
  commit: string | null;
  changed_files: string[];
  summary: string;
  contracts: string[];
  notes_for_downstream: string;
  verdict: { accepted: boolean; reason: string } | null;
  created_at: string;
}

const MAX_CONTRACTS = 20;
const MAX_FILES = 30;
const MAX_SUMMARY = 1200;
const MAX_NOTES = 1200;

/**
 * Pulls added public interfaces, exports, functions, classes, types and SQL tables out of a unified diff.
 * Deterministic and works with zero LLM calls, so downstream agents see concrete symbol names even when the
 * upstream agent only wrote a brief summary.
 */
export function extractContractsFromDiff(diff: string | null): string[] {
  if (!diff) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  let currentFile = "";

  const push = (entry: string) => {
    const clean = entry.replace(/\s+/g, " ").trim().slice(0, 140);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    found.push(clean);
  };

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(line);
      currentFile = match?.[1] ?? "";
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const code = line.slice(1).trim();
    if (!code || code.startsWith("//") || code.startsWith("#") || code.startsWith("*")) continue;

    // TypeScript / JavaScript exports
    const tsExport =
      /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let)\s+([A-Za-z_$][\w$]*)(?:\s*<[^>{}\n]*>)?(?:\s*\([^)\n]*\))?/.exec(
        code,
      );
    if (tsExport) {
      push(currentFile ? `${currentFile}: ${tsExport[0]}` : tsExport[0]);
      if (found.length >= MAX_CONTRACTS) break;
      continue;
    }

    // Python top-level functions and classes (unindented in source -> right after '+')
    if (!line.startsWith("+ ") && !line.startsWith("+\t")) {
      const pyDecl = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_][\w]*)(?:\([^)\n]*\))?/.exec(code);
      if (pyDecl && !pyDecl[1]?.startsWith("_")) {
        push(currentFile ? `${currentFile}: ${pyDecl[0]}` : pyDecl[0]);
        if (found.length >= MAX_CONTRACTS) break;
        continue;
      }
    }

    // Go exported functions and types (capitalized identifier)
    const goDecl =
      /^func\s+(?:\([^)]*\)\s+)?([A-Z][\w]*)\s*\([^)\n]*\)|^type\s+([A-Z][\w]*)\s+(?:struct|interface)\b/.exec(code);
    if (goDecl) {
      push(currentFile ? `${currentFile}: ${goDecl[0]}` : goDecl[0]);
      if (found.length >= MAX_CONTRACTS) break;
      continue;
    }

    // Rust pub declarations
    const rustDecl = /^pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_][\w]*)/.exec(code);
    if (rustDecl) {
      push(currentFile ? `${currentFile}: ${rustDecl[0]}` : rustDecl[0]);
      if (found.length >= MAX_CONTRACTS) break;
      continue;
    }

    // SQL DDL
    const sqlDecl = /^(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE)\s+["`[]?([A-Za-z_][\w.]*)["`\]]?/i.exec(
      code,
    );
    if (sqlDecl) {
      push(currentFile ? `${currentFile}: ${sqlDecl[0]}` : sqlDecl[0]);
      if (found.length >= MAX_CONTRACTS) break;
    }
  }
  return found;
}

/**
 * Optionally extracts a structured JSON handoff block (`\`\`\`km0-handoff ... \`\`\``) from a CLI agent's final
 * message; falls back cleanly to plain summary text when the agent did not emit one.
 */
export function parseAgentHandoff(text: string): { summary: string; contracts: string[]; notes: string } {
  const trimmed = text.trim();
  if (!trimmed) return { summary: "", contracts: [], notes: "" };
  const fence = /```km0-handoff\s*\r?\n([\s\S]*?)\r?\n```/.exec(trimmed);
  if (fence?.[1]) {
    try {
      const parsed = JSON.parse(fence[1]) as {
        summary?: unknown;
        contracts?: unknown;
        notes_for_downstream?: unknown;
        downstream_notes?: unknown;
      };
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, MAX_SUMMARY) : "";
      const contracts = Array.isArray(parsed.contracts)
        ? parsed.contracts
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            .map((s) => s.trim())
        : [];
      const rawNotes = parsed.notes_for_downstream ?? parsed.downstream_notes;
      const notes = typeof rawNotes === "string" ? rawNotes.trim().slice(0, MAX_NOTES) : "";
      if (summary || contracts.length > 0 || notes) {
        return { summary: summary || trimmed.replace(fence[0], "").trim().slice(0, MAX_SUMMARY), contracts, notes };
      }
    } catch {
      // Malformed JSON block: treat the whole message as a plain summary.
    }
  }
  return { summary: trimmed.slice(0, MAX_SUMMARY), contracts: [], notes: "" };
}

export interface BuildHandoffInput {
  taskId: string;
  seq: number;
  title: string;
  agent: string;
  model: string | null;
  branch: string;
  commit: string | null;
  changedFiles: string[];
  diff: string | null;
  agentText: string;
  explicitContracts?: string[];
  explicitNotes?: string;
  verdict?: { accepted: boolean; reason: string } | null;
  now?: string;
}

export function buildHandoffNote(input: BuildHandoffInput): TaskHandoffNote {
  const parsed = parseAgentHandoff(input.agentText);
  const contracts: string[] = [];
  const seen = new Set<string>();
  for (const item of [
    ...(input.explicitContracts ?? []),
    ...parsed.contracts,
    ...extractContractsFromDiff(input.diff),
  ]) {
    const clean = item.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    contracts.push(clean);
    if (contracts.length >= MAX_CONTRACTS) break;
  }
  const changedFiles = [...new Set(input.changedFiles.map((file) => file.trim()).filter(Boolean))].slice(0, MAX_FILES);
  const notes = (input.explicitNotes?.trim() || parsed.notes).slice(0, MAX_NOTES);
  const summary =
    parsed.summary ||
    (changedFiles.length > 0 ? `Changed ${changedFiles.join(", ")}.` : "Completed without file changes.");
  return {
    version: 1,
    task_id: input.taskId,
    seq: input.seq,
    title: input.title,
    agent: input.agent,
    model: input.model,
    branch: input.branch,
    commit: input.commit,
    changed_files: changedFiles,
    summary,
    contracts,
    notes_for_downstream: notes,
    verdict: input.verdict ?? null,
    created_at: input.now ?? new Date().toISOString(),
  };
}

export async function readHandoffNote(path: string): Promise<TaskHandoffNote | null> {
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as TaskHandoffNote;
    return data.version === 1 && typeof data.task_id === "string" ? data : null;
  } catch {
    return null;
  }
}

/** Markdown saved as `km0/upstream.md` in a downstream task's worktree. */
export function formatUpstreamMarkdown(notes: TaskHandoffNote[], language: "zh-CN" | "en"): string {
  if (notes.length === 0) return "";
  const zh = language === "zh-CN";
  const header = zh
    ? "# 上游任务交接上下文\n\n以下上游任务的改动已经合并到当前工作分支。请直接复用它们导出的接口与文件，避免重复实现或破坏契约。"
    : "# Upstream Task Hand-Off Context\n\nThe changes from these upstream tasks are already merged into your current branch. Reuse their interfaces and files directly without breaking their contracts.";
  const sections = notes.map((note) => {
    const who = [note.agent, note.model].filter(Boolean).join(" / ");
    const lines = [
      `## ${note.task_id} ${note.title}`,
      zh ? `- 执行方：${who}（分支 \`${note.branch}\`）` : `- Executed by: ${who} (branch \`${note.branch}\`)`,
      note.summary ? (zh ? `- 完成摘要：${note.summary}` : `- Summary: ${note.summary}`) : null,
      note.changed_files.length > 0
        ? zh
          ? `- 改动文件：${note.changed_files.map((file) => `\`${file}\``).join("、")}`
          : `- Changed files: ${note.changed_files.map((file) => `\`${file}\``).join(", ")}`
        : null,
      note.contracts.length > 0
        ? [
            zh ? "- 导出接口与契约：" : "- Exported interfaces & contracts:",
            ...note.contracts.map((item) => `  - \`${item}\``),
          ].join("\n")
        : null,
      note.notes_for_downstream
        ? zh
          ? `- 给下游的注意事项：${note.notes_for_downstream}`
          : `- Notes for downstream: ${note.notes_for_downstream}`
        : null,
      note.verdict
        ? zh
          ? `- 验收结果：${note.verdict.accepted ? "通过" : "未通过"}（${note.verdict.reason}）`
          : `- Acceptance: ${note.verdict.accepted ? "accepted" : "rejected"} (${note.verdict.reason})`
        : null,
    ];
    return lines.filter((line): line is string => line !== null).join("\n");
  });
  return `${header}\n\n${sections.join("\n\n")}\n`;
}

/** Compact block prepended to the downstream agent's prompt so it sees upstream context immediately. */
export function formatUpstreamPromptBlock(notes: TaskHandoffNote[], language: "zh-CN" | "en"): string {
  if (notes.length === 0) return "";
  const zh = language === "zh-CN";
  const title = zh
    ? "## 上游任务交接备忘（已合并到当前分支，完整版见 `km0/upstream.md`）"
    : "## Upstream task hand-off (already merged into this branch; full notes in `km0/upstream.md`)";
  const items = notes.map((note) => {
    const parts = [
      `### ${note.task_id} ${note.title} (${[note.agent, note.model].filter(Boolean).join(" / ")})`,
      note.summary,
      note.changed_files.length > 0
        ? `${zh ? "改动文件" : "Files"}: ${note.changed_files.slice(0, 12).join(", ")}`
        : null,
      note.contracts.length > 0
        ? `${zh ? "接口/契约" : "Contracts"}:\n${note.contracts
            .slice(0, 10)
            .map((c) => `- \`${c}\``)
            .join("\n")}`
        : null,
      note.notes_for_downstream ? `${zh ? "注意事项" : "Downstream notes"}: ${note.notes_for_downstream}` : null,
    ];
    return parts.filter(Boolean).join("\n");
  });
  return `${title}\n\n${items.join("\n\n")}`;
}

import { breakDown, type DiscussionLlm, judgeTask } from "@km0/core";
import type { Decision } from "@km0/shared";
import type { BreakdownCase, EvalSet, JudgeCase } from "./cases";

export interface BreakdownResult {
  id: string;
  tasks: number;
  kept: string[];
  lost: { id: string; text: string }[];
  error: string | null;
}

export interface JudgeResult {
  id: string;
  hidden: boolean;
  accepted: boolean | null;
  agree: boolean | null;
  reason: string;
  error: string | null;
}

export interface EvalResult {
  breakdown: BreakdownResult[];
  judge: JudgeResult[];
  metrics: {
    criteria: number;
    kept: number;
    /** Share of stated criteria that reached some task; null when no case ran. */
    retention: number | null;
    casesComplete: number;
    verdicts: number;
    agreement: number | null;
    /** Accepted by the hidden tests, rejected by KM0: the error that wastes a stronger model's run. */
    falseRejects: number;
    /** Rejected by the hidden tests, accepted by KM0: the error that lets a broken change through. */
    falseAccepts: number;
    errors: number;
  };
}

/** Lower case, full-width folded, spaces collapsed: wording differences that do not change meaning. */
export const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");

/** Whether one task criterion states the case's criterion: every word of one alternative appears in it. */
export function keeps(criteria: string[], match: string[][]): boolean {
  const lines = criteria.map(normalize);
  return match.some((words) => lines.some((line) => words.every((word) => line.includes(normalize(word)))));
}

function decision(partial: BreakdownCase["decisions"][number]): Decision {
  return {
    stage: "scope",
    source: "user",
    rationale: null,
    alternatives: [],
    dependsOn: [],
    needsReview: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  } as Decision;
}

export async function runBreakdown(llm: DiscussionLlm, item: BreakdownCase): Promise<BreakdownResult> {
  try {
    const tasks = await breakDown(llm, {
      language: item.language,
      path: item.path,
      title: item.title,
      description: item.description,
      triage: null,
      decisions: item.decisions.map(decision),
      documents: item.documents,
    });
    const all = tasks.flatMap((task) => task.acceptance);
    const kept = item.criteria.filter((criterion) => keeps(all, criterion.match));
    return {
      id: item.id,
      tasks: tasks.length,
      kept: kept.map((criterion) => criterion.id),
      lost: item.criteria.filter((criterion) => !kept.includes(criterion)).map(({ id, text }) => ({ id, text })),
      error: null,
    };
  } catch (error) {
    return { id: item.id, tasks: 0, kept: [], lost: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runJudge(llm: DiscussionLlm, item: JudgeCase): Promise<JudgeResult> {
  try {
    const verdict = await judgeTask(llm, {
      language: item.language,
      title: item.task.title,
      goal: item.task.goal,
      acceptance: item.task.acceptance,
      decisions: item.task.decisions,
      diff: item.diff,
      upstream: item.upstream,
      others: item.others,
      request: item.request,
      testCommand: item.testCommand,
      testResult: item.testResult,
      failure: null,
    });
    return {
      id: item.id,
      hidden: item.hidden.passed,
      accepted: verdict.accepted,
      agree: verdict.accepted === item.hidden.passed,
      reason: verdict.reason,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: item.id, hidden: item.hidden.passed, accepted: null, agree: null, reason: "", error: message };
  }
}

/** Run every case in order; `onCase` hears which one is running, so recordings can name it. */
export async function runEval(set: EvalSet, llm: DiscussionLlm, onCase: (id: string) => void = () => undefined) {
  const breakdown: BreakdownResult[] = [];
  for (const item of set.breakdown) {
    onCase(item.id);
    breakdown.push(await runBreakdown(llm, item));
  }
  const judge: JudgeResult[] = [];
  for (const item of set.judge) {
    onCase(item.id);
    judge.push(await runJudge(llm, item));
  }
  return { breakdown, judge, metrics: metrics(set, breakdown, judge) } satisfies EvalResult;
}

export function metrics(set: EvalSet, breakdown: BreakdownResult[], judge: JudgeResult[]): EvalResult["metrics"] {
  const ran = breakdown.filter((result) => !result.error);
  const criteria = ran.reduce(
    (sum, result) => sum + (set.breakdown.find((item) => item.id === result.id)?.criteria.length ?? 0),
    0,
  );
  const kept = ran.reduce((sum, result) => sum + result.kept.length, 0);
  const verdicts = judge.filter((result) => result.agree !== null);
  return {
    criteria,
    kept,
    retention: criteria > 0 ? kept / criteria : null,
    casesComplete: ran.filter((result) => result.lost.length === 0).length,
    verdicts: verdicts.length,
    agreement: verdicts.length > 0 ? verdicts.filter((result) => result.agree).length / verdicts.length : null,
    falseRejects: verdicts.filter((result) => result.hidden && result.accepted === false).length,
    falseAccepts: verdicts.filter((result) => !result.hidden && result.accepted === true).length,
    errors: [...breakdown, ...judge].filter((result) => result.error).length,
  };
}

const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

/** The report, in Chinese like the registry's. */
export function report(result: EvalResult, label: string): string {
  const m = result.metrics;
  const lines = [
    `# KM0 离线评测 · ${label}`,
    "",
    `- 验收条件保留率：${pct(m.retention)}（${m.kept} / ${m.criteria}），全部保留的用例 ${m.casesComplete} / ${result.breakdown.length}`,
    `- 评审与隐藏测试的一致率：${pct(m.agreement)}（${m.verdicts} 个结论）；误判不通过 ${m.falseRejects}，误判通过 ${m.falseAccepts}`,
    m.errors > 0 ? `- 出错的用例：${m.errors}` : "",
    "",
    "## 拆解",
    "",
    "| 用例 | 任务数 | 保留 | 丢失的条件 |",
    "| --- | --- | --- | --- |",
    ...result.breakdown.map(
      (r) =>
        `| ${r.id} | ${r.tasks} | ${r.kept.length} / ${r.kept.length + r.lost.length} | ${
          r.error ? `出错：${r.error.replaceAll("|", "\\|")}` : r.lost.map((item) => item.text).join("；") || "—"
        } |`,
    ),
    "",
    "## 验收评审",
    "",
    "| 用例 | 隐藏测试 | KM0 结论 | 一致 | 理由 |",
    "| --- | --- | --- | --- | --- |",
    ...result.judge.map(
      (r) =>
        `| ${r.id} | ${r.hidden ? "通过" : "不通过"} | ${r.accepted === null ? "—" : r.accepted ? "通过" : "不通过"} | ${
          r.agree === null ? "—" : r.agree ? "✓" : "✗"
        } | ${(r.error ? `出错：${r.error}` : r.reason).replaceAll("|", "\\|").replaceAll("\n", " ").slice(0, 200)} |`,
    ),
    "",
  ];
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n");
}

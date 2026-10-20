import {
  ESCALATE_AFTER,
  type RoutingRules,
  type TaskFailure,
  type TaskFeatures,
  type TaskRisk,
  type Tier,
} from "@km0/shared";
import type { Language } from "../discussion/prompts";

/** Points per feature value; the sum decides the tier unless a hard rule applies. */
export const FEATURE_POINTS = {
  scope: { single_file: 0, few_files: 1, many_files: 2, new_subsystem: 3 },
  ambiguity: { low: 0, medium: 1, high: 2 },
  reasoning: { follow: 0, judgement: 1, design: 3 },
  context: { small: 0, large: 1 },
  hasTests: { true: 0, false: 1 },
} as const;

/** Highest score that still maps to T1 and to T2. */
export const TIER_LIMITS = { T1: 2, T2: 5 } as const;

/** The rules KM0 ships with; imported calibration results replace them. */
export const DEFAULT_ROUTING_RULES: RoutingRules = { featurePoints: FEATURE_POINTS, tierLimits: TIER_LIMITS };

/** At or above this score a task is worth splitting before it is handed off. */
export const SPLIT_SCORE = 8;

const TIER_ORDER: Tier[] = ["T1", "T2", "T3"];
const atLeast = (tier: Tier, floor: Tier): Tier =>
  TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(floor) ? tier : floor;

export interface TierDecision {
  score: number;
  tier: Tier;
  reasons: string[];
  splitSuggested: boolean;
}

const TEXT = {
  "zh-CN": {
    scope: {
      single_file: "改 1 个文件",
      few_files: "改 2–5 个文件",
      many_files: "改 5 个以上文件",
      new_subsystem: "新建子系统",
    },
    ambiguity: { low: "需求明确", medium: "需求有些模糊", high: "需求很模糊" },
    reasoning: { follow: "照着做", judgement: "需要判断", design: "需要设计决策" },
    context: { small: "上下文少", large: "上下文多" },
    hasTests: { true: "有现成测试", false: "没有现成测试" },
    risks: { data_migration: "数据迁移", security: "安全", production: "生产环境" },
    score: (score: number, tier: Tier) => `总分 ${score} → ${tier}`,
    cheap: "纯文档或样板代码，且不超过 5 个文件 → T1",
    risk: (names: string) => `有风险（${names}）→ 至少 T2`,
    fix: "调试和修复 bug → 至少 T2",
    design: "需要设计决策 → T3",
    lifted: (from: Tier, count: number, to: Tier) => `${from} 已失败 ${count} 次 → 升到 ${to}`,
    human: (count: number) => `T3 也已失败 ${count} 次 → 需要人来决定：拆小、补充说明或手动处理`,
    rejected: (from: Tier, to: Tier) => `KM0 Runner 在 ${from} 完成的改动未通过验收 → 从 ${to} 重新分发`,
    rejectedTop: "KM0 Runner 在 T3 完成的改动也未通过验收 → 需要人来决定：拆小、补充说明或手动处理",
  },
  en: {
    scope: {
      single_file: "one file",
      few_files: "2–5 files",
      many_files: "more than 5 files",
      new_subsystem: "a new subsystem",
    },
    ambiguity: { low: "clear requirements", medium: "somewhat unclear", high: "very unclear" },
    reasoning: { follow: "do as written", judgement: "needs judgement", design: "needs design decisions" },
    context: { small: "little context", large: "lots of context" },
    hasTests: { true: "existing tests", false: "no existing tests" },
    risks: { data_migration: "data migration", security: "security", production: "production" },
    score: (score: number, tier: Tier) => `score ${score} → ${tier}`,
    cheap: "docs or boilerplate in at most 5 files → T1",
    risk: (names: string) => `risky (${names}) → at least T2`,
    fix: "debugging and bug fixing → at least T2",
    design: "needs design decisions → T3",
    lifted: (from: Tier, count: number, to: Tier) => `failed ${count} times on ${from} → ${to}`,
    human: (count: number) =>
      `failed ${count} times on T3 too → a person has to decide: split it, clarify it or do it by hand`,
    rejected: (from: Tier, to: Tier) => `KM0 Runner's change on ${from} failed acceptance → redistribute from ${to}`,
    rejectedTop:
      "KM0 Runner's change on T3 failed acceptance too → a person has to decide: split it, clarify it or do it by hand",
  },
} as const;

/**
 * Deterministic tier for a task. The score picks T1 (0–2), T2 (3–5) or T3 (6+) under the default
 * rules, or under imported calibrated ones; then hard rules
 * apply in this order: docs or boilerplate in at most 5 files → T1; any risk → at least T2;
 * debugging and bug fixing → at least T2; design decisions → T3. Later rules win.
 */
export function decideTier(
  features: TaskFeatures,
  language: Language,
  rules: RoutingRules = DEFAULT_ROUTING_RULES,
): TierDecision {
  const text = TEXT[language];
  const points = rules.featurePoints;
  const limits = rules.tierLimits;
  const tested = String(features.hasTests) as "true" | "false";
  const parts: [string, number][] = [
    [text.scope[features.scope], points.scope[features.scope]],
    [text.ambiguity[features.ambiguity], points.ambiguity[features.ambiguity]],
    [text.reasoning[features.reasoning], points.reasoning[features.reasoning]],
    [text.context[features.context], points.context[features.context]],
    [text.hasTests[tested], points.hasTests[tested]],
  ];
  const score = parts.reduce((sum, [, value]) => sum + value, 0);
  let tier: Tier = score <= limits.T1 ? "T1" : score <= limits.T2 ? "T2" : "T3";
  const [colon, comma] = language === "en" ? [": ", ", "] : ["：", "，"];
  const counted = parts.filter(([, points]) => points > 0).map(([label, points]) => `${label} +${points}`);
  const reasons = [`${text.score(score, tier)}${colon}${counted.join(comma) || "—"}`];

  const small = features.scope === "single_file" || features.scope === "few_files";
  if ((features.kind === "docs" || features.kind === "boilerplate") && small) {
    tier = "T1";
    reasons.push(text.cheap);
  }
  const risks = [...new Set(features.risks)] as TaskRisk[];
  if (risks.length > 0) {
    tier = atLeast(tier, "T2");
    reasons.push(text.risk(risks.map((risk) => text.risks[risk]).join(language === "en" ? ", " : "、")));
  }
  // Finding a bug means reading code that does not behave as written; small models guess.
  if (features.kind === "fix") {
    tier = atLeast(tier, "T2");
    reasons.push(text.fix);
  }
  if (features.reasoning === "design") {
    tier = "T3";
    reasons.push(text.design);
  }
  return {
    score,
    tier,
    reasons,
    // Scaffolding a new app is one step however many files it creates; there is nothing to split.
    splitSuggested: (features.scope === "new_subsystem" && features.kind !== "boilerplate") || score >= SPLIT_SCORE,
  };
}

export interface Escalation {
  tier: Tier;
  /** The starting tier when failures lifted the task; null when they did not. */
  escalatedFrom: Tier | null;
  needsHuman: boolean;
  reasons: string[];
}

/**
 * Lift a task one tier for every tier it failed on `ESCALATE_AFTER` times, starting from the tier
 * the rules or the user picked. Only failures on the tier it currently sits on count, so a task
 * forced up by hand does not inherit failures from below. The whole task moves; nothing changes
 * models halfway through a run.
 */
export function escalateTier(start: Tier, failures: TaskFailure[], language: Language): Escalation {
  const text = TEXT[language];
  const count = (tier: Tier) =>
    failures.filter((failure) => failure.tier === tier && failure.source !== "runner").length;
  const reasons: string[] = [];
  const above = (tier: Tier): Tier | undefined => TIER_ORDER[TIER_ORDER.indexOf(tier) + 1];
  let tier = start;
  // KM0 Runner already climbed to the failed tier, so a rejection there starts the next hand-off above it.
  for (const failure of failures) {
    if (failure.source !== "runner") continue;
    const lifted = above(failure.tier) ?? failure.tier;
    if (TIER_ORDER.indexOf(lifted) > TIER_ORDER.indexOf(tier)) {
      reasons.push(text.rejected(failure.tier, lifted));
      tier = lifted;
    }
  }
  let next = above(tier);
  while (next && count(tier) >= ESCALATE_AFTER) {
    reasons.push(text.lifted(tier, count(tier), next));
    tier = next;
    next = above(tier);
  }
  const rejectedOnTop = failures.some((failure) => failure.source === "runner" && failure.tier === "T3");
  const needsHuman = tier === "T3" && (count("T3") >= ESCALATE_AFTER || rejectedOnTop);
  if (needsHuman) reasons.push(rejectedOnTop ? text.rejectedTop : text.human(count("T3")));
  return { tier, escalatedFrom: tier === start ? null : start, needsHuman, reasons };
}

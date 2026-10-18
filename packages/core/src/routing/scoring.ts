import type { TaskFeatures, TaskRisk, Tier } from "@km0/shared";
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
    design: "需要设计决策 → T3",
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
    design: "needs design decisions → T3",
  },
} as const;

/**
 * Deterministic tier for a task. The score picks T1 (0–2), T2 (3–5) or T3 (6+); then hard rules
 * apply in this order: docs or boilerplate in at most 5 files → T1; any risk → at least T2;
 * design decisions → T3. Later rules win.
 */
export function decideTier(features: TaskFeatures, language: Language): TierDecision {
  const text = TEXT[language];
  const parts: [string, number][] = [
    [text.scope[features.scope], FEATURE_POINTS.scope[features.scope]],
    [text.ambiguity[features.ambiguity], FEATURE_POINTS.ambiguity[features.ambiguity]],
    [text.reasoning[features.reasoning], FEATURE_POINTS.reasoning[features.reasoning]],
    [text.context[features.context], FEATURE_POINTS.context[features.context]],
    [
      text.hasTests[String(features.hasTests) as "true" | "false"],
      FEATURE_POINTS.hasTests[String(features.hasTests) as "true" | "false"],
    ],
  ];
  const score = parts.reduce((sum, [, points]) => sum + points, 0);
  let tier: Tier = score <= TIER_LIMITS.T1 ? "T1" : score <= TIER_LIMITS.T2 ? "T2" : "T3";
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
  if (features.reasoning === "design") {
    tier = "T3";
    reasons.push(text.design);
  }
  return {
    score,
    tier,
    reasons,
    splitSuggested: features.scope === "new_subsystem" || score >= SPLIT_SCORE,
  };
}

import type { Built } from "./build";

const pct = (value: number) => `${Math.round(value * 100)}%`;
const fixed = (value: number, digits = 2) => value.toFixed(digits);

const COLUMN_UNITS: Record<string, string> = {
  design_arena_frontend: "Elo",
  aa_intelligence: "指数点",
  aa_coding: "指数点",
  aa_agentic: "指数点",
};

/** The build report: what went in, how well the prior predicts held-out results, and names to settle. */
export function report(built: Built): string {
  const { registry, aligned, result, difficulty, evaluation, priceFallback } = built;
  const lines: string[] = [];
  const table = (head: string[], rows: (string | number)[][]) => {
    lines.push(`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`);
    for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
    lines.push("");
  };
  const count = (coverage: string) => registry.models.filter((m) => m.coverage === coverage).length;

  lines.push(
    "# 模型能力先验：构建报告",
    "",
    "由 `pnpm --filter @km0/registry build` 生成，不要手改。数据来自各榜单的快照（`data/raw/`），同一份快照总能生成同样的结果。",
    "",
    `- 生成时间：${registry.generatedAt}；最新的榜单数据：${registry.dataDate}`,
    `- 模型 ${registry.models.length} 个：有编码类榜单成绩 ${count("measured")} 个，只有综合指数 ${count("inferred")} 个，没有任何成绩 ${count("none")} 个（按价位估计）`,
    `- 观测 ${aligned.observations.length} 条；不在 OpenRouter 目录里、只用于连接各榜单尺度的模型 ${aligned.unlisted.size} 个`,
    "",
    "## 数据来源",
    "",
  );
  table(
    ["来源", "最新条目", "条目", "未匹配", "衡量什么"],
    registry.sources.map((s) => [`[${s.name}](${s.url})`, s.newestEntry ?? "—", s.entries, s.unmatched, s.measures]),
  );

  lines.push(
    "## 先验的评估",
    "",
    `只用公开数据。留出：每个榜单的成绩分五份轮流隐藏、重新拟合后预测；新模型：${evaluation.newModels.cutoff} 之后发布的 ${evaluation.newModels.models} 个模型只保留 Artificial Analysis 综合指数，其余成绩全部预测。90% 区间覆盖率应在 90% 左右；为此给能力的标准差额外加上 ${fixed(evaluation.extraSd)}（逻辑尺度）。`,
    "",
    `- 留出：${evaluation.heldOut.overall.results} 条，覆盖率 ${pct(evaluation.heldOut.overall.coverage90)}，平均 |z| ${fixed(evaluation.heldOut.overall.meanAbsZ)}`,
    `- 新模型：${evaluation.newModels.overall.results} 条，覆盖率 ${pct(evaluation.newModels.overall.coverage90)}，平均 |z| ${fixed(evaluation.newModels.overall.meanAbsZ)}`,
    "",
    "Terminal-Bench 和 SWE-Bench Pro 的成绩几乎都来自新模型：把新模型的成绩隐藏后，这两列剩下的成绩很少，线性关系估得不准，所以它们在“新模型”一栏的误差和覆盖率偏悲观。正式构建时这些成绩都参与拟合。",
    "",
  );
  const newByColumn = new Map(evaluation.newModels.columns.map((c) => [c.column, c]));
  const rank = new Map(evaluation.rankAgreement.map((r) => [r.column, r]));
  table(
    ["榜单列", "留出条数", "留出误差（RMSE）", "留出覆盖率", "新模型误差", "新模型覆盖率", "排序一致性 τ"],
    evaluation.heldOut.columns.map((c) => {
      const unit = COLUMN_UNITS[c.column] ?? "百分点";
      const n = newByColumn.get(c.column);
      const r = rank.get(c.column);
      return [
        c.column,
        c.results,
        `${fixed(c.rmse, 1)} ${unit}`,
        pct(c.coverage90),
        n ? `${fixed(n.rmse, 1)} ${unit}` : "—",
        n ? pct(n.coverage90) : "—",
        r && r.models >= 5 ? fixed(r.tau) : "—",
      ];
    }),
  );

  lines.push(
    "## 各榜单列的线性关系",
    "",
    "y = α + β ·（能力 + 能力偏差 + Agent 修正），以 SWE-bench Verified 的逻辑分数为锚（α=0、β=1）。",
    "",
  );
  table(
    ["榜单列", "条数", "α", "β", "残差 σ"],
    [...result.columns].map(([column, c]) => [column, c.observations, fixed(c.alpha), fixed(c.beta), fixed(c.sigma)]),
  );

  lines.push(
    "## Agent 修正",
    "",
    `以 Rasch 难度尺度表示（加在模型能力上）。所有本家 Agent 共享的效应为 ${fixed(difficulty.link.slope * result.nativeEffect.mean)} ± ${fixed(difficulty.link.slope * result.nativeEffect.sd)}；没有成绩的本家 Agent 用它。`,
    "",
  );
  table(
    ["Agent", "本家厂商", "本家模型", "其他模型", "依据的成绩"],
    registry.agents.map((a) => [
      a.name,
      a.nativeVendors.join(", ") || "—",
      `${fixed(a.offset.native.mean)} ± ${fixed(a.offset.native.sd)}`,
      `${fixed(a.offset.foreign.mean)} ± ${fixed(a.offset.foreign.sd)}`,
      a.evidence,
    ]),
  );

  lines.push(
    "## 任务难度",
    "",
    `SWE-bench Verified 中 ${difficulty.link.runs} 次 mini-SWE-agent 运行的逐题结果拟合 Rasch 模型。能力尺度到 Rasch 尺度的换算：Rasch 能力 = ${fixed(difficulty.link.intercept)} + ${fixed(difficulty.link.slope)} × logit(Verified 解决率)，残差 ${fixed(difficulty.link.residualSd)}。KM0 的路由分数按下表对应到难度段。`,
    "",
  );
  table(
    ["难度段", "KM0 分数", "难度均值", "难度标准差", "题目数"],
    registry.difficulty.bands.map((b, i, all) => [
      b.id,
      b.maxScore === null ? `≥ ${(all[i - 1]?.maxScore ?? 0) + 1}` : `≤ ${b.maxScore}`,
      fixed(b.difficulty.mean),
      fixed(b.difficulty.sd),
      b.tasks,
    ]),
  );
  table(
    ["参考补丁改动的文件数", "难度均值", "题目数"],
    difficulty.byFiles.map((f) => [f.files, fixed(f.mean), f.tasks]),
  );
  lines.push(
    `没有任何成绩的模型按价位估计：能力 ≈ ${fixed(priceFallback.intercept)} + ${fixed(priceFallback.slope)} × log10(输出单价，美元/百万 token)，残差 ${fixed(priceFallback.sd)}（${priceFallback.models} 个模型拟合，逻辑尺度）。`,
    "",
  );

  const top = (kind: "general" | "frontend" | "devops", n: number) =>
    [...registry.models]
      .filter((m) => m.coverage !== "none")
      .sort((a, b) => b.abilities[kind].mean - a.abilities[kind].mean)
      .slice(0, n);
  for (const [kind, title, n] of [
    ["general", "综合编码能力", 30],
    ["frontend", "前端", 15],
    ["devops", "部署与配置", 15],
  ] as const) {
    lines.push(`## 能力最高的模型：${title}`, "");
    table(
      ["模型", "能力", "标准差", "依据", "输出单价"],
      top(kind, n).map((m) => [
        m.id,
        fixed(m.abilities[kind].mean),
        fixed(m.abilities[kind].sd),
        m.coverage === "measured" ? `${m.observations.length} 条成绩` : "只有综合指数",
        m.pricing.output === null ? "—" : `$${m.pricing.output}`,
      ]),
    );
  }

  const settle = new Map<string, { kind: string; sources: Set<string>; times: number; candidates: string[] }>();
  for (const p of aligned.problems) {
    const key = `${p.kind}|${p.name}`;
    const item = settle.get(key) ?? { kind: p.kind, sources: new Set<string>(), times: 0, candidates: p.candidates };
    item.sources.add(p.source);
    item.times += 1;
    settle.set(key, item);
  }
  const kindLabel: Record<string, string> = {
    "ambiguous-model": "对应多个模型",
    "unmatched-model": "没有对应的模型",
    "unknown-agent": "未知的 Agent",
  };
  lines.push(
    "## 待处理的名字",
    "",
    "下列名字没有对上。确实是同一个模型或 Agent 的，写进 `data/aliases.json` 或 `data/agents.json`；目录里没有的旧模型可以不管，出现在两个以上来源的会作为“只用于连接尺度”的模型参与拟合。",
    "",
  );
  table(
    ["名字", "问题", "来源", "次数", "候选"],
    [...settle]
      .sort((a, b) => a[1].kind.localeCompare(b[1].kind) || b[1].times - a[1].times || a[0].localeCompare(b[0]))
      .map(([key, item]) => [
        `\`${key.slice(key.indexOf("|") + 1).replace(/\|/g, "\\|")}\``,
        kindLabel[item.kind] ?? item.kind,
        [...item.sources].join(", "),
        item.times,
        item.candidates.join(", ") || "—",
      ]),
  );
  if (aligned.unlisted.size > 0) {
    lines.push("只用于连接尺度的模型：", "", ...[...aligned.unlisted].sort().map((id) => `- \`${id}\``), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

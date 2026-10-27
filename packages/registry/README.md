# @km0/registry：模型能力先验

把公开榜单的成绩整理成 KM0 的模型注册表（`generated/model-registry.json`）：有哪些模型、价格和上下文窗口、每个模型在各类任务上的能力估计（均值和标准差），以及各 Agent 对本家模型和其他模型的修正。KM0 随安装包带上这份文件，用作分发的先验；用户自己的验收结果之后修正它。

```bash
pnpm registry:fetch    # 重新下载各榜单，写入 data/raw/
pnpm registry:build    # 从快照生成 generated/model-registry.json 和 generated/report.md
pnpm --filter @km0/registry check   # CI：提交的生成结果必须和快照一致
```

每周一次的 GitHub Actions（`.github/workflows/registry.yml`）会重新下载、生成，并在有变化时开一个 PR。合并前看 `generated/report.md` 里的“待处理的名字”和“先验的评估”。合并到 `master` 后，KM0 里的“设置 → Agent → 模型能力数据 → 检查更新”就能下载到。

## 数据来源

2026-10-26 核实过的来源，抓取代码在 `src/sources/`，每个来源一个文件：

| 来源 | 取什么 | 用于 |
| --- | --- | --- |
| [OpenRouter 模型列表](https://openrouter.ai/api/v1/models) | 模型目录、价格、上下文窗口、发布时间；它附带的 Artificial Analysis 综合、编码、Agent 指数和 Design Arena 评分 | 目录与价格；综合能力；前端 |
| [Terminal-Bench](https://www.tbench.ai/) | 每行是 Agent + 模型 + 推理强度的成绩 | 部署与配置；Agent 修正 |
| [SWE-Bench Pro V2](https://labs.scale.com/leaderboard/swe_bench_pro_public_v2) | 完整集和难题集，标注了运行的 Agent | 后端；Agent 修正 |
| [SWE-rebench](https://swe-rebench.com/) | 模型发布后新收集的题目，同一个运行框架，分语言 | 后端、调试；TypeScript 部分用于前端 |
| [SWE-bench](https://www.swebench.com/) | Verified 和 Multilingual；Verified 中 mini-SWE-agent 的逐题结果，以及 Hugging Face 上每题的人工耗时估计 | 能力尺度的锚点；任务难度 |
| [Aider Polyglot](https://aider.chat/docs/leaderboards/) | 2025 年 10 月以前的成绩 | 旧模型，权重较低 |

没有用的：LiveCodeBench（2025 年 4 月后不再更新）、LMArena / arena.ai（数据在浏览器里加载，还有人机验证）、Artificial Analysis 的 API（需要密钥；它的指数已经通过 OpenRouter 拿到）。

## 方法

1. **名字对齐**（`src/names.ts`）：以 OpenRouter 的模型 ID 为规范 ID。榜单上的名字按固定规则逐级放宽（去掉日期、推理强度、“instruct”之类的包装词、四位快照号），每一级先按原顺序、再按排序后的词比对，只有指向唯一模型时才算匹配；还对不上的查 `data/aliases.json`。不做相似度匹配。目录里没有、但在两个以上来源出现的旧模型，作为“只用于连接尺度”的模型参与拟合，不发布。
2. **Agent**（`data/agents.json`）：榜单上的 Agent 名字对应到 KM0 的 Agent；mini-SWE-agent 和只测模型的成绩算作参照框架（修正为 0）。`data/vendors.json` 维护“厂商 → 本家 Agent”。
3. **联合拟合**（`src/fit.ts`）：每条成绩是潜在能力的带噪线性读数，`y = α列 + β列 ·（θ模型 + γ模型,能力 + δAgent）+ ε`。θ 是模型在参照框架下的编码能力，以 SWE-bench Verified 解决率的 logit 为尺度（α=0、β=1）；γ 让模型在前端或部署配置上可以偏离综合能力；δ 是 Agent 的修正，本家模型和其他模型各一个，本家修正共享一个也要估计的均值。各参数都有正态先验，交替更新求后验均值和标准差；每列的噪声用留一残差估计，避免只在一列出现的模型把噪声估成零。
4. **任务难度**（`src/difficulty.ts`）：用 Verified 的逐题结果拟合 Rasch 模型，得到每题难度；按人工耗时估计分成四段，KM0 的路由分数对应到这四段（≤2、3–5、6–7、≥8，和 T1/T2/T3 的分界一致）。同时得到从 θ 尺度到 Rasch 尺度的换算，注册表里的能力和难度都用 Rasch 尺度：模型通过一个难度为 b 的任务的概率是 σ(能力 − b)。
5. **评估**（`src/evaluate.ts`）：只用公开数据。每列成绩分五份轮流隐藏后预测；另外假设新模型只有 Artificial Analysis 综合指数，预测它们的其余成绩。看 90% 区间的覆盖率、误差和排序一致性，结果写在报告里。覆盖率不足 90% 时，给能力的标准差额外加一项，直到达到 90%。
6. **没有任何成绩的模型**：按输出单价的对数回归估计，标准差取回归残差，在注册表里标为 `coverage: "none"`。

## 文件

```
data/raw/*.json        各来源的快照（只保留用到的字段）
data/aliases.json      对不上的名字 → 规范 ID
data/agents.json       榜单上的 Agent 名字 → KM0 的 Agent，及其本家厂商
data/vendors.json      厂商、模型系列前缀、本家 Agent
data/columns.json      每个榜单列的变换、对应能力和权重
generated/             生成结果：注册表和报告（不要手改）
```

注册表的格式由 `packages/shared/src/registry.ts` 定义，应用加载时用同一个 schema 校验。

# 模型能力先验：构建报告

由 `pnpm --filter @km0/registry build` 生成，不要手改。数据来自各榜单的快照（`data/raw/`），同一份快照总能生成同样的结果。

- 生成时间：2026-10-26T06:09:12Z；最新的榜单数据：2026-10-23
- 模型 376 个：有编码类榜单成绩 191 个，只有综合指数 35 个，没有任何成绩 150 个（按价位估计）
- 观测 766 条；不在 OpenRouter 目录里、只用于连接各榜单尺度的模型 7 个

## 数据来源

| 来源 | 最新条目 | 条目 | 未匹配 | 衡量什么 |
| --- | --- | --- | --- | --- |
| [OpenRouter models (with Artificial Analysis and Design Arena)](https://openrouter.ai/api/v1/models) | 2026-10-23 | 543 | 3 | Model catalog, prices and context windows; Artificial Analysis intelligence, coding and agentic indices; Design Arena ratings for websites, UI components and web apps (frontend). |
| [Terminal-Bench 4.0](https://www.tbench.ai/) | 2026-09-29 | 35 | 0 | Long tasks in a terminal: building, configuring, debugging systems (deployment and configuration). Rows name the agent, so it also measures agents. |
| [SWE-Bench Pro V2](https://labs.scale.com/leaderboard/swe_bench_pro_public_v2) | 2026-10-16 | 32 | 0 | Long, multi-file changes in professional codebases (backend). The hard subset separates strong models; rows name the agent. |
| [SWE-rebench](https://swe-rebench.com/) | 2026-07-01 | 107 | 7 | Fresh GitHub issues collected after each model's release, in one harness (backend, debugging); its TypeScript tasks inform frontend. |
| [SWE-bench Verified and Multilingual](https://www.swebench.com/) | 2026-02-26 | 133 | 74 | Fixing real GitHub issues (backend, debugging). Verified anchors KM0's ability scale and, through its human time estimates, the difficulty of tasks. |
| [Aider Polyglot](https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml) | 2025-10-03 | 69 | 30 | Small coding exercises in six languages, edited through Aider (general coding; older models only). |

## 先验的评估

只用公开数据。留出：每个榜单的成绩分五份轮流隐藏、重新拟合后预测；新模型：2026-06-23 之后发布的 49 个模型只保留 Artificial Analysis 综合指数，其余成绩全部预测。90% 区间覆盖率应在 90% 左右；为此给能力的标准差额外加上 0.00（逻辑尺度）。

- 留出：722 条，覆盖率 94%，平均 |z| 0.66
- 新模型：155 条，覆盖率 89%，平均 |z| 0.75

Terminal-Bench 和 SWE-Bench Pro 的成绩几乎都来自新模型：把新模型的成绩隐藏后，这两列剩下的成绩很少，线性关系估得不准，所以它们在“新模型”一栏的误差和覆盖率偏悲观。正式构建时这些成绩都参与拟合。

| 榜单列 | 留出条数 | 留出误差（RMSE） | 留出覆盖率 | 新模型误差 | 新模型覆盖率 | 排序一致性 τ |
| --- | --- | --- | --- | --- | --- | --- |
| aa_agentic | 87 | 5.9 指数点 | 92% | 8.5 指数点 | 100% | 0.88 |
| aa_coding | 113 | 5.6 指数点 | 96% | 5.7 指数点 | 97% | 0.92 |
| aa_intelligence | 179 | 4.5 指数点 | 95% | — | — | 0.92 |
| aider_polyglot | 25 | 13.0 百分点 | 92% | — | — | 0.82 |
| design_arena_frontend | 120 | 66.7 Elo | 96% | 60.5 Elo | 100% | 0.73 |
| swe_pro | 16 | 5.1 百分点 | 100% | 2.9 百分点 | 79% | 0.78 |
| swe_pro_hard | 16 | 15.0 百分点 | 75% | 14.3 百分点 | 69% | 0.72 |
| swe_rebench | 78 | 8.7 百分点 | 91% | 13.0 百分点 | 80% | 0.74 |
| swe_rebench_ts | 13 | 9.8 百分点 | 100% | 11.9 百分点 | 100% | 0.79 |
| swebench_multilingual | 13 | 9.1 百分点 | 92% | — | — | 0.56 |
| swebench_verified | 39 | 12.9 百分点 | 95% | — | — | 0.84 |
| terminal_bench | 23 | 11.5 百分点 | 91% | 16.7 百分点 | 62% | — |

## 各榜单列的线性关系

y = α + β ·（能力 + 能力偏差 + Agent 修正），以 SWE-bench Verified 的逻辑分数为锚（α=0、β=1）。

| 榜单列 | 条数 | α | β | 残差 σ |
| --- | --- | --- | --- | --- |
| aa_agentic | 87 | -2.79 | 2.92 | 0.53 |
| aa_coding | 113 | -0.53 | 1.80 | 0.31 |
| aa_intelligence | 214 | -1.59 | 1.31 | 0.25 |
| aider_polyglot | 27 | 0.71 | 2.89 | 0.59 |
| design_arena_frontend | 126 | -0.89 | 1.28 | 0.52 |
| swe_pro | 16 | 0.55 | 2.49 | 0.54 |
| swe_pro_hard | 16 | -1.61 | 2.97 | 0.61 |
| swe_rebench | 79 | -0.69 | 1.42 | 0.38 |
| swe_rebench_ts | 13 | -0.99 | 2.06 | 0.49 |
| swebench_multilingual | 13 | 0.11 | 1.32 | 0.35 |
| swebench_verified | 39 | 0.00 | 1.00 | 0.59 |
| terminal_bench | 23 | -3.43 | 2.27 | 0.50 |

## Agent 修正

以 Rasch 难度尺度表示（加在模型能力上）。所有本家 Agent 共享的效应为 0.37 ± 0.30；没有成绩的本家 Agent 用它。

| Agent | 本家厂商 | 本家模型 | 其他模型 | 依据的成绩 |
| --- | --- | --- | --- | --- |
| Claude Code | anthropic | 0.70 ± 0.12 | 0.20 ± 0.23 | 17 |
| Codex | openai | 0.27 ± 0.12 | 0.00 ± 0.68 | 13 |
| Cursor | cursor | 0.37 ± 0.74 | 0.00 ± 0.68 | 0 |
| Pi | — | 0.00 ± 0.68 | 0.00 ± 0.68 | 0 |
| DSH | deepseek | 0.37 ± 0.74 | 0.00 ± 0.68 | 0 |
| ZCode | z-ai | 0.37 ± 0.74 | 0.00 ± 0.68 | 0 |
| Generic | — | 0.00 ± 0.68 | 0.00 ± 0.68 | 0 |
| Grok Build | x-ai | 0.20 ± 0.23 | 0.00 ± 0.68 | 3 |
| Muse Code | meta | 0.20 ± 0.36 | 0.00 ± 0.68 | 1 |

## 任务难度

SWE-bench Verified 中 38 次 mini-SWE-agent 运行的逐题结果拟合 Rasch 模型。能力尺度到 Rasch 尺度的换算：Rasch 能力 = -0.23 + 1.94 × logit(Verified 解决率)，残差 0.19。KM0 的路由分数按下表对应到难度段。

| 难度段 | KM0 分数 | 难度均值 | 难度标准差 | 题目数 |
| --- | --- | --- | --- | --- |
| lt15m | ≤ 2 | -1.18 | 2.28 | 194 |
| 15m-1h | ≤ 5 | 0.30 | 2.64 | 261 |
| 1h-4h | ≤ 7 | 2.79 | 2.36 | 42 |
| gt4h | ≥ 8 | 3.88 | 2.52 | 3 |

| 参考补丁改动的文件数 | 难度均值 | 题目数 |
| --- | --- | --- |
| 1 | -0.46 | 429 |
| 2 | 2.21 | 49 |
| 3-5 | 3.15 | 20 |
| 6+ | 3.28 | 2 |

没有任何成绩的模型按价位估计：能力 ≈ -0.04 + 0.44 × log10(输出单价，美元/百万 token)，残差 0.58（226 个模型拟合，逻辑尺度）。

## 能力最高的模型：综合编码能力

| 模型 | 能力 | 标准差 | 依据 | 输出单价 |
| --- | --- | --- | --- | --- |
| anthropic/claude-opus-5.5 | 2.52 | 0.32 | 3 条成绩 | $20 |
| google/gemini-4-argon | 2.45 | 0.30 | 4 条成绩 | $10 |
| moonshotai/kimi-k3.1-pro | 2.38 | 0.38 | 2 条成绩 | $10 |
| meta/muse-wonder | 2.17 | 0.36 | 3 条成绩 | $20 |
| openai/gpt-6.1-sol | 2.12 | 0.30 | 4 条成绩 | $10 |
| anthropic/claude-opus-5 | 2.03 | 0.24 | 9 条成绩 | $25 |
| anthropic/claude-fable-5.1 | 1.99 | 0.24 | 7 条成绩 | $50 |
| openai/gpt-6-sol | 1.98 | 0.33 | 2 条成绩 | $10 |
| anthropic/claude-sonnet-5.5 | 1.95 | 0.28 | 5 条成绩 | $10 |
| openai/gpt-6-astra | 1.88 | 0.25 | 6 条成绩 | $50 |
| xiaomi/mimo-v2.6-pro | 1.86 | 0.38 | 2 条成绩 | $0.87 |
| x-ai/grok-4.7 | 1.86 | 0.32 | 3 条成绩 | $6 |
| moonshotai/kimi-k3 | 1.79 | 0.25 | 6 条成绩 | $20 |
| meta/muse-spark-open | 1.75 | 0.36 | 3 条成绩 | $4.25 |
| meta/muse-spark-1.3 | 1.75 | 0.26 | 5 条成绩 | $4.25 |
| anthropic/claude-fable-5 | 1.74 | 0.25 | 7 条成绩 | $50 |
| stepfun/step-5-preview | 1.72 | 0.41 | 只有综合指数 | $2.7 |
| z-ai/glm-5.3 | 1.72 | 0.24 | 7 条成绩 | $1.4 |
| qwen/qwen3.8-max-0902 | 1.72 | 0.26 | 4 条成绩 | $6 |
| x-ai/grok-4.6 | 1.68 | 0.26 | 5 条成绩 | $6 |
| minimax/minimax-m3.1-flash | 1.66 | 0.41 | 只有综合指数 | $0.6 |
| openai/gpt-5.6-sol | 1.65 | 0.24 | 8 条成绩 | $20 |
| inclusionai/ling-3.1-flash | 1.56 | 0.41 | 只有综合指数 | $0.225 |
| openai/gpt-5.6-terra | 1.55 | 0.25 | 6 条成绩 | $12 |
| z-ai/glm-5.3-flash | 1.52 | 0.26 | 5 条成绩 | $0.5 |
| qwen/qwen3.8-2.4t-a95b | 1.47 | 0.28 | 3 条成绩 | $6 |
| deepseek/deepseek-v4.1-flash-1017 | 1.47 | 0.38 | 2 条成绩 | $1.2 |
| google/gemini-3.8-flash | 1.43 | 0.24 | 7 条成绩 | $4.125 |
| anthropic/claude-opus-4.8 | 1.43 | 0.25 | 6 条成绩 | $25 |
| meta/muse-spark-1.2 | 1.42 | 0.27 | 4 条成绩 | $4.25 |

## 能力最高的模型：前端

| 模型 | 能力 | 标准差 | 依据 | 输出单价 |
| --- | --- | --- | --- | --- |
| meta/muse-wonder | 2.19 | 0.77 | 3 条成绩 | $20 |
| anthropic/claude-opus-5.5 | 2.16 | 0.76 | 3 条成绩 | $20 |
| moonshotai/kimi-k3.1-pro | 2.13 | 0.78 | 2 条成绩 | $10 |
| openai/gpt-6-sol | 1.98 | 1.40 | 2 条成绩 | $10 |
| google/gemini-4-argon | 1.95 | 0.75 | 4 条成绩 | $10 |
| anthropic/claude-sonnet-5.5 | 1.92 | 0.74 | 5 条成绩 | $10 |
| openai/gpt-6.1-sol | 1.91 | 0.75 | 4 条成绩 | $10 |
| openai/gpt-6-astra | 1.88 | 1.38 | 6 条成绩 | $50 |
| anthropic/claude-opus-5 | 1.84 | 0.47 | 9 条成绩 | $25 |
| anthropic/claude-fable-5.1 | 1.83 | 0.73 | 7 条成绩 | $50 |
| meta/muse-spark-1.3 | 1.82 | 0.73 | 5 条成绩 | $4.25 |
| moonshotai/kimi-k3 | 1.81 | 0.73 | 6 条成绩 | $20 |
| stepfun/step-5-preview | 1.72 | 1.42 | 只有综合指数 | $2.7 |
| anthropic/claude-fable-5 | 1.72 | 0.48 | 7 条成绩 | $50 |
| qwen/qwen3.8-max-0902 | 1.72 | 1.38 | 4 条成绩 | $6 |

## 能力最高的模型：部署与配置

| 模型 | 能力 | 标准差 | 依据 | 输出单价 |
| --- | --- | --- | --- | --- |
| openai/gpt-6.1-sol | 2.65 | 0.51 | 4 条成绩 | $10 |
| openai/gpt-6-astra | 2.63 | 0.48 | 6 条成绩 | $50 |
| anthropic/claude-opus-5.5 | 2.51 | 0.52 | 3 条成绩 | $20 |
| google/gemini-4-argon | 2.45 | 1.39 | 4 条成绩 | $10 |
| moonshotai/kimi-k3.1-pro | 2.38 | 1.41 | 2 条成绩 | $10 |
| openai/gpt-6-sol | 2.36 | 0.53 | 2 条成绩 | $10 |
| anthropic/claude-sonnet-5.5 | 2.36 | 0.49 | 5 条成绩 | $10 |
| anthropic/claude-fable-5.1 | 2.24 | 0.47 | 7 条成绩 | $50 |
| meta/muse-wonder | 2.17 | 1.41 | 3 条成绩 | $20 |
| z-ai/glm-5.3 | 2.17 | 0.47 | 7 条成绩 | $1.4 |
| anthropic/claude-opus-5 | 2.12 | 0.47 | 9 条成绩 | $25 |
| x-ai/grok-4.7 | 2.04 | 0.52 | 3 条成绩 | $6 |
| z-ai/glm-5.3-flash | 1.95 | 0.48 | 5 条成绩 | $0.5 |
| openai/gpt-5.6-sol | 1.95 | 0.47 | 8 条成绩 | $20 |
| xiaomi/mimo-v2.6-pro | 1.86 | 1.41 | 2 条成绩 | $0.87 |

## 待处理的名字

下列名字没有对上。确实是同一个模型或 Agent 的，写进 `data/aliases.json` 或 `data/agents.json`；目录里没有的旧模型可以不管，出现在两个以上来源的会作为“只用于连接尺度”的模型参与拟合。

| 名字 | 问题 | 来源 | 次数 | 候选 |
| --- | --- | --- | --- | --- |
| `openai/gpt-4o-mini` | 对应多个模型 | openrouter | 2 | openai/gpt-4o-mini, openai/gpt-4o-mini-2024-07-18 |
| `openai/gpt-4o` | 对应多个模型 | openrouter | 1 | openai/gpt-4o, openai/gpt-4o-2024-05-13, openai/gpt-4o-2024-08-06, openai/gpt-4o-2024-11-20 |
| `SWE-agent` | 未知的 Agent | swebench | 8 | — |
| `EPAM AI/Run Developer Agent` | 未知的 Agent | swebench | 6 | — |
| `OpenHands` | 未知的 Agent | swebench | 6 | — |
| `RAG baseline` | 未知的 Agent | swebench | 4 | — |
| `Tools` | 未知的 Agent | swebench | 3 | — |
| `Agentless-1.5` | 未知的 Agent | swebench | 2 | — |
| `EntroPO + R2E` | 未知的 Agent | swebench | 2 | — |
| `live-SWE-agent` | 未知的 Agent | swebench | 2 | — |
| `Skywork-SWE-32B` | 未知的 Agent | swebench | 2 | — |
| `Sonar Foundation Agent` | 未知的 Agent | swebench | 2 | — |
| `SWE-Fixer` | 未知的 Agent | swebench | 2 | — |
| `Undisclosed` | 未知的 Agent | swebench | 2 | — |
| `Agentless Lite` | 未知的 Agent | swebench | 1 | — |
| `Agentless Mini` | 未知的 Agent | swebench | 1 | — |
| `AgentScope` | 未知的 Agent | swebench | 1 | — |
| `Aime-coder v1` | 未知的 Agent | swebench | 1 | — |
| `Amazon Nova Premier 1.0` | 未知的 Agent | swebench | 1 | — |
| `AppMap Navie` | 未知的 Agent | swebench | 1 | — |
| `Artemis Agent v2` | 未知的 Agent | swebench | 1 | — |
| `AutoCodeRover` | 未知的 Agent | swebench | 1 | — |
| `AutoCodeRover-v2.0` | 未知的 Agent | swebench | 1 | — |
| `AutoCodeRover-v2.1` | 未知的 Agent | swebench | 1 | — |
| `Bloop` | 未知的 Agent | swebench | 1 | — |
| `CodeShellAgent` | 未知的 Agent | swebench | 1 | — |
| `CodeStory Midwit Agent` | 未知的 Agent | swebench | 1 | — |
| `CodeSweep - SWE-agent` | 未知的 Agent | swebench | 1 | — |
| `DeepSWE-Preview` | 未知的 Agent | swebench | 1 | — |
| `devlo` | 未知的 Agent | swebench | 1 | — |
| `Engine Labs` | 未知的 Agent | swebench | 1 | — |
| `FrogBoss-32B-2510` | 未知的 Agent | swebench | 1 | — |
| `FrogMini-14B-2510` | 未知的 Agent | swebench | 1 | — |
| `Harness AI` | 未知的 Agent | swebench | 1 | — |
| `Learn-by-interact` | 未知的 Agent | swebench | 1 | — |
| `Lingxi v1.5` | 未知的 Agent | swebench | 1 | — |
| `Lingxi-v1.5` | 未知的 Agent | swebench | 1 | — |
| `MASAI` | 未知的 Agent | swebench | 1 | — |
| `MCTS-Refine-7B` | 未知的 Agent | swebench | 1 | — |
| `Moatless Tools` | 未知的 Agent | swebench | 1 | — |
| `PatchPilot-v1.1` | 未知的 Agent | swebench | 1 | — |
| `Prometheus-v1.2` | 未知的 Agent | swebench | 1 | — |
| `Prometheus-v1.2.1` | 未知的 Agent | swebench | 1 | — |
| `R2E-Gym` | 未知的 Agent | swebench | 1 | — |
| `SWE-Exp` | 未知的 Agent | swebench | 1 | — |
| `W&B Programmer O1 crosscheck5` | 未知的 Agent | swebench | 1 | — |
| `gemini-2.0-flash` | 没有对应的模型 | swe-rebench, swebench | 2 | — |
| `gemini-3-pro-preview` | 没有对应的模型 | swebench | 2 | — |
| `chatgpt-4o-latest (2025-02-15)` | 没有对应的模型 | aider-polyglot | 1 | — |
| `chatgpt-4o-latest (2025-03-29)` | 没有对应的模型 | aider-polyglot | 1 | — |
| `Claude Sonnet 3.5` | 没有对应的模型 | swe-rebench | 1 | — |
| `Claude Sonnet 4` | 没有对应的模型 | swe-rebench | 1 | — |
| `claude-3-5-haiku-20241022` | 没有对应的模型 | aider-polyglot | 1 | — |
| `claude-3-5-sonnet-20241022` | 没有对应的模型 | aider-polyglot | 1 | — |
| `claude-3-7-sonnet-20250219` | 没有对应的模型 | swebench | 1 | — |
| `claude-3-7-sonnet-20250219 (32k thinking tokens)` | 没有对应的模型 | aider-polyglot | 1 | — |
| `claude-3-7-sonnet-20250219 (no thinking)` | 没有对应的模型 | aider-polyglot | 1 | — |
| `claude-4-opus-20250514` | 没有对应的模型 | swebench | 1 | — |
| `claude-4-sonnet-20250514` | 没有对应的模型 | swebench | 1 | — |
| `claude-opus-4-20250514 (32k thinking)` | 没有对应的模型 | aider-polyglot | 1 | — |
| `claude-opus-4-20250514 (no think)` | 没有对应的模型 | aider-polyglot | 1 | — |
| `claude-sonnet-4-20250514 (32k thinking)` | 没有对应的模型 | aider-polyglot | 1 | — |
| `claude-sonnet-4-20250514 (no thinking)` | 没有对应的模型 | aider-polyglot | 1 | — |
| `Codestral 25.01` | 没有对应的模型 | aider-polyglot | 1 | — |
| `command-a-03-2025-quality` | 没有对应的模型 | aider-polyglot | 1 | — |
| `DeepSeek Chat V2.5` | 没有对应的模型 | aider-polyglot | 1 | — |
| `DeepSeek R1` | 没有对应的模型 | aider-polyglot | 1 | deepseek/deepseek-r1 |
| `DeepSeek R1 (0528)` | 没有对应的模型 | aider-polyglot | 1 | deepseek/deepseek-r1 |
| `DeepSeek R1 + claude-3-5-sonnet-20241022` | 没有对应的模型 | aider-polyglot | 1 | — |
| `Devstral-2-123B-Instruct-2512` | 没有对应的模型 | swe-rebench | 1 | — |
| `Devstral-Small-2-24B-Instruct-2512` | 没有对应的模型 | swe-rebench | 1 | — |
| `devstral-small-2512` | 没有对应的模型 | swebench | 1 | — |
| `Gemini 2.0 Pro exp-02-05` | 没有对应的模型 | aider-polyglot | 1 | — |
| `Gemini 2.5 Pro Preview 03-25` | 没有对应的模型 | aider-polyglot | 1 | — |
| `Gemini 3 Pro Preview` | 没有对应的模型 | swe-rebench | 1 | — |
| `gemini-2.0-flash-exp` | 没有对应的模型 | aider-polyglot | 1 | — |
| `gemini-2.0-flash-thinking-exp-01-21` | 没有对应的模型 | aider-polyglot | 1 | — |
| `gemini-2.5-flash-preview-04-17 (default)` | 没有对应的模型 | aider-polyglot | 1 | — |
| `gemini-2.5-flash-preview-05-20 (24k think)` | 没有对应的模型 | aider-polyglot | 1 | — |
| `gemini-2.5-flash-preview-05-20 (no think)` | 没有对应的模型 | aider-polyglot | 1 | — |
| `gemini-3-pro` | 没有对应的模型 | swebench | 1 | — |
| `gemini-exp-1206` | 没有对应的模型 | aider-polyglot | 1 | — |
| `gpt-4.5-preview` | 没有对应的模型 | aider-polyglot | 1 | — |
| `gpt-5-codex` | 没有对应的模型 | swe-rebench | 1 | — |
| `Grok 3 Beta` | 没有对应的模型 | aider-polyglot | 1 | — |
| `Grok 3 Mini Beta (high)` | 没有对应的模型 | aider-polyglot | 1 | — |
| `Grok 3 Mini Beta (low)` | 没有对应的模型 | aider-polyglot | 1 | — |
| `Grok 4` | 没有对应的模型 | swe-rebench | 1 | — |
| `Grok Code Fast 1` | 没有对应的模型 | swe-rebench | 1 | — |
| `grok-4 (high)` | 没有对应的模型 | aider-polyglot | 1 | — |
| `horizon-alpha` | 没有对应的模型 | swe-rebench | 1 | — |
| `horizon-beta` | 没有对应的模型 | swe-rebench | 1 | — |
| `o1-mini-2024-09-12` | 没有对应的模型 | aider-polyglot | 1 | — |
| `o3 (high) + gpt-4.1` | 没有对应的模型 | aider-polyglot | 1 | — |
| `openhands-lm-32b-v0.1` | 没有对应的模型 | aider-polyglot | 1 | — |
| `Optimus Alpha` | 没有对应的模型 | aider-polyglot | 1 | — |
| `Quasar Alpha` | 没有对应的模型 | aider-polyglot | 1 | — |
| `qwen-max-2025-01-25` | 没有对应的模型 | aider-polyglot | 1 | — |
| `Qwen3 235B A22B diff, no think, Alibaba API` | 没有对应的模型 | aider-polyglot | 1 | — |
| `Qwen3-235B-A22B` | 没有对应的模型 | swe-rebench | 1 | qwen/qwen3-235b-a22b |
| `QwQ-32B` | 没有对应的模型 | aider-polyglot | 1 | — |
| `QwQ-32B + Qwen 2.5 Coder Instruct` | 没有对应的模型 | aider-polyglot | 1 | — |
| `yi-lightning` | 没有对应的模型 | aider-polyglot | 1 | — |

只用于连接尺度的模型：

- `unlisted/2.0 flash gemini`
- `unlisted/3 gemini pro`
- `unlisted/3.5 sonnet`
- `unlisted/3.7 sonnet`
- `unlisted/4 grok`
- `unlisted/4 opus`
- `unlisted/4 sonnet`

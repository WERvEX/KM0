# KM0

KM0 是编码 Agent 的上游：你用一句话描述要做的事，KM0 判断它的复杂度，通过提问和你把需求与实现方案谈清楚，输出《产品需求文档》和《技术实现方案》，再把实现拆成任务，为每个任务选择合适的模型档位和 Agent（Claude Code、Codex、Cursor、Pi、DSH、ZCode 或通用），生成可以直接交接的任务包。简单的任务交给便宜的模型，复杂的任务才用强模型。

名字取自“零公里”：所有道路的里程都从这里起算。

> 第一期（P0–P6）已全部完成。设置环境变量 `KM0_FAKE_LLM=1` 可以用模拟模型体验流程，不需要 API Key。完整规划见 [docs/DESIGN.md](docs/DESIGN.md)。

## 形态

- 桌面应用（Windows / macOS / Linux），数据全部保存在本地。
- 支持 OpenAI 兼容接口（OpenAI、DeepSeek、Qwen、GLM、MiMo 等）和 Anthropic 接口。
- API Key 由操作系统凭据存储加密；KM0 不执行代码、不修改你的仓库。

## 能做什么

1. **分诊**：判断任务类型和复杂度，选择快速、轻量或完整通道，可以手动改。
2. **讨论**：完整通道分四个阶段（定位与规模、产品需求、技术选型、实现方案）提问，每轮最多 3 题，全程只点“推荐”也能走完。每个回答写进决策账本，回改一条决策只复核受影响的部分。
3. **查证**：技术选型阶段出题前，用配置好的搜索服务（博查搜索 API，或任意提供搜索工具的 MCP 服务器）查证最多 3 次，问题卡上列出来源；没有配置时标注“未查证”。
4. **关联本地仓库**：新建任务时可以选一个本地文件夹，KM0 只读扫描依赖清单、语言和 CI 配置，识别出的前端、后端、存储、部署方式直接写进技术选型阶段，不再重复提问。
5. **文档**：生成 PRD 和技术方案（轻量通道是一份精简版），支持按小节编辑、AI 修订、版本恢复，决策变了会标出过期的小节。
6. **任务路由**：拆成任务，按固定规则给每个任务定档位（T1/T2/T3）、选 Agent 和模型，估算成本并和“全部用 T3”对比，每一项都能手动调整。
7. **交接**：为 Claude Code、Codex、Cursor、Pi、DSH、ZCode 和通用格式生成交接包（zip），解压到代码库根目录后都在 `km0/` 文件夹里。

## 快速上手

1. 设置 → 模型：添加一个模型并测试连接。第一个模型自动作为路由模型；可以再加一个能力更强的作为规划模型。
2. 设置 → Agent：启用你用的 Agent，按档位填模型 ID 和单价（单价用来估算成本，不填也能用）。
3. 设置 → 搜索服务（可选）：
   - 博查：填 API Key 即可。
   - 远程 MCP 服务器：填地址、搜索工具名和查询参数名，需要鉴权时在“请求头”里每行写一个 `Name=value`。
   - 本地 MCP 服务器（仅桌面版）：填启动命令和参数，例如 `npx` 和 `-y <包名>`，密钥写在“环境变量”里。
4. 设置 → 通用 → 导入与导出配置：把以上配置导出成 JSON，在另一台电脑上导入。默认不含密钥，勾选后密钥以明文写入文件。

## 网页调试版

不想安装也可以直接在浏览器里试用：<https://wervex.github.io/KM0/>（加 `?simulated=1` 使用模拟模型，不需要 API Key）。

网页版和桌面版运行同一套代码，数据保存在当前浏览器的 IndexedDB 里，API Key 没有加密，只适合测试。网页版不能启动本地进程，所以不支持本地 MCP 服务器；关联本地仓库需要 Chrome 或 Edge（用浏览器的文件夹选择框，刷新页面后要重新选择）。每次推送到 `master` 或 `claude/*` 分支，CI 都会重新部署。首次使用需要在仓库 Settings → Pages 里把 Source 设为 “Deploy from a branch”，分支选 `gh-pages`、目录选 `/ (root)`。

## 开发

需要 Node.js 22.12+ 和 pnpm 10。

```bash
pnpm install
pnpm dev          # 启动开发版应用
pnpm web:dev      # 在浏览器里启动网页调试版（打开 /web.html）
pnpm web:build    # 构建网页调试版到 apps/desktop/out/web
pnpm test         # 单元与组件测试
pnpm typecheck    # 类型检查
pnpm lint         # Biome 检查
pnpm build        # 构建到 apps/desktop/out
pnpm e2e          # Playwright 端到端测试，包括桌面版和网页版（需先 pnpm build；Linux 无显示环境时用 xvfb-run -a pnpm e2e）
pnpm package      # 生成当前平台的安装包到 apps/desktop/release
```

GitHub Actions 会在每次推送时运行检查，分别在 Windows、macOS、Linux 上构建安装包（作为构建产物上传，暂未签名），并部署网页调试版。推送 `v*` 标签（例如 `v0.1.0`）时，还会把安装包发布成 GitHub Release，说明文字取自 `docs/releases/<标签>.md`。

## 目录结构

```
packages/core     领域逻辑与模型网关（纯 TypeScript，不依赖 Electron）
packages/shared   zod schema、IPC 契约、共享类型
apps/desktop      Electron 应用：主进程、预加载脚本、React 界面，以及网页调试版入口
e2e/              Playwright 端到端测试
docs/DESIGN.md    设计文档
```

## 本地数据

数据保存在应用数据目录下的 `KM0` 文件夹：Windows 为 `%APPDATA%\KM0`，macOS 为 `~/Library/Application Support/KM0`，Linux 为 `~/.config/KM0`。其中 `km0.db` 是 SQLite 数据库。

## 许可证

[Apache License 2.0](LICENSE)

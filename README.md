# KM0

KM0 是编码 Agent 的上游：你用一句话描述要做的事，KM0 判断它的复杂度，通过提问和你把需求与实现方案谈清楚，输出《产品需求文档》和《技术实现方案》，再把实现拆成任务，为每个任务选择合适的模型档位和 Agent（Claude Code、Codex、Cursor、Pi、DSH、ZCode 或通用），生成可以直接交接的任务包。简单的任务交给便宜的模型，复杂的任务才用强模型。

名字取自“零公里”：所有道路的里程都从这里起算。

> 当前处于 P2 阶段：模型配置、任务分诊、分阶段讨论（决策账本、回改与复核），以及 PRD、技术方案和精简版文档的生成（流式输出、版本、按小节编辑与 AI 修订、过期标记）已可用；任务路由和交接将在后续阶段开放。设置环境变量 `KM0_FAKE_LLM=1` 可以用模拟模型体验流程，不需要 API Key。完整规划见 [docs/DESIGN.md](docs/DESIGN.md)。

## 形态

- 桌面应用（Windows / macOS / Linux），数据全部保存在本地。
- 支持 OpenAI 兼容接口（OpenAI、DeepSeek、Qwen、GLM、MiMo 等）和 Anthropic 接口。
- API Key 由操作系统凭据存储加密；KM0 不执行代码、不修改你的仓库。

## 网页调试版

不想安装也可以直接在浏览器里试用：<https://wervex.github.io/StartSpec/>（加 `?simulated=1` 使用模拟模型，不需要 API Key）。

网页版和桌面版运行同一套代码，数据保存在当前浏览器的 IndexedDB 里，API Key 没有加密，只适合测试。每次推送到 `master` 或 `claude/*` 分支，CI 都会重新部署。首次使用需要在仓库 Settings → Pages 里把 Source 设为 “Deploy from a branch”，分支选 `gh-pages`、目录选 `/ (root)`。

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

GitHub Actions 会在每次推送时运行检查，分别在 Windows、macOS、Linux 上构建安装包（作为构建产物上传，暂未签名），并部署网页调试版。

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

import type { RepoScan, StackLayer } from "@km0/shared";
import type { DecisionDraft } from "../discussion/engine";
import type { Language } from "../discussion/prompts";

const LAYERS: StackLayer[] = ["frontend", "backend", "storage", "deployment"];

/**
 * Stage C decisions taken from what the repository already uses, so the discussion keeps the
 * existing stack instead of asking about it. Layers the scan did not recognise stay open.
 */
export function decisionsFromScan(scan: RepoScan, language: Language): DecisionDraft[] {
  const drafts: DecisionDraft[] = [];
  for (const layer of LAYERS) {
    const items = scan.stack.filter((item) => item.layer === layer);
    if (items.length === 0) continue;
    const names = items.map((item) => item.name);
    const sources = [...new Set(items.map((item) => item.file).filter(Boolean))].slice(0, 3);
    const where = sources.length > 0 ? sources.join(", ") : scan.name;
    drafts.push({
      key: layer,
      value: { text: names.join(language === "zh-CN" ? "、" : ", "), ...(names.length > 1 ? { items: names } : {}) },
      source: "ai",
      rationale:
        language === "zh-CN"
          ? `沿用现有仓库的技术栈（扫描识别自 ${where}）`
          : `Keeps the existing repository's stack (recognised from ${where})`,
      alternatives: [],
    });
  }
  const modules = scan.modules ?? [];
  if (modules.length > 0) {
    const formatted = modules.map((m) =>
      m.description
        ? language === "zh-CN"
          ? `${m.path}（${m.description}）`
          : `${m.path} (${m.description})`
        : m.path,
    );
    drafts.push({
      key: "modules",
      value: {
        text: formatted.join(language === "zh-CN" ? "、" : ", "),
        ...(modules.length > 1 ? { items: modules.map((m) => m.path) } : {}),
      },
      source: "ai",
      rationale:
        language === "zh-CN" ? "沿用现有仓库的目录与模块划分" : "Keeps the existing repository's module structure",
      alternatives: [],
    });
  }
  if (scan.testCommand) {
    drafts.push({
      key: "test_strategy",
      value: {
        text:
          language === "zh-CN"
            ? `运行现有测试命令 \`${scan.testCommand}\` 并为新增或修改的逻辑补充测试`
            : `Run \`${scan.testCommand}\` and add tests for new or changed behaviour`,
      },
      source: "ai",
      rationale:
        language === "zh-CN"
          ? `沿用仓库现有的测试命令 \`${scan.testCommand}\``
          : `Uses the repository's test command \`${scan.testCommand}\``,
      alternatives: [],
    });
  }
  return drafts;
}

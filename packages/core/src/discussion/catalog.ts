import type { DiscussionStage, ProjectPath } from "@km0/shared";

export interface DecisionKeyDef {
  key: string;
  stage: DiscussionStage;
  required: boolean;
  /** Keys whose change makes this decision worth re-checking. */
  dependsOn: string[];
  label: { "zh-CN": string; en: string };
  /** What the decision covers; shown to the model. */
  brief: string;
}

const key = (
  stage: DiscussionStage,
  name: string,
  required: boolean,
  dependsOn: string[],
  zh: string,
  en: string,
  brief: string,
): DecisionKeyDef => ({ key: name, stage, required, dependsOn, label: { "zh-CN": zh, en }, brief });

export const DECISION_KEYS: readonly DecisionKeyDef[] = [
  // Fast path: confirm what exactly to change and how to tell it is done.
  key("confirm", "scope", true, [], "改动范围", "Scope", "What exactly changes, and what stays untouched."),
  key(
    "confirm",
    "acceptance",
    true,
    ["scope"],
    "完成标准",
    "Done when",
    "Observable conditions that show the change works.",
  ),

  // Light path: one combined round of the essentials.
  key("brief", "brief_scope", true, [], "范围", "Scope", "What is in and out of this piece of work."),
  key(
    "brief",
    "brief_approach",
    true,
    ["brief_scope"],
    "实现思路",
    "Approach",
    "The technical approach and where it plugs into the existing system.",
  ),
  key(
    "brief",
    "brief_constraints",
    false,
    [],
    "约束",
    "Constraints",
    "Compatibility, performance, security or time constraints.",
  ),
  key(
    "brief",
    "brief_acceptance",
    true,
    ["brief_scope"],
    "验收标准",
    "Acceptance",
    "How to verify the work is complete.",
  ),

  // Full path, stage A: positioning and scale.
  key(
    "scale",
    "scale",
    true,
    [],
    "交付形态",
    "Delivery form",
    "Local tool, open-source project, online service, or enterprise system.",
  ),
  key(
    "scale",
    "user_scale",
    true,
    ["scale"],
    "用户规模",
    "User scale",
    "Expected number of users, concurrency and data volume.",
  ),
  key(
    "scale",
    "auth",
    true,
    ["scale"],
    "账号与权限",
    "Accounts and access",
    "Whether accounts, roles or multi-tenancy are needed.",
  ),
  key(
    "scale",
    "compliance",
    false,
    ["scale"],
    "合规与数据",
    "Compliance and data",
    "Data sensitivity, privacy or regulatory constraints.",
  ),
  key("scale", "timeline", false, [], "时间与预算", "Time and budget", "Deadline, team size and budget constraints."),

  // Full path, stage B: product requirements.
  key("requirements", "target_users", true, ["scale"], "目标用户", "Target users", "Who uses it and in what role."),
  key(
    "requirements",
    "core_scenarios",
    true,
    ["target_users"],
    "核心场景",
    "Core scenarios",
    "The two or three most important things users do.",
  ),
  key(
    "requirements",
    "mvp_features",
    true,
    ["core_scenarios"],
    "MVP 功能",
    "MVP features",
    "Features in the first release.",
  ),
  key("requirements", "non_goals", false, ["mvp_features"], "非目标", "Non-goals", "What is explicitly out of scope."),
  key(
    "requirements",
    "success_metrics",
    false,
    ["core_scenarios"],
    "成功标准",
    "Success metrics",
    "How success is measured.",
  ),

  // Full path, stage C: technology choices.
  key(
    "tech",
    "frontend",
    true,
    ["scale", "mvp_features"],
    "前端",
    "Frontend",
    "Client technology, or none if there is no UI.",
  ),
  key(
    "tech",
    "backend",
    true,
    ["scale", "mvp_features"],
    "后端",
    "Backend",
    "Server-side language and framework, or none.",
  ),
  key("tech", "storage", true, ["scale", "user_scale"], "数据存储", "Storage", "Database or storage technology."),
  key("tech", "deployment", true, ["scale"], "部署方式", "Deployment", "How it is packaged, hosted and released."),
  key(
    "tech",
    "auth_impl",
    false,
    ["auth"],
    "认证实现",
    "Auth implementation",
    "How accounts and permissions are implemented.",
  ),
  key("tech", "integrations", false, ["mvp_features"], "第三方集成", "Integrations", "External services and APIs."),

  // Full path, stage D: implementation plan.
  key(
    "implementation",
    "architecture",
    true,
    ["frontend", "backend", "storage"],
    "架构",
    "Architecture",
    "Overall architecture and main components.",
  ),
  key(
    "implementation",
    "modules",
    false,
    ["architecture", "mvp_features"],
    "模块划分",
    "Modules",
    "Modules and their responsibilities.",
  ),
  key(
    "implementation",
    "milestones",
    true,
    ["mvp_features", "architecture"],
    "里程碑",
    "Milestones",
    "Delivery milestones in order.",
  ),
  key(
    "implementation",
    "test_strategy",
    false,
    ["architecture"],
    "测试策略",
    "Test strategy",
    "What is tested and how.",
  ),
  key("implementation", "risks", false, ["architecture"], "主要风险", "Risks", "Main risks and mitigations."),
];

export const PATH_STAGES: Record<ProjectPath, DiscussionStage[]> = {
  fast: ["confirm"],
  light: ["brief"],
  full: ["scale", "requirements", "tech", "implementation"],
};

export const MAX_ROUNDS: Record<DiscussionStage, number> = {
  confirm: 1,
  brief: 2,
  scale: 3,
  requirements: 3,
  tech: 3,
  implementation: 3,
};

export const MAX_QUESTIONS_PER_ROUND = 3;

/** The scale question always offers the same four delivery forms so later defaults stay predictable. */
export const SCALE_OPTIONS = [
  { id: "local_tool", "zh-CN": "本地工具", en: "Local tool" },
  { id: "open_source", "zh-CN": "开源项目", en: "Open-source project" },
  { id: "online_service", "zh-CN": "在线部署", en: "Online service" },
  { id: "enterprise", "zh-CN": "企业级系统", en: "Enterprise system" },
] as const;

/** Default recommendations for the tech stage, keyed by delivery form. */
export const SCALE_DEFAULTS: Record<(typeof SCALE_OPTIONS)[number]["id"], string> = {
  local_tool: "Runs on one machine; SQLite or files for storage; no accounts; packaged for download.",
  open_source: "Easy install; clear license and docs; CI; optional plugin points; minimal infrastructure.",
  online_service: "Accounts; PostgreSQL; containerized deployment; monitoring and alerting.",
  enterprise: "SSO; multi-tenancy; audit logs; role-based access; compliance and high availability.",
};

const BY_KEY = new Map(DECISION_KEYS.map((def) => [def.key, def]));

export function keyDef(name: string): DecisionKeyDef | undefined {
  return BY_KEY.get(name);
}

export function stageKeys(stage: DiscussionStage): DecisionKeyDef[] {
  return DECISION_KEYS.filter((def) => def.stage === stage);
}

export function requiredKeys(stage: DiscussionStage): string[] {
  return stageKeys(stage)
    .filter((def) => def.required)
    .map((def) => def.key);
}

/** Every decided key that (directly or transitively) depends on `changed`. */
export function dependentsOf(changed: string): string[] {
  const result = new Set<string>();
  const queue = [changed];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const def of DECISION_KEYS) {
      if (def.dependsOn.includes(current) && !result.has(def.key) && def.key !== changed) {
        result.add(def.key);
        queue.push(def.key);
      }
    }
  }
  return [...result];
}

/** Map a scale decision's text back to a delivery form, if it matches one. */
export function scaleIdFromText(text: string): (typeof SCALE_OPTIONS)[number]["id"] | null {
  const lower = text.toLowerCase();
  for (const option of SCALE_OPTIONS) {
    if (
      lower.includes(option["zh-CN"].toLowerCase()) ||
      lower.includes(option.en.toLowerCase()) ||
      lower.includes(option.id)
    ) {
      return option.id;
    }
  }
  return null;
}

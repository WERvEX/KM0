import { z } from "zod";
import type { ProjectPath } from "./domain";

/** prd and tech_design come out of the full path; brief is the single combined document of the light path. */
export const DocumentKind = z.enum(["prd", "tech_design", "brief"]);
export type DocumentKind = z.infer<typeof DocumentKind>;

/** How a version came to be: a full generation, a manual edit, an AI revision of some sections, or a restore. */
export const DocumentOrigin = z.enum(["generated", "edited", "revised", "restored"]);
export type DocumentOrigin = z.infer<typeof DocumentOrigin>;

type Localized = { "zh-CN": string; en: string };

export interface SectionTemplate {
  id: string;
  title: Localized;
  /** Decision keys the section is written from; a later change to any of them marks it stale. */
  keys: string[];
}

export interface DocumentTemplate {
  kind: DocumentKind;
  title: Localized;
  fileName: string;
  sections: SectionTemplate[];
}

const section = (id: string, zh: string, en: string, keys: string[]): SectionTemplate => ({
  id,
  title: { "zh-CN": zh, en },
  keys,
});

const PRD_KEYS = [
  "scale",
  "user_scale",
  "compliance",
  "timeline",
  "target_users",
  "core_scenarios",
  "auth",
  "mvp_features",
  "non_goals",
  "success_metrics",
];
const BRIEF_KEYS = ["brief_scope", "brief_approach", "brief_constraints", "brief_acceptance"];

export const DOCUMENT_TEMPLATES: Record<DocumentKind, DocumentTemplate> = {
  prd: {
    kind: "prd",
    title: { "zh-CN": "产品需求文档", en: "Product requirements" },
    fileName: "PRD.md",
    sections: [
      section("background", "背景与目标", "Background and goals", ["scale", "target_users", "core_scenarios"]),
      section("positioning", "项目定位与规模", "Positioning and scale", [
        "scale",
        "user_scale",
        "compliance",
        "timeline",
      ]),
      section("users_scenarios", "目标用户与核心场景", "Users and core scenarios", [
        "target_users",
        "core_scenarios",
        "auth",
      ]),
      section("functional", "功能需求", "Functional requirements", ["mvp_features", "core_scenarios", "auth"]),
      section("non_functional", "非功能需求", "Non-functional requirements", ["scale", "user_scale", "compliance"]),
      section("non_goals", "非目标", "Non-goals", ["non_goals", "mvp_features"]),
      section("success", "成功标准", "Success criteria", ["success_metrics", "core_scenarios"]),
      section("open_questions", "待定问题", "Open questions", PRD_KEYS),
    ],
  },
  tech_design: {
    kind: "tech_design",
    title: { "zh-CN": "技术方案", en: "Technical design" },
    fileName: "TECH_DESIGN.md",
    sections: [
      section("stack", "技术选型与理由", "Technology choices", [
        "frontend",
        "backend",
        "storage",
        "deployment",
        "auth_impl",
        "integrations",
      ]),
      section("architecture", "架构概览", "Architecture", ["architecture", "frontend", "backend", "storage"]),
      section("modules", "模块划分", "Modules", ["modules", "architecture", "mvp_features"]),
      section("data_model", "数据模型", "Data model", ["storage", "mvp_features", "auth"]),
      section("interfaces", "接口", "Interfaces", ["architecture", "integrations", "mvp_features"]),
      section("deployment", "部署方案", "Deployment", ["deployment", "scale", "user_scale"]),
      section("security", "安全与合规", "Security and compliance", ["auth", "auth_impl", "compliance"]),
      section("testing", "测试策略", "Testing", ["test_strategy", "architecture"]),
      section("milestones", "里程碑", "Milestones", ["milestones", "mvp_features"]),
      section("risks", "风险", "Risks", ["risks", "architecture"]),
    ],
  },
  brief: {
    kind: "brief",
    title: { "zh-CN": "需求与方案（精简版）", en: "Brief" },
    fileName: "BRIEF.md",
    sections: [
      section("goal", "目标", "Goal", ["brief_scope"]),
      section("scope", "范围", "Scope", ["brief_scope"]),
      section("approach", "实现思路", "Approach", ["brief_approach", "brief_scope"]),
      section("constraints", "约束", "Constraints", ["brief_constraints"]),
      section("acceptance", "验收标准", "Acceptance criteria", ["brief_acceptance", "brief_scope"]),
      section("open_questions", "待定问题", "Open questions", BRIEF_KEYS),
    ],
  },
};

/** Documents each path produces. The fast path goes straight from the discussion to task routing. */
export const PATH_DOCUMENTS: Record<ProjectPath, DocumentKind[]> = {
  fast: [],
  light: ["brief"],
  full: ["prd", "tech_design"],
};

/** Decision text per key at the time a section was written; null when the key was undecided. */
export const SectionBasis = z.record(z.string(), z.string().nullable());
export type SectionBasis = z.infer<typeof SectionBasis>;

/** A section as stored with a version. */
export const StoredSection = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  /** Written by hand rather than by the model. */
  edited: z.boolean(),
  basis: SectionBasis,
});
export type StoredSection = z.infer<typeof StoredSection>;

export const DocumentSection = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  edited: z.boolean(),
  /** Decisions that changed since the section was written. */
  staleKeys: z.array(z.string()),
});
export type DocumentSection = z.infer<typeof DocumentSection>;

export const DocumentVersionInfo = z.object({
  version: z.number().int(),
  origin: DocumentOrigin,
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type DocumentVersionInfo = z.infer<typeof DocumentVersionInfo>;

export const DocumentView = DocumentVersionInfo.extend({
  kind: DocumentKind,
  /** False when an older version is being viewed. */
  latest: z.boolean(),
  sections: z.array(DocumentSection),
  markdown: z.string(),
  fileName: z.string(),
  /** Every version, newest first. */
  versions: z.array(DocumentVersionInfo),
});
export type DocumentView = z.infer<typeof DocumentView>;

/** What the project page needs to know about each of its documents without loading them. */
export const DocumentSummary = z.object({
  kind: DocumentKind,
  version: z.number().int().nullable(),
  staleSections: z.number().int(),
  updatedAt: z.string().nullable(),
});
export type DocumentSummary = z.infer<typeof DocumentSummary>;

const ProjectId = z.number().int().positive();
const Version = z.number().int().positive();

export const GetDocumentInput = z.object({ projectId: ProjectId, kind: DocumentKind, version: Version.optional() });

export const GenerateDocumentInput = z.object({
  projectId: ProjectId,
  kind: DocumentKind,
  /** Carry hand-edited sections of the latest version over instead of rewriting them. */
  keepEdited: z.boolean().default(false),
});

export const SaveSectionInput = z.object({
  projectId: ProjectId,
  kind: DocumentKind,
  /** The version the edit was made on; a newer latest version means the edit is stale. */
  baseVersion: Version,
  sectionId: z.string().min(1),
  body: z.string().max(40_000),
});

export const ReviseSectionsInput = z.object({
  projectId: ProjectId,
  kind: DocumentKind,
  baseVersion: Version,
  sectionIds: z.array(z.string().min(1)).min(1).max(12),
  /** What to change; null rewrites the sections from the current decisions. */
  instruction: z.string().trim().min(1).max(2000).nullable(),
});

export const RestoreDocumentInput = z.object({ projectId: ProjectId, kind: DocumentKind, version: Version });

/** Pushed while a document streams in. */
export const DocumentProgress = z.object({
  projectId: ProjectId,
  kind: DocumentKind,
  phase: z.enum(["start", "delta", "done"]),
  delta: z.string(),
});
export type DocumentProgress = z.infer<typeof DocumentProgress>;

/** Marker line that starts each section in a generated document. */
export const SECTION_MARKER = "@@section:";
const MARKER_LINE = /^\s*@@section:\s*([a-z_]+)\b.*$/;

/**
 * Split model output into section bodies by marker lines. Text before the first marker, unknown ids
 * and a heading the model repeated at the top of a section are dropped. Works on partial output too.
 */
export function splitSections(text: string, ids: readonly string[]): Map<string, string> {
  const known = new Set(ids);
  const bodies = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = MARKER_LINE.exec(line);
    if (marker) {
      const id = marker[1] as string;
      current = known.has(id) && !bodies.has(id) ? [] : null;
      if (current) bodies.set(id, current);
      continue;
    }
    current?.push(line);
  }
  const result = new Map<string, string>();
  for (const [id, lines] of bodies) {
    let body = lines.join("\n").trim();
    body = body.replace(/^#{1,2} [^\n]*\n?/, "").trim();
    body = body.replace(/\n-{3,}\s*$/, "").trim();
    result.set(id, body);
  }
  return result;
}

/** Decisions a section was based on that have a different value now. */
export function staleKeys(basis: SectionBasis, current: ReadonlyMap<string, string>): string[] {
  return Object.entries(basis)
    .filter(([key, text]) => (current.get(key) ?? null) !== text)
    .map(([key]) => key);
}

/** The Markdown file for a version: a title, then each section under a numbered heading. */
export function renderDocument(title: string, sections: readonly { title: string; body: string }[]): string {
  const parts = [`# ${title}`];
  sections.forEach((item, index) => {
    const body = item.body.trim();
    parts.push(`## ${index + 1}. ${item.title}${body ? `\n\n${body}` : ""}`);
  });
  return `${parts.join("\n\n")}\n`;
}

import { type DocumentLlm, type Language, PATH_STAGES, reviseSections, writeDocument } from "@km0/core";
import {
  AppError,
  type Decision,
  DOCUMENT_TEMPLATES,
  type DocumentKind,
  type DocumentOrigin,
  type DocumentSummary,
  type DocumentVersionInfo,
  type DocumentView,
  type EmitEvent,
  PATH_DOCUMENTS,
  type ProjectPath,
  type ProjectStage,
  renderDocument,
  type SectionBasis,
  StoredSection,
  staleKeys,
  Triage,
} from "@km0/shared";
import { z } from "zod";
import { type Database, nowIso } from "../db/sql";
import { KeyedLock } from "./lock";
import { readDecisions } from "./project-service";

interface DocumentRow {
  version: number;
  content: string;
  sections_json: string;
  origin: DocumentOrigin;
  note: string | null;
  created_at: string;
}

interface ProjectRow {
  title: string;
  description: string;
  path: ProjectPath | null;
  stage: ProjectStage;
  triage_json: string | null;
}

const StoredSections = z.array(StoredSection);

/** Streamed text is pushed to the window in batches rather than per token. */
const PROGRESS_INTERVAL_MS = 80;

function currentValues(decisions: Decision[]): Map<string, string> {
  return new Map(decisions.map((decision) => [decision.key, decision.value.text]));
}

function basisFor(keys: readonly string[], current: ReadonlyMap<string, string>): SectionBasis {
  return Object.fromEntries(keys.map((key) => [key, current.get(key) ?? null]));
}

function latestRow(db: Database, projectId: number, kind: DocumentKind): DocumentRow | undefined {
  return db
    .prepare("SELECT * FROM documents WHERE project_id = ? AND kind = ? ORDER BY version DESC LIMIT 1")
    .get(projectId, kind) as DocumentRow | undefined;
}

function parseSections(row: DocumentRow): StoredSection[] {
  return StoredSections.parse(JSON.parse(row.sections_json));
}

/** The latest version of a document with its sections, if it has been written. */
export function latestDocument(
  db: Database,
  projectId: number,
  kind: DocumentKind,
): { version: number; sections: StoredSection[] } | null {
  const row = latestRow(db, projectId, kind);
  return row ? { version: row.version, sections: parseSections(row) } : null;
}

/** Version and staleness of each document the path produces, for the project page. */
export function documentSummaries(
  db: Database,
  projectId: number,
  path: ProjectPath,
  decisions: Decision[],
): DocumentSummary[] {
  const current = currentValues(decisions);
  return PATH_DOCUMENTS[path].map((kind) => {
    const row = latestRow(db, projectId, kind);
    if (!row) return { kind, version: null, staleSections: 0, updatedAt: null };
    const stale = parseSections(row).filter((section) => staleKeys(section.basis, current).length > 0);
    return { kind, version: row.version, staleSections: stale.length, updatedAt: row.created_at };
  });
}

/**
 * PRD, technical design and brief: generated from the decision ledger, kept as numbered versions.
 * Each section remembers the decisions it was written from, so a later change marks only the
 * affected sections as stale. Work on one document is serialized; different documents of the same
 * project are generated side by side.
 */
export class DocumentService {
  private readonly locks = new KeyedLock<string>();

  constructor(
    private readonly db: Database,
    private readonly llmFor: (projectId: number) => DocumentLlm,
    private readonly language: () => Language,
    private readonly emit: EmitEvent,
  ) {}

  get(projectId: number, kind: DocumentKind, version?: number): DocumentView | null {
    this.project(projectId);
    const row =
      version === undefined
        ? latestRow(this.db, projectId, kind)
        : (this.db
            .prepare("SELECT * FROM documents WHERE project_id = ? AND kind = ? AND version = ?")
            .get(projectId, kind, version) as DocumentRow | undefined);
    if (!row) {
      if (version !== undefined) throw new AppError("not_found", `Version ${version} does not exist.`);
      return null;
    }
    return this.view(projectId, kind, row);
  }

  generate(projectId: number, kind: DocumentKind, keepEdited: boolean): Promise<DocumentView> {
    return this.locked(projectId, kind, async () => {
      const project = this.writableProject(projectId, kind);
      const decisions = readDecisions(this.db, projectId);
      const current = currentValues(decisions);
      const previous = latestRow(this.db, projectId, kind);
      const carried = new Map(
        keepEdited && previous
          ? parseSections(previous)
              .filter((section) => section.edited)
              .map((section) => [section.id, section])
          : [],
      );

      const bodies = await this.streaming(projectId, kind, (onDelta) =>
        writeDocument(this.llmFor(projectId), this.promptInput(project, kind, decisions), onDelta),
      );
      const sections = DOCUMENT_TEMPLATES[kind].sections.map((template): StoredSection => {
        const kept = carried.get(template.id);
        if (kept) return { ...kept, title: template.title[this.language()] };
        return {
          id: template.id,
          title: template.title[this.language()],
          // A section the model skipped is stored empty, ready to be written on its own.
          body: bodies.get(template.id) ?? "",
          edited: false,
          basis: basisFor(template.keys, current),
        };
      });
      return this.insert(projectId, kind, project, sections, "generated", null);
    });
  }

  saveSection(
    projectId: number,
    kind: DocumentKind,
    baseVersion: number,
    sectionId: string,
    body: string,
  ): Promise<DocumentView> {
    return this.locked(projectId, kind, async () => {
      const project = this.writableProject(projectId, kind);
      const sections = this.baseSections(projectId, kind, baseVersion);
      const target = this.section(sections, sectionId);
      const current = currentValues(readDecisions(this.db, projectId));
      // Saving by hand counts as reviewing the section against today's decisions.
      const updated = sections.map((section) =>
        section === target
          ? { ...section, body: body.trim(), edited: true, basis: basisFor(this.keysOf(kind, section.id), current) }
          : section,
      );
      return this.insert(projectId, kind, project, updated, "edited", null);
    });
  }

  revise(
    projectId: number,
    kind: DocumentKind,
    baseVersion: number,
    sectionIds: string[],
    instruction: string | null,
  ): Promise<DocumentView> {
    return this.locked(projectId, kind, async () => {
      const project = this.writableProject(projectId, kind);
      const sections = this.baseSections(projectId, kind, baseVersion);
      const targetIds = [...new Set(sectionIds)];
      for (const id of targetIds) this.section(sections, id);
      const decisions = readDecisions(this.db, projectId);
      const current = currentValues(decisions);
      const bodies = await reviseSections(this.llmFor(projectId), {
        ...this.promptInput(project, kind, decisions),
        current: sections,
        targetIds,
        instruction,
      });
      // Only the requested sections change; everything else is carried over untouched.
      const updated = sections.map((section) => {
        const body = bodies.get(section.id);
        if (body === undefined) return section;
        return { ...section, body, edited: false, basis: basisFor(this.keysOf(kind, section.id), current) };
      });
      return this.insert(projectId, kind, project, updated, "revised", instruction);
    });
  }

  restore(projectId: number, kind: DocumentKind, version: number): Promise<DocumentView> {
    return this.locked(projectId, kind, async () => {
      const project = this.writableProject(projectId, kind);
      const row = this.db
        .prepare("SELECT * FROM documents WHERE project_id = ? AND kind = ? AND version = ?")
        .get(projectId, kind, version) as DocumentRow | undefined;
      if (!row) throw new AppError("not_found", `Version ${version} does not exist.`);
      // The old basis comes along, so restored sections show whether they still match the decisions.
      return this.insert(projectId, kind, project, parseSections(row), "restored", String(version));
    });
  }

  // --- helpers -----------------------------------------------------------------------------

  private locked<T>(projectId: number, kind: DocumentKind, work: () => Promise<T>): Promise<T> {
    return this.locks.run(`${projectId}:${kind}`, work);
  }

  /** Run a streamed call, pushing its text to the window in batches; `done` is sent even on failure. */
  private async streaming<T>(
    projectId: number,
    kind: DocumentKind,
    work: (onDelta: (text: string) => void) => Promise<T>,
  ): Promise<T> {
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (!buffer) return;
      this.emit("document.progress", { projectId, kind, phase: "delta", delta: buffer });
      buffer = "";
    };
    this.emit("document.progress", { projectId, kind, phase: "start", delta: "" });
    try {
      return await work((text) => {
        buffer += text;
        timer ??= setTimeout(flush, PROGRESS_INTERVAL_MS);
      });
    } finally {
      if (timer) clearTimeout(timer);
      flush();
      this.emit("document.progress", { projectId, kind, phase: "done", delta: "" });
    }
  }

  private project(projectId: number): ProjectRow {
    const row = this.db
      .prepare("SELECT title, description, path, stage, triage_json FROM projects WHERE id = ?")
      .get(projectId) as ProjectRow | undefined;
    if (!row) throw new AppError("not_found", `Project ${projectId} does not exist.`);
    return row;
  }

  /** Documents are written once the discussion is over, and only those the project's path produces. */
  private writableProject(projectId: number, kind: DocumentKind): ProjectRow {
    const project = this.project(projectId);
    const path = project.path ?? "full";
    if (!PATH_DOCUMENTS[path].includes(kind)) {
      throw new AppError("conflict", "This project's path does not produce this document.");
    }
    const discussing = project.stage === "triage" || (PATH_STAGES[path] as string[]).includes(project.stage);
    if (discussing) throw new AppError("conflict", "Finish the discussion before writing documents.");
    return project;
  }

  /** Sections of the latest version, which must be the version the user was looking at. */
  private baseSections(projectId: number, kind: DocumentKind, baseVersion: number): StoredSection[] {
    const latest = latestRow(this.db, projectId, kind);
    if (!latest) throw new AppError("not_found", "This document has not been written yet.");
    if (latest.version !== baseVersion) {
      throw new AppError("conflict", "The document changed in the meantime. The latest version has been loaded.");
    }
    return parseSections(latest);
  }

  private section(sections: StoredSection[], id: string): StoredSection {
    const found = sections.find((section) => section.id === id);
    if (!found) throw new AppError("validation", `Unknown section: ${id}`);
    return found;
  }

  private keysOf(kind: DocumentKind, sectionId: string): string[] {
    return DOCUMENT_TEMPLATES[kind].sections.find((section) => section.id === sectionId)?.keys ?? [];
  }

  private promptInput(project: ProjectRow, kind: DocumentKind, decisions: Decision[]) {
    return {
      language: this.language(),
      kind,
      title: project.title,
      description: project.description,
      triage: project.triage_json ? Triage.parse(JSON.parse(project.triage_json)) : null,
      decisions,
    };
  }

  private insert(
    projectId: number,
    kind: DocumentKind,
    project: ProjectRow,
    sections: StoredSection[],
    origin: DocumentOrigin,
    note: string | null,
  ): DocumentView {
    const version = (latestRow(this.db, projectId, kind)?.version ?? 0) + 1;
    const title = `${project.title} · ${DOCUMENT_TEMPLATES[kind].title[this.language()]}`;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO documents (project_id, kind, version, content, sections_json, origin, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, kind, version, renderDocument(title, sections), JSON.stringify(sections), origin, note, now);
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId);
    return this.get(projectId, kind) as DocumentView;
  }

  private view(projectId: number, kind: DocumentKind, row: DocumentRow): DocumentView {
    const current = currentValues(readDecisions(this.db, projectId));
    const versions = this.db
      .prepare(
        "SELECT version, origin, note, created_at FROM documents WHERE project_id = ? AND kind = ? ORDER BY version DESC",
      )
      .all(projectId, kind) as unknown as Omit<DocumentRow, "content" | "sections_json">[];
    const info = (item: Omit<DocumentRow, "content" | "sections_json">): DocumentVersionInfo => ({
      version: item.version,
      origin: item.origin,
      note: item.note,
      createdAt: item.created_at,
    });
    return {
      ...info(row),
      kind,
      latest: versions[0]?.version === row.version,
      sections: parseSections(row).map((section) => ({
        id: section.id,
        title: section.title,
        body: section.body,
        edited: section.edited,
        staleKeys: staleKeys(section.basis, current),
      })),
      markdown: row.content,
      fileName: DOCUMENT_TEMPLATES[kind].fileName,
      versions: versions.map(info),
    };
  }
}

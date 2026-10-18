import {
  DOCUMENT_TEMPLATES,
  type DocumentKind,
  type DocumentSummary,
  type DocumentView,
  splitSections,
} from "@km0/shared";
import { AlertTriangle, Copy, Download, FileText, Loader2, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { Markdown } from "./Markdown";
import { SectionCard } from "./SectionCard";
import { type DocumentActions, useDocument } from "./useDocuments";

interface PanelProps {
  projectId: number;
  summaries: DocumentSummary[];
  actions: DocumentActions;
  streams: Partial<Record<DocumentKind, string>>;
}

function useDocTitle() {
  const { i18n } = useTranslation();
  return (kind: DocumentKind) => DOCUMENT_TEMPLATES[kind].title[i18n.language === "en" ? "en" : "zh-CN"];
}

/** The documents of a project whose discussion is complete, one tab per document. */
export function DocumentsPanel({ projectId, summaries, actions, streams }: PanelProps) {
  const { t } = useTranslation();
  const docTitle = useDocTitle();
  const [active, setActive] = useState<DocumentKind>(summaries[0]?.kind ?? "prd");
  const missing = summaries.filter((summary) => summary.version === null && !actions.pending[summary.kind]);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 border-b border-border">
        <div role="tablist" aria-label={t("documents.title")} className="flex gap-1">
          {summaries.map((summary) => (
            <button
              key={summary.kind}
              type="button"
              role="tab"
              aria-selected={active === summary.kind}
              className={cn(
                "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm",
                active === summary.kind ? "border-accent font-medium" : "border-transparent text-muted hover:text-fg",
              )}
              onClick={() => setActive(summary.kind)}
            >
              <FileText className="size-4" />
              {docTitle(summary.kind)}
              {actions.pending[summary.kind] ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {summary.staleSections > 0 ? (
                <span className="rounded-full bg-warning/15 px-1.5 text-[11px] text-warning">
                  {summary.staleSections}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        {summaries.length > 1 && missing.length > 1 ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              for (const item of missing) void actions.generate(item.kind);
            }}
          >
            {t("documents.generateAll")}
          </Button>
        ) : null}
      </div>
      {summaries.map((summary) =>
        summary.kind === active ? (
          <DocumentPane
            key={summary.kind}
            projectId={projectId}
            kind={summary.kind}
            actions={actions}
            streamText={streams[summary.kind]}
          />
        ) : null,
      )}
      <p className="text-sm text-muted">{t("documents.nextStep")}</p>
    </section>
  );
}

interface ConfirmState {
  title: string;
  body: string;
  choices: { label: string; primary?: boolean; run: () => void }[];
}

interface PaneProps {
  projectId: number;
  kind: DocumentKind;
  actions: DocumentActions;
  streamText: string | undefined;
}

function DocumentPane({ projectId, kind, actions, streamText }: PaneProps) {
  const { t, i18n } = useTranslation();
  const docTitle = useDocTitle();
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [copied, setCopied] = useState(false);
  const query = useDocument(projectId, kind, viewVersion);
  const pending = actions.pending[kind];
  const error = actions.errors[kind];
  const name = docTitle(kind);

  const errorBox = error ? (
    <div role="alert" className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
      {t("documents.error", { message: error })}
    </div>
  ) : null;

  if (streamText !== undefined) return <StreamingPreview kind={kind} name={name} text={streamText} />;
  if (query.isLoading) return null;
  const doc = query.data;
  if (!doc) {
    return (
      <div className="flex flex-col gap-3">
        {errorBox}
        <div className="rounded-lg border border-border bg-panel p-5">
          <h2 className="font-medium">{t("documents.empty.title", { name })}</h2>
          <p className="mt-1 text-sm text-muted">{t("documents.empty.body")}</p>
          <Button className="mt-4" variant="primary" disabled={Boolean(pending)} onClick={() => actions.generate(kind)}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            {t("documents.empty.action", { name })}
          </Button>
        </div>
      </div>
    );
  }

  const readOnly = !doc.latest;
  const editedTitles = (ids?: string[]) =>
    doc.sections.filter((section) => section.edited && (!ids || ids.includes(section.id))).map((s) => s.title);

  /** AI rewrites of sections the user wrote by hand are confirmed first. */
  const revise = (sectionIds: string[], instruction: string | null) => {
    const start = () =>
      void actions.run(
        "document.revise",
        { projectId, kind, baseVersion: doc.version, sectionIds, instruction },
        sectionIds.length === 1 ? `revise:${sectionIds[0]}` : "revise",
      );
    const edited = editedTitles(sectionIds);
    if (edited.length === 0) return start();
    setConfirm({
      title: t("documents.confirm.overwriteTitle"),
      body: t("documents.confirm.overwriteBody", { sections: edited.join("、") }),
      choices: [{ label: t("documents.confirm.continue"), primary: true, run: start }],
    });
  };

  const regenerateAll = () => {
    const edited = editedTitles();
    if (edited.length === 0) return void actions.generate(kind);
    setConfirm({
      title: t("documents.confirm.keepTitle"),
      body: t("documents.confirm.keepBody", { sections: edited.join("、") }),
      choices: [
        { label: t("documents.confirm.overwrite"), run: () => void actions.generate(kind, false) },
        { label: t("documents.confirm.keep"), primary: true, run: () => void actions.generate(kind, true) },
      ],
    });
  };

  const stale = doc.sections.filter((section) => section.staleKeys.length > 0);
  const formatTime = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const originLabel = (item: DocumentView["versions"][number]) =>
    item.origin === "restored"
      ? t("documents.origin.restored", { n: item.note })
      : t(`documents.origin.${item.origin}`);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-muted">
          <label htmlFor={`version-${kind}`}>{t("documents.version")}</label>
          <Select
            id={`version-${kind}`}
            className="h-8 w-60"
            value={doc.version}
            onChange={(event) => {
              const version = Number(event.target.value);
              setViewVersion(version === doc.versions[0]?.version ? null : version);
            }}
          >
            {doc.versions.map((item) => (
              <option key={item.version} value={item.version}>
                v{item.version} · {originLabel(item)} · {formatTime(item.createdAt)}
              </option>
            ))}
          </Select>
          {doc.origin === "revised" && doc.note ? (
            <span className="max-w-64 truncate" title={doc.note}>
              “{doc.note}”
            </span>
          ) : null}
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(doc.markdown).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            <Copy />
            {copied ? t("documents.copied") : t("documents.copy")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => downloadMarkdown(doc.fileName, doc.markdown)}>
            <Download />
            {t("documents.download", { file: doc.fileName })}
          </Button>
          {!readOnly ? (
            <Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={regenerateAll}>
              <RefreshCw />
              {t("documents.regenerate")}
            </Button>
          ) : null}
        </div>
      </div>

      {errorBox}

      {readOnly ? (
        <Banner>
          <span>{t("documents.viewingOld", { n: doc.version })}</span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={Boolean(pending)}
              onClick={() =>
                void actions
                  .run("document.restore", { projectId, kind, version: doc.version }, "restore")
                  .then((view) => view && setViewVersion(null))
              }
            >
              {t("documents.restore")}
            </Button>
            <Button size="sm" onClick={() => setViewVersion(null)}>
              {t("documents.backToLatest")}
            </Button>
          </div>
        </Banner>
      ) : stale.length > 0 ? (
        <Banner warning>
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" />
            {t("documents.staleBanner", { count: stale.length, sections: stale.map((s) => s.title).join("、") })}
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={Boolean(pending)}
            onClick={() =>
              revise(
                stale.map((section) => section.id),
                null,
              )
            }
          >
            {pending === "revise" ? <Loader2 className="animate-spin" /> : null}
            {t("documents.updateStale")}
          </Button>
        </Banner>
      ) : null}

      {pending === "generate" || pending === "restore" ? (
        <p className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
          <Loader2 className="size-4 animate-spin" />
          {t("documents.working")}
        </p>
      ) : null}

      {doc.sections.map((section, index) => (
        <SectionCard
          key={`${doc.version}:${section.id}`}
          index={index}
          section={section}
          readOnly={readOnly}
          busy={Boolean(pending)}
          working={pending === `revise:${section.id}` || (pending === "revise" && section.staleKeys.length > 0)}
          onSave={(body) =>
            void actions.run(
              "document.saveSection",
              { projectId, kind, baseVersion: doc.version, sectionId: section.id, body },
              `save:${section.id}`,
            )
          }
          onRevise={(instruction) => revise([section.id], instruction)}
          onRegenerate={() => revise([section.id], null)}
        />
      ))}

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm?.title ?? ""}
        description={confirm?.body}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>{t("documents.confirm.cancel")}</Button>
            {confirm?.choices.map((choice) => (
              <Button
                key={choice.label}
                variant={choice.primary ? "primary" : "secondary"}
                onClick={() => {
                  setConfirm(null);
                  choice.run();
                }}
              >
                {choice.label}
              </Button>
            ))}
          </>
        }
      />
    </div>
  );
}

function Banner({ children, warning }: { children: ReactNode; warning?: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm",
        warning ? "border-warning/40 bg-warning/5" : "border-border bg-sunken",
      )}
    >
      {children}
    </div>
  );
}

/** Sections fill in as the planner writes them. */
function StreamingPreview({ kind, name, text }: { kind: DocumentKind; name: string; text: string }) {
  const { t, i18n } = useTranslation();
  const templates = DOCUMENT_TEMPLATES[kind].sections;
  const bodies = splitSections(
    text,
    templates.map((section) => section.id),
  );
  const language = i18n.language === "en" ? "en" : "zh-CN";
  const written = templates.filter((section) => bodies.has(section.id));
  const currentTitle = written.at(-1)?.title[language];

  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <p className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
        <Loader2 className="size-4 animate-spin" />
        {currentTitle
          ? t("documents.writing", { name, section: currentTitle, done: written.length, total: templates.length })
          : t("documents.thinking", { name })}
      </p>
      {written.map((section) => (
        <section key={section.id} className="rounded-lg border border-border bg-panel px-5 py-4">
          <h2 className="font-semibold">
            {templates.indexOf(section) + 1}. {section.title[language]}
          </h2>
          <Markdown className="mt-3">{bodies.get(section.id) ?? ""}</Markdown>
        </section>
      ))}
    </div>
  );
}

function downloadMarkdown(fileName: string, markdown: string) {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

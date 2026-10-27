import {
  DOCUMENT_TEMPLATES,
  type DocumentKind,
  type DocumentSummary,
  type DocumentView,
  splitSections,
} from "@km0/shared";
import { AlertTriangle, CircleHelp, Copy, Download, FileText, ListChecks, Loader2, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Select, Textarea } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { useFiles } from "@/lib/files";
import { RoutingPanel } from "../routing/RoutingPanel";
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

/** What a finished discussion produces: one tab per document, then the routed tasks. */
export function DocumentsPanel({ projectId, summaries, actions, streams }: PanelProps) {
  const { t } = useTranslation();
  const docTitle = useDocTitle();
  const [active, setActive] = useState<DocumentKind | "routing">(summaries[0]?.kind ?? "prd");
  const documentsMissing = summaries.some((summary) => summary.version === null);
  const openQuestions = summaries.reduce((sum, summary) => sum + summary.openQuestions, 0);
  const missing = summaries.filter((summary) => summary.version === null && !actions.pending[summary.kind]);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 border-b border-border">
        <div
          role="tablist"
          aria-label={t("documents.title")}
          className="flex min-w-0 gap-1 overflow-x-auto overflow-y-hidden pb-px"
        >
          {summaries.map((summary) => (
            <button
              key={summary.kind}
              type="button"
              role="tab"
              aria-selected={active === summary.kind}
              className={cn(
                "-mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm",
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
          <button
            type="button"
            role="tab"
            aria-selected={active === "routing"}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm",
              active === "routing" ? "border-accent font-medium" : "border-transparent text-muted hover:text-fg",
            )}
            onClick={() => setActive("routing")}
          >
            <ListChecks className="size-4" />
            {t("routing.tab")}
          </button>
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
      {active === "routing" ? (
        <RoutingPanel
          projectId={projectId}
          blockedReason={documentsMissing ? t("routing.needDocuments") : null}
          openQuestions={openQuestions}
        />
      ) : null}
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
  const files = useFiles();
  const docTitle = useDocTitle();
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [copied, setCopied] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [answers, setAnswers] = useState("");
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
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void files.saveFile({
                title: t("files.saveFile"),
                defaultName: doc.fileName,
                content: doc.markdown,
                mimeType: "text/markdown;charset=utf-8",
                memoryKey: "documents",
              })
            }
          >
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

      {!readOnly && doc.openQuestions.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-sunken p-3 text-sm">
          <span className="flex items-center gap-2 font-medium">
            <CircleHelp className="size-4 shrink-0" />
            {t("documents.openQuestions.banner", { count: doc.openQuestions.length })}
          </span>
          <ul className="list-disc space-y-1 pl-9 text-muted">
            {doc.openQuestions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div>
            <Button size="sm" variant="primary" disabled={Boolean(pending)} onClick={() => setAnswering(true)}>
              {pending === "revise" ? <Loader2 className="animate-spin" /> : null}
              {t("documents.openQuestions.answer")}
            </Button>
          </div>
        </div>
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
        open={answering}
        onOpenChange={setAnswering}
        title={t("documents.openQuestions.title")}
        description={t("documents.openQuestions.body")}
        wide
        footer={
          <>
            <Button onClick={() => setAnswering(false)}>{t("documents.confirm.cancel")}</Button>
            <Button
              variant="primary"
              disabled={answers.trim().length === 0}
              onClick={() => {
                // Answers can touch any section, and the open questions themselves shrink.
                revise(
                  doc.sections.map((section) => section.id),
                  t("documents.openQuestions.note", { answers: answers.trim() }),
                );
                setAnswering(false);
                setAnswers("");
              }}
            >
              {t("documents.openQuestions.submit")}
            </Button>
          </>
        }
      >
        <Textarea
          aria-label={t("documents.openQuestions.title")}
          rows={6}
          value={answers}
          placeholder={t("documents.openQuestions.placeholder")}
          onChange={(event) => setAnswers(event.target.value)}
        />
      </Dialog>

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

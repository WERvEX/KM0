import type { DocumentSection } from "@km0/shared";
import { AlertTriangle, Loader2, Pencil, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/field";
import { decisionLabel } from "../project/labels";
import { Markdown } from "./Markdown";

interface Props {
  index: number;
  section: DocumentSection;
  /** An older version is shown: no actions. */
  readOnly: boolean;
  /** Something else on this document is running. */
  busy: boolean;
  /** This section is being revised. */
  working: boolean;
  onSave: (body: string) => void;
  onRevise: (instruction: string) => void;
  onRegenerate: () => void;
}

export function SectionCard({ index, section, readOnly, busy, working, onSave, onRevise, onRegenerate }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"view" | "edit" | "revise">("view");
  const [draft, setDraft] = useState("");
  const [instruction, setInstruction] = useState("");
  const headingId = `section-${section.id}`;

  return (
    <section aria-labelledby={headingId} className="group rounded-lg border border-border bg-panel px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={headingId} className="font-semibold">
            {index + 1}. {section.title}
          </h2>
          {section.edited ? (
            <span className="rounded bg-sunken px-1.5 py-0.5 text-[11px] text-muted">
              {t("documents.section.edited")}
            </span>
          ) : null}
          {section.staleKeys.length > 0 ? (
            <span className="flex items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning">
              <AlertTriangle className="size-3" />
              {t("documents.section.stale", { keys: section.staleKeys.map(decisionLabel).join("、") })}
            </span>
          ) : null}
        </div>
        {!readOnly && mode === "view" ? (
          <div className="flex gap-1 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(section.body);
                setMode("edit");
              }}
            >
              <Pencil />
              {t("documents.section.edit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setInstruction("");
                setMode("revise");
              }}
            >
              <Sparkles />
              {t("documents.section.revise")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onRegenerate}>
              <RefreshCw />
              {t("documents.section.regenerate")}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="mt-3">
        {mode === "edit" ? (
          <div className="flex flex-col gap-2">
            <Textarea
              aria-label={`${t("documents.section.edit")} ${section.title}`}
              rows={Math.min(24, Math.max(8, draft.split("\n").length + 2))}
              className="font-mono text-[13px]"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => {
                  onSave(draft);
                  setMode("view");
                }}
              >
                {t("documents.section.save")}
              </Button>
              <Button size="sm" onClick={() => setMode("view")}>
                {t("documents.section.cancel")}
              </Button>
            </div>
          </div>
        ) : working ? (
          <p className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
            <Loader2 className="size-4 animate-spin" />
            {t("documents.section.working")}
          </p>
        ) : section.body ? (
          <Markdown>{section.body}</Markdown>
        ) : (
          <p className="text-sm text-muted">{t("documents.section.empty")}</p>
        )}

        {mode === "revise" ? (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!instruction.trim()) return;
              onRevise(instruction.trim());
              setMode("view");
            }}
          >
            <Input
              autoFocus
              aria-label={`${t("documents.section.revise")} ${section.title}`}
              placeholder={t("documents.section.revisePlaceholder")}
              value={instruction}
              maxLength={2000}
              onChange={(event) => setInstruction(event.target.value)}
            />
            <Button size="md" type="submit" variant="primary" disabled={busy || !instruction.trim()}>
              {t("documents.section.reviseSubmit")}
            </Button>
            <Button size="md" onClick={() => setMode("view")}>
              {t("documents.section.cancel")}
            </Button>
          </form>
        ) : null}
      </div>
    </section>
  );
}

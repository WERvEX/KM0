import type { FolderListing } from "@km0/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, File, Folder, GitBranch, HardDrive, House } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { call, errorMessage, IpcError } from "@/lib/ipc";

export type FileBrowserMode = "folder" | "open" | "save";

export interface FileBrowserRequest {
  mode: FileBrowserMode;
  title: string;
  hint?: string;
  /** Files with these extensions are listed (open and save modes). */
  extensions?: string[];
  defaultName?: string;
  /** Remembers the last folder per key. */
  memoryKey: string;
}

interface FileBrowserDialogProps {
  request: FileBrowserRequest | null;
  onCancel: () => void;
  /** Folder and open modes: the chosen path. */
  onChoose: (path: string) => void;
  /** Save mode: resolves when saved; a conflict error asks whether to overwrite. */
  onSave: (dir: string, name: string, overwrite: boolean) => Promise<void>;
}

const MEMORY_PREFIX = "km0.files.";

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(MEMORY_PREFIX + key);
  } catch {
    return null;
  }
}

function remember(key: string, path: string): void {
  try {
    localStorage.setItem(MEMORY_PREFIX + key, path);
  } catch {
    // Remembering the folder is only a convenience.
  }
}

/** KM0's own folder and file browser, used instead of the system's open and save dialogs. */
export function FileBrowserDialog({ request, onCancel, onChoose, onSave }: FileBrowserDialogProps) {
  const { t } = useTranslation();
  const [path, setPath] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [exists, setExists] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!request) return;
    setPath(remembered(request.memoryKey));
    setSelected(null);
    setName(request.defaultName ?? "");
    setExists(false);
    setSaveError(null);
  }, [request]);

  const extensions = request && request.mode !== "folder" ? (request.extensions ?? []) : [];
  const listing = useQuery({
    queryKey: ["files.browse", path, extensions, showHidden],
    queryFn: () => call("files.browse", { path, extensions, showHidden }),
    enabled: request !== null,
    retry: false,
  });
  const data: FolderListing | undefined = listing.data;

  useEffect(() => {
    if (data) setTyped(data.path);
  }, [data]);
  // A remembered folder that no longer exists falls back to the home folder.
  useEffect(() => {
    if (listing.isError && path && request && path === remembered(request.memoryKey)) setPath(null);
  }, [listing.isError, path, request]);

  if (!request) return null;
  const go = (next: string) => {
    setSelected(null);
    setExists(false);
    setPath(next);
  };
  const current = data?.path ?? null;

  const submit = async (overwrite: boolean) => {
    if (!current) return;
    remember(request.memoryKey, current);
    if (request.mode === "folder") return onChoose(current);
    if (request.mode === "open") return selected ? onChoose(selected) : undefined;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(current, name.trim(), overwrite);
    } catch (error) {
      if (error instanceof IpcError && error.shape.kind === "conflict") setExists(true);
      else setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const primaryLabel =
    request.mode === "folder" ? t("files.useFolder") : request.mode === "open" ? t("files.open") : t("files.save");
  const primaryDisabled =
    !current ||
    listing.isFetching ||
    saving ||
    (request.mode === "open" && !selected) ||
    (request.mode === "save" && !name.trim());

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => !open && onCancel()}
      title={request.title}
      description={request.hint}
      footer={
        exists ? (
          <>
            <p className="mr-auto self-center text-sm text-warning">{t("files.exists", { name: name.trim() })}</p>
            <Button onClick={() => setExists(false)}>{t("files.cancel")}</Button>
            <Button variant="danger" disabled={saving} onClick={() => void submit(true)}>
              {t("files.overwrite")}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onCancel}>{t("files.cancel")}</Button>
            <Button variant="primary" disabled={primaryDisabled} onClick={() => void submit(false)}>
              {primaryLabel}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed.trim()) go(typed.trim());
          }}
        >
          <Button
            size="icon"
            aria-label={t("files.up")}
            title={t("files.up")}
            disabled={!data?.parent}
            onClick={() => data?.parent && go(data.parent)}
          >
            <ArrowUp />
          </Button>
          <Input
            aria-label={t("files.path")}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            spellCheck={false}
            className="font-mono text-xs"
          />
          <Button type="submit" size="sm" className="h-9">
            {t("files.go")}
          </Button>
        </form>

        <div className="flex min-h-0 gap-3">
          <nav aria-label={t("files.places")} className="flex w-36 shrink-0 flex-col gap-0.5">
            {(data?.places ?? []).map((place) => (
              <button
                key={place.path}
                type="button"
                title={place.path}
                className={cn(
                  "flex items-center gap-2 truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-sunken",
                  current === place.path && "bg-sunken font-medium",
                )}
                onClick={() => go(place.path)}
              >
                {place.id === "home" ? (
                  <House className="size-3.5 shrink-0 text-muted" />
                ) : place.id === "drive" || place.id === "volume" || place.id === "root" ? (
                  <HardDrive className="size-3.5 shrink-0 text-muted" />
                ) : (
                  <Folder className="size-3.5 shrink-0 text-muted" />
                )}
                <span className="truncate">
                  {place.id in placeKeys ? t(placeKeys[place.id as keyof typeof placeKeys]) : place.label}
                </span>
              </button>
            ))}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <ul
              aria-label={current ?? t("files.loading")}
              className="h-72 overflow-y-auto rounded-md border border-border bg-bg p-1"
            >
              {listing.isError ? (
                <li className="px-2 py-1.5 text-sm text-danger">{errorMessage(listing.error)}</li>
              ) : !data ? (
                <li className="px-2 py-1.5 text-sm text-muted">{t("files.loading")}</li>
              ) : data.entries.length === 0 ? (
                <li className="px-2 py-1.5 text-sm text-muted">
                  {request.mode === "folder" ? t("files.empty") : t("files.emptyFiles")}
                </li>
              ) : (
                data.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-sunken",
                        selected === entry.path && "bg-accent/10 font-medium",
                      )}
                      onClick={() => {
                        if (entry.dir) go(entry.path);
                        else if (request.mode === "save") setName(entry.name);
                        else setSelected(entry.path);
                      }}
                      onDoubleClick={() => {
                        if (!entry.dir && request.mode === "open") onChoose(entry.path);
                      }}
                    >
                      {entry.dir ? (
                        <Folder className="size-4 shrink-0 text-accent" />
                      ) : (
                        <File className="size-4 shrink-0 text-muted" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      {entry.git ? (
                        <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
                          <GitBranch className="size-3" />
                          {t("files.git")}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))
              )}
            </ul>
            {data?.truncated ? (
              <p className="text-xs text-muted">{t("files.truncated", { count: data.entries.length })}</p>
            ) : null}
            <label className="flex w-fit items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />
              {t("files.showHidden")}
            </label>
          </div>
        </div>

        {request.mode === "save" ? (
          <div className="flex items-center gap-2">
            <label htmlFor="km0-save-name" className="shrink-0 text-xs font-medium text-muted">
              {t("files.fileName")}
            </label>
            <Input
              id="km0-save-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setExists(false);
              }}
              spellCheck={false}
            />
          </div>
        ) : null}
        {saveError ? <p className="text-sm text-danger">{saveError}</p> : null}
      </div>
    </Dialog>
  );
}

const placeKeys = {
  home: "files.place.home",
  desktop: "files.place.desktop",
  documents: "files.place.documents",
  downloads: "files.place.downloads",
  root: "files.place.root",
} as const;

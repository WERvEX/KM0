import type { DocumentKind, DocumentView, IpcChannel, IpcInput } from "@km0/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { call, errorMessage, IpcError } from "@/lib/ipc";
import { projectKey } from "../project/useProject";

export const documentKey = (projectId: number, kind: DocumentKind, version: number | null = null) =>
  ["document.get", projectId, kind, version ?? "latest"] as const;

export function useDocument(projectId: number, kind: DocumentKind, version: number | null) {
  return useQuery({
    queryKey: documentKey(projectId, kind, version),
    queryFn: () => call("document.get", { projectId, kind, ...(version ? { version } : {}) }),
  });
}

/** Text streamed so far per document; a kind is present only while it is being generated. */
export function useDocumentStreams(projectId: number): Partial<Record<DocumentKind, string>> {
  const [streams, setStreams] = useState<Partial<Record<DocumentKind, string>>>({});
  useEffect(() => {
    // Component tests run without the bridge.
    if (!window.km0?.on) return;
    return window.km0.on("document.progress", ({ projectId: id, kind, phase, delta }) => {
      if (id !== projectId) return;
      setStreams((previous) => {
        if (phase === "done") {
          const { [kind]: _finished, ...rest } = previous;
          return rest;
        }
        return { ...previous, [kind]: phase === "start" ? "" : (previous[kind] ?? "") + delta };
      });
    });
  }, [projectId]);
  return streams;
}

type DocumentChannel = Extract<
  IpcChannel,
  "document.generate" | "document.saveSection" | "document.revise" | "document.restore"
>;

export interface DocumentActions {
  /** Which document is busy with what, e.g. "generate" or "revise:functional". */
  pending: Partial<Record<DocumentKind, string>>;
  errors: Partial<Record<DocumentKind, string>>;
  run<C extends DocumentChannel>(channel: C, input: IpcInput<C>, label: string): Promise<DocumentView | null>;
  generate(kind: DocumentKind, keepEdited?: boolean): Promise<DocumentView | null>;
}

/**
 * Document calls tracked per kind, so the PRD and the technical design can be written side by side.
 * Every result lands in the document cache, and the project is refetched for its stale counts.
 */
export function useDocumentActions(projectId: number): DocumentActions {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Partial<Record<DocumentKind, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<DocumentKind, string>>>({});

  const run = useCallback(
    async <C extends DocumentChannel>(channel: C, input: IpcInput<C>, label: string) => {
      const kind = (input as { kind: DocumentKind }).kind;
      setPending((previous) => ({ ...previous, [kind]: label }));
      setErrors(({ [kind]: _cleared, ...rest }) => rest);
      try {
        const view = (await call(channel, input)) as DocumentView;
        queryClient.setQueryData(documentKey(projectId, kind), view);
        return view;
      } catch (error) {
        setErrors((previous) => ({ ...previous, [kind]: errorMessage(error) }));
        // A conflict means our copy was outdated.
        if (error instanceof IpcError && error.shape.kind === "conflict") {
          void queryClient.invalidateQueries({ queryKey: ["document.get", projectId, kind] });
        }
        return null;
      } finally {
        setPending(({ [kind]: _done, ...rest }) => rest);
        void queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
      }
    },
    [projectId, queryClient],
  );

  const generate = useCallback(
    (kind: DocumentKind, keepEdited = false) => run("document.generate", { projectId, kind, keepEdited }, "generate"),
    [projectId, run],
  );

  return { pending, errors, run, generate };
}

import type { EmitEvent, FolderAnswer, FolderRequest } from "@km0/shared";

/**
 * Lets main-process services ask for a folder without a system dialog: the window gets a
 * `folder.request` event, shows KM0's own folder browser, and answers with `folder.answer`.
 * Only one request is open at a time; a new one, or the window going away, cancels the last.
 */
export class FolderRequests {
  private pending: { id: string; resolve: (path: string | null) => void } | null = null;
  private counter = 0;

  constructor(private readonly emit: EmitEvent) {}

  ask(purpose: FolderRequest["purpose"]): Promise<string | null> {
    this.cancel();
    this.counter += 1;
    const id = `folder-${Date.now()}-${this.counter}`;
    return new Promise((resolve) => {
      this.pending = { id, resolve };
      this.emit("folder.request", { requestId: id, purpose });
    });
  }

  answer({ requestId, path }: FolderAnswer): void {
    if (this.pending?.id !== requestId) return;
    const { resolve } = this.pending;
    this.pending = null;
    resolve(path);
  }

  /** Resolve the open request, if any, as cancelled. */
  cancel(): void {
    if (!this.pending) return;
    const { resolve } = this.pending;
    this.pending = null;
    resolve(null);
  }
}

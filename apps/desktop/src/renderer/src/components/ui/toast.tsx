import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

export interface ToastInput {
  kind?: "info" | "success" | "error";
  message: string;
  action?: { label: string; onClick: () => void };
  /** Milliseconds before it goes away; errors stay until dismissed. */
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

/** Short messages at the bottom right of the window: KM0's replacement for system notifications and alerts. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((toast) => toast.id !== id)), []);
  const show = useCallback(
    (toast: ToastInput) => {
      const id = next.current++;
      // Keep the latest few; older ones scroll away.
      setToasts((all) => [...all.slice(-3), { ...toast, id }]);
      const duration = toast.duration ?? (toast.kind === "error" ? null : 6000);
      if (duration) setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );
  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((toast) => {
          const Icon = toast.kind === "error" ? CircleAlert : toast.kind === "success" ? CircleCheck : Info;
          return (
            <div
              key={toast.id}
              role={toast.kind === "error" ? "alert" : "status"}
              className={cn(
                "pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-panel px-3.5 py-3 text-sm shadow-lg",
                toast.kind === "error" ? "border-danger/40" : "border-border",
              )}
            >
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  toast.kind === "error" ? "text-danger" : toast.kind === "success" ? "text-success" : "text-accent",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="break-words">{toast.message}</p>
                {toast.action ? (
                  <button
                    type="button"
                    className="mt-1 text-sm font-medium text-accent hover:underline"
                    onClick={() => {
                      toast.action?.onClick();
                      dismiss(toast.id);
                    }}
                  >
                    {toast.action.label}
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                className="rounded p-0.5 text-muted hover:bg-sunken hover:text-fg"
                aria-label={t("toast.close")}
                onClick={() => dismiss(toast.id)}
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (toast: ToastInput) => void {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast needs a ToastProvider");
  return show;
}

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  closeLabel: string;
  children: ReactNode;
}

/** A panel that slides over the right edge, for side content that does not fit beside the page. */
export function Sheet({ open, onOpenChange, title, closeLabel, children }: SheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-black/30" />
        <DialogPrimitive.Content className="fixed top-0 right-0 bottom-0 flex w-96 max-w-[90vw] flex-col border-l border-border bg-bg shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <DialogPrimitive.Title className="text-sm font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            <DialogPrimitive.Close
              className="rounded p-1 text-muted hover:bg-sunken hover:text-fg"
              aria-label={closeLabel}
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

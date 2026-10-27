import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import "./styles.css";
import { PreferenceSync } from "./components/PreferenceSync";
import { ToastProvider } from "./components/ui/toast";
import { FileDialogProvider } from "./lib/files";
import { router } from "./router";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <FileDialogProvider>
          <PreferenceSync />
          <RouterProvider router={router} />
        </FileDialogProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);

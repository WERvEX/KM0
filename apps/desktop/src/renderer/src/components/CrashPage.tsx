import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { CircleAlert, House, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/ipc";

/** Shown in place of a page that threw while rendering. */
export function CrashPage({ error, reset }: ErrorComponentProps) {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <div role="alert" className="mx-auto flex max-w-xl flex-col gap-4 px-8 py-16">
      <CircleAlert className="size-8 text-danger" />
      <h1 className="text-xl font-semibold">{t("crash.title")}</h1>
      <p className="text-muted">{t("crash.body")}</p>
      <pre className="overflow-x-auto rounded-md bg-sunken px-3 py-2 text-xs whitespace-pre-wrap">
        {errorMessage(error)}
      </pre>
      <div className="flex gap-2">
        <Button
          onClick={() => {
            reset();
            void router.navigate({ to: "/" });
          }}
        >
          <House />
          {t("crash.home")}
        </Button>
        <Button variant="primary" onClick={() => window.location.reload()}>
          <RotateCw />
          {t("crash.reload")}
        </Button>
      </div>
    </div>
  );
}

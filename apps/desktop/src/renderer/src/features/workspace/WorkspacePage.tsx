import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { useIpcQuery } from "@/lib/queries";

export function WorkspacePage() {
  const { t } = useTranslation();
  const roles = useIpcQuery("settings.roles.get");
  const hasModel = roles.data?.router != null;
  const steps = ["triage", "discuss", "route", "handoff"] as const;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 px-8 py-16">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("workspace.title")}</h1>
        <p className="mt-2 text-muted">{t("workspace.subtitle")}</p>
      </header>

      <section className="rounded-lg border border-border bg-panel p-4">
        <Textarea aria-label={t("workspace.title")} placeholder={t("workspace.placeholder")} disabled rows={4} />
        <div className="mt-3 flex items-center justify-between gap-4">
          <p className="text-sm text-muted">{hasModel ? t("workspace.comingSoon") : t("workspace.needModel")}</p>
          {hasModel ? (
            <Button variant="primary" disabled>
              {t("workspace.submit")}
            </Button>
          ) : (
            <Button asChild variant="primary">
              <Link to="/settings">
                {t("workspace.configureModel")}
                <ArrowRight />
              </Link>
            </Button>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">{t("workspace.stepsTitle")}</h2>
        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <li key={step} className="flex gap-3 text-sm">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-xs font-medium">
                {index + 1}
              </span>
              <span className="pt-0.5">{t(`workspace.steps.${step}`)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

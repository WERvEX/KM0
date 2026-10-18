import { ConfigBundle, type ImportSummary, type Language, type Theme } from "@km0/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { call, errorMessage } from "@/lib/ipc";
import { useIpcMutation, useIpcQuery } from "@/lib/queries";
import { AgentsTab } from "./AgentsTab";
import { ModelsTab } from "./ModelsTab";
import { SearchTab } from "./SearchTab";

type Tab = "models" | "agents" | "search" | "general" | "about";

export function SettingsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("models");
  const tabs: Tab[] = ["models", "agents", "search", "general", "about"];

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="text-xl font-semibold">{t("settings.title")}</h1>
      <div role="tablist" className="mt-6 mb-6 flex gap-1 border-b border-border">
        {tabs.map((item) => (
          <button
            key={item}
            role="tab"
            type="button"
            aria-selected={tab === item}
            onClick={() => setTab(item)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              tab === item ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {t(`settings.tabs.${item}`)}
          </button>
        ))}
      </div>
      {tab === "models" ? (
        <ModelsTab />
      ) : tab === "agents" ? (
        <AgentsTab />
      ) : tab === "search" ? (
        <SearchTab />
      ) : tab === "general" ? (
        <GeneralTab />
      ) : (
        <AboutTab />
      )}
    </div>
  );
}

function GeneralTab() {
  const { t } = useTranslation();
  const preferences = useIpcQuery("settings.preferences.get");
  const save = useIpcMutation("settings.preferences.set", ["settings.preferences.get"]);
  if (!preferences.data) return null;

  return (
    <div className="flex flex-col gap-8">
      <div className="grid max-w-sm gap-4">
        <Field label={t("settings.general.language")} htmlFor="language">
          <Select
            id="language"
            value={preferences.data.language}
            onChange={(event) => save.mutate({ language: event.target.value as Language })}
          >
            <option value="system">{t("settings.general.languageSystem")}</option>
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
          </Select>
        </Field>
        <Field label={t("settings.general.theme")} htmlFor="theme">
          <Select
            id="theme"
            value={preferences.data.theme}
            onChange={(event) => save.mutate({ theme: event.target.value as Theme })}
          >
            <option value="system">{t("settings.general.themeSystem")}</option>
            <option value="light">{t("settings.general.themeLight")}</option>
            <option value="dark">{t("settings.general.themeDark")}</option>
          </Select>
        </Field>
      </div>
      <ConfigSection />
    </div>
  );
}

/** Export everything in Settings to a JSON file, or merge one in. */
function ConfigSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const exportConfig = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const bundle = await call("settings.export", { includeSecrets });
      const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `km0-config-${bundle.exportedAt.slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) {
      setMessage({ ok: false, text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const importConfig = async (file: File) => {
    setBusy(true);
    setMessage(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        parsed = null;
      }
      const bundle = ConfigBundle.safeParse(parsed);
      if (!bundle.success) {
        setMessage({ ok: false, text: t("settings.general.config.invalid") });
        return;
      }
      const summary: ImportSummary = await call("settings.import", bundle.data);
      await queryClient.invalidateQueries();
      setMessage({ ok: true, text: t("settings.general.config.imported", summary) });
    } catch (error) {
      setMessage({ ok: false, text: errorMessage(error) });
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-semibold">{t("settings.general.config.title")}</h2>
      <p className="text-sm text-muted">{t("settings.general.config.body")}</p>
      <label className="flex w-fit items-center gap-2 text-sm">
        <input type="checkbox" checked={includeSecrets} onChange={(event) => setIncludeSecrets(event.target.checked)} />
        {t("settings.general.config.includeSecrets")}
      </label>
      {includeSecrets ? (
        <p className="text-xs text-warning">{t("settings.general.config.includeSecretsHint")}</p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void exportConfig()} disabled={busy}>
          <Download />
          {t("settings.general.config.export")}
        </Button>
        <Button size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
          <Upload />
          {t("settings.general.config.import")}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-label={t("settings.general.config.import")}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importConfig(file);
          }}
        />
      </div>
      {message ? (
        <p role="status" className={`text-sm ${message.ok ? "text-success" : "text-danger"}`}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}

function AboutTab() {
  const { t } = useTranslation();
  const info = useIpcQuery("app.info");
  if (!info.data) return null;
  const rows: [string, string][] = [
    [t("settings.about.version"), `${info.data.name} ${info.data.version} (${info.data.platform})`],
    [t("settings.about.dataDir"), info.data.dataDir],
    [
      t("settings.about.secureStorage"),
      info.data.secureStorage ? t("settings.about.secureOn") : t("settings.about.secureOff"),
    ],
  ];
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

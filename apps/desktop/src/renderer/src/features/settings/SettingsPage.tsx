import type { Language, Theme } from "@km0/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Field, Select } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { useIpcMutation, useIpcQuery } from "@/lib/queries";
import { ModelsTab } from "./ModelsTab";

type Tab = "models" | "general" | "about";

export function SettingsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("models");
  const tabs: Tab[] = ["models", "general", "about"];

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
      {tab === "models" ? <ModelsTab /> : tab === "general" ? <GeneralTab /> : <AboutTab />}
    </div>
  );
}

function GeneralTab() {
  const { t } = useTranslation();
  const preferences = useIpcQuery("settings.preferences.get");
  const save = useIpcMutation("settings.preferences.set", ["settings.preferences.get"]);
  if (!preferences.data) return null;

  return (
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

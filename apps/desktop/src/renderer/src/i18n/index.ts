import type { Language } from "@km0/shared";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./en";
import { zhCN } from "./zh-CN";

export function resolveLanguage(language: Language): "zh-CN" | "en" {
  if (language !== "system") return language;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { "zh-CN": { translation: zhCN }, en: { translation: en } },
  lng: resolveLanguage("system"),
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
});

export default i18n;

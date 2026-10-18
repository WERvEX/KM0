import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { resolveLanguage } from "@/i18n";
import { useIpcQuery } from "@/lib/queries";

/** Applies the saved language and theme to the document. */
export function PreferenceSync() {
  const { i18n } = useTranslation();
  const preferences = useIpcQuery("settings.preferences.get");
  const language = preferences.data?.language ?? "system";
  const theme = preferences.data?.theme ?? "system";

  useEffect(() => {
    const resolved = resolveLanguage(language);
    if (i18n.language !== resolved) void i18n.changeLanguage(resolved);
    document.documentElement.lang = resolved;
  }, [i18n, language]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  return null;
}

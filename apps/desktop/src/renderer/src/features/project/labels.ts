import { keyDef } from "@km0/core/catalog";
import i18n from "@/i18n";

export function decisionLabel(key: string): string {
  const def = keyDef(key);
  if (!def) return key;
  return i18n.language === "en" ? def.label.en : def.label["zh-CN"];
}

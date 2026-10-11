import { en } from "./en";
import { zhCN } from "./zh-CN";
import type { LocaleStrings } from "./types";

export type LocaleCode = "en" | "zh-CN";
const bundles: Record<LocaleCode, LocaleStrings> = { en, "zh-CN": zhCN };
let active: LocaleCode = "zh-CN";

/** Maps Obsidian's documented language code, including its Chinese aliases. */
export function pickLocaleFromObsidian(locale: string | undefined): LocaleCode {
  const normalized = locale?.replace(/_/g, "-").toLowerCase();
  return normalized === "zh" || normalized === "zh-cn" || normalized?.startsWith("zh-") ? "zh-CN" : "en";
}

export function setLocale(locale: LocaleCode): void { active = locale; }

export function t(key: string, args?: Record<string, string | number>): string {
  const lookup = (bundle: LocaleStrings): string | undefined => key.split(".").reduce<unknown>((current, part) => current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined, bundle) as string | undefined;
  const value = lookup(bundles[active]) ?? lookup(en) ?? key;
  return args ? value.replace(/\{(\w+)\}/g, (match, name: string) => args[name] === undefined ? match : String(args[name])) : value;
}

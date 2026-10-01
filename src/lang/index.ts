import type { LocaleStrings } from "./types";
import { en } from "./en";
import { zhCN } from "./zh-CN";

/**
 * The plugin's runtime locale system.
 *
 * Inspired by Obsidian Tasks, Spaced Repetition, and Calendar — each ships a `locales/`
 * directory keyed by ISO codes, with TypeScript-strict bundles so missing keys fail at
 * compile time. We follow the same shape but co-locate the strings with the code, and
 * prefer the simpler function call form over a tagged template.
 *
 * Behaviour:
 * - `setLocale(code)` sets the active bundle. Default is `detectLocale()` which reads
 *    `moment.locale()` (Obsidian uses moment for its language setting, and `moment.locale()`
 *    returns the user's current language).
 * - `t("notice.hotConflict", { path, reason })` walks the dotted key, applies the
 *    active locale, and substitutes `{placeholder}` patterns. A missing key falls back to
 *    English, and an English entry returns the original key if both are missing — so a
 *    developer who adds a string only to one locale will not produce a TypeError at runtime.
 * - `subscribeLocale(listener)` lets the settings tab refresh itself when the active
 *    locale changes (currently no-op for this plugin — the user picks through Obsidian's
 *    own setting — but exposed so the architecture is ready).
 *
 * The default is `zh-CN` because the plugin's primary audience is Chinese-speaking and the
 * source-of-truth copy in many places is already in Chinese. `en` is a full back-translation
 * so non-Chinese users do not get empty notices.
 */
export type LocaleCode = "en" | "zh-CN";

/** The full path of the active bundle. */
export const SUPPORTED_LOCALES: readonly LocaleCode[] = ["en", "zh-CN"] as const;

const bundles: Record<LocaleCode, LocaleStrings> = {
  "en": en,
  "zh-CN": zhCN,
};

const DEFAULT_LOCALE: LocaleCode = "zh-CN";

let active: LocaleCode = DEFAULT_LOCALE;

/**
 * Maps a moment-style locale string (e.g. `zh-cn`, `en`, `fr`) to one of the supported bundles.
 *
 * Anything starting with `zh` becomes `zh-CN`; everything else falls back to `en`. This is the
 * mapping the plugin calls at startup after reading `moment.locale()`; tests inject a code
 * directly via `setLocale`.
 */
export function pickLocaleFromMoment(momentLocale: string | undefined): LocaleCode {
  if (!momentLocale) return DEFAULT_LOCALE;
  const normalised = momentLocale.toLowerCase();
  if (normalised.startsWith("zh")) return "zh-CN";
  return "en";
}

/**
 * Sets the active locale. Returns whether the change actually flipped the bundle.
 *
 * Invalid codes are silently ignored — the active locale stays. A no-op return signals "the
 * caller should not refresh the UI".
 */
export function setLocale(code: LocaleCode): boolean {
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(code)) return false;
  if (code === active) return false;
  active = code;
  return true;
}

/** The currently active locale. */
export function getLocale(): LocaleCode {
  return active;
}

/**
 * Resolves a dotted key from the active bundle, then English, then returns the key itself.
 *
 * `args` substitutes `{placeholder}` patterns. Unknown placeholders are left in place.
 */
export function t(key: string, args?: Record<string, string | number>): string {
  const resolved = resolve(key, active) ?? resolve(key, "en");
  if (resolved === undefined) return key;
  if (!args) return resolved;
  return resolved.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = args[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Walks a dotted key against the bundle. Returns `undefined` if any segment is missing.
 */
function resolve(key: string, code: LocaleCode): string | undefined {
  const segments = key.split(".");
  let current: unknown = bundles[code];
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" ? current : undefined;
}

export type { LocaleStrings };
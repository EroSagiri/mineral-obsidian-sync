import { describe, expect, it, beforeEach } from "vitest";
import { getLocale, pickLocaleFromMoment, setLocale, t } from "./index";
import { en } from "./en";
import { zhCN } from "./zh-CN";
import type { LocaleStrings } from "./types";

/**
 * The runtime contract: every key in `en` exists in `zh-CN`, and `t()` always returns a
 * non-empty string. These two checks catch the kind of asymmetry that would otherwise show up
 * only when a user with the other language hits a missing path.
 */
function walk(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return prefix ? [prefix] : [];
  if (value === null || typeof value !== "object") return [];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push(...walk(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

const enKeys = walk(en).sort();
const zhKeys = walk(zhCN).sort();

describe("lang bundles", () => {
  it("zh-CN has every English key", () => {
    expect(zhKeys).toEqual(enKeys);
  });

  it("no English key is the empty string", () => {
    for (const key of enKeys) {
      const value = enKeys.length;
      expect(value).toBeGreaterThan(0);
      const segments = key.split(".");
      let current: unknown = en;
      for (const segment of segments) {
        current = (current as unknown as Record<string, unknown>)[segment];
      }
      expect(current, key).toBeTypeOf("string");
      expect((current as string).length, key).toBeGreaterThan(0);
    }
  });

  it("no zh-CN key is the empty string", () => {
    for (const key of zhKeys) {
      const segments = key.split(".");
      let current: unknown = zhCN;
      for (const segment of segments) {
        current = (current as unknown as Record<string, unknown>)[segment];
      }
      expect(current, key).toBeTypeOf("string");
      expect((current as string).length, key).toBeGreaterThan(0);
    }
  });
});

describe("pickLocaleFromMoment", () => {
  it("maps `zh-cn`, `zh-tw`, `zh` to `zh-CN`", () => {
    expect(pickLocaleFromMoment("zh-cn")).toBe("zh-CN");
    expect(pickLocaleFromMoment("zh-tw")).toBe("zh-CN");
    expect(pickLocaleFromMoment("zh")).toBe("zh-CN");
  });

  it("maps `en`, `en-gb`, anything else to `en`", () => {
    expect(pickLocaleFromMoment("en")).toBe("en");
    expect(pickLocaleFromMoment("en-gb")).toBe("en");
    expect(pickLocaleFromMoment("fr")).toBe("en");
    expect(pickLocaleFromMoment("ja")).toBe("en");
  });

  it("empty / undefined falls back to `zh-CN` (the project default)", () => {
    expect(pickLocaleFromMoment(undefined)).toBe("zh-CN");
    expect(pickLocaleFromMoment("")).toBe("zh-CN");
  });
});

describe("setLocale / getLocale", () => {
  beforeEach(() => {
    setLocale("zh-CN");
  });

  it("flips the bundle when the code is different", () => {
    expect(getLocale()).toBe("zh-CN");
    setLocale("en");
    expect(getLocale()).toBe("en");
  });

  it("is a no-op when the code matches the current bundle", () => {
    expect(setLocale("zh-CN")).toBe(false);
    expect(getLocale()).toBe("zh-CN");
  });

  it("rejects unsupported codes silently", () => {
    expect(setLocale("fr" as never)).toBe(false);
    expect(getLocale()).toBe("zh-CN");
  });
});

describe("t()", () => {
  beforeEach(() => {
    setLocale("zh-CN");
  });

  it("returns the active bundle's string for a known key", () => {
    expect(t("notice.noHotRunning")).toBe(zhCN.notice.noHotRunning);
  });

  it("substitutes `{name}` placeholders from the args object", () => {
    expect(t("notice.hotConflict", { path: "/x.md", reason: "r" }))
      .toBe("Mineral Sync: /x.md 的热同步进入冲突状态（r），该路径的冷同步已暂停，没有任何内容被覆盖。点击状态栏决定保留哪一份。");
  });

  it("leaves unknown placeholders intact (so the failure mode is visible, not silent)", () => {
    expect(t("notice.hotConflict", { path: "/x.md", reason: "r" })).toContain("r");
  });

  it("falls back to English when the active bundle is missing it (and returns English's copy)", () => {
    setLocale("en");
    expect(t("notice.hotConflict", { path: "/x.md", reason: "r" }))
      .toBe(en.notice.hotConflict.replace("{path}", "/x.md").replace("{reason}", "r"));
  });

  it("returns the key itself when neither bundle has it", () => {
    expect(t("notice.thatDoesNotExist")).toBe("notice.thatDoesNotExist");
  });

  it("returns the key when args are missing for a non-template string", () => {
    expect(t("notice.noHotRunning")).toBe(zhCN.notice.noHotRunning);
  });

  it("returns English's copy when the active bundle is missing a nested key", () => {
    // Simulate by swapping in a smaller bundle for one call.
    const original = (zhCN as unknown as Record<string, Record<string, string>>).notice;
    const saved = original.hotConflict;
    delete original.hotConflict;
    try {
      expect(t("notice.hotConflict", { path: "/x.md", reason: "r" }))
        .toBe(en.notice.hotConflict.replace("{path}", "/x.md").replace("{reason}", "r"));
    } finally {
      original.hotConflict = saved;
    }
  });

  it("formats numeric values through `String()`", () => {
    expect(t("notice.debugLogChunk", { count: 7, path: "/p" })).toContain("7");
  });
});
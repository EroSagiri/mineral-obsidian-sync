import { describe, expect, it } from "vitest";
import { pickLocaleFromMoment, setLocale, t } from ".";

describe("cold sync localization", () => {
  it("defaults Chinese Obsidian locales to Chinese and falls back to English", () => {
    setLocale(pickLocaleFromMoment("zh-cn"));
    expect(t("settings.inspect")).toBe("检查同步状态");
    setLocale(pickLocaleFromMoment("en"));
    expect(t("settings.inspect")).toBe("Inspect Sync State");
  });

  it("substitutes values in localized messages", () => {
    setLocale("zh-CN");
    expect(t("status.conflicts", { count: 2 })).toBe("2 个冲突需要处理");
  });
});

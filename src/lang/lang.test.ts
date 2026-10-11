import { describe, expect, it } from "vitest";
import { pickLocaleFromObsidian, setLocale, t } from ".";

describe("cold sync localization", () => {
  it("defaults Chinese Obsidian locales to Chinese and falls back to English", () => {
    setLocale(pickLocaleFromObsidian("zh_cn"));
    expect(t("settings.inspect")).toBe("检查同步状态");
    setLocale(pickLocaleFromObsidian("en"));
    expect(t("settings.inspect")).toBe("Inspect Sync State");
  });

  it("substitutes values in localized messages", () => {
    setLocale("zh-CN");
    expect(t("status.conflicts", { count: 2 })).toBe("2 个冲突需要处理");
  });
});

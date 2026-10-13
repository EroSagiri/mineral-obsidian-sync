import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform, type App } from "obsidian";
import { RecoveryStore, DELETE_RISK } from "@mineral/sync-core/recovery";
import { RecoveryCenter, RecoveryConfirmation } from "./recovery-center";
import { FakeElement, flush, installModalContainer } from "../../test/dom";
import { RecoveryMemory } from "../../test/recovery-memory";
afterEach(() => { vi.restoreAllMocks(); Platform.isAndroidApp = false; Platform.isMobile = false; });
for (const android of [false, true]) describe(android ? "Android recovery UI" : "Windows recovery UI", () => {
  async function setup() {
    Platform.isAndroidApp = android; Platform.isMobile = android;
    const port = new RecoveryMemory(() => new Date("2020-01-01T00:00:00Z"));
    await port.put("note.md", new TextEncoder().encode("# R2 preview"), null);
    const store = new RecoveryStore(port, "namespace", () => new Date("2020-01-01T00:00:00Z"));
    await store.backup("note.md", "e1");
    const submit = vi.fn(async () => {});
    const modal = new RecoveryCenter({} as App, { identity: "namespace", list: () => store.list(), preview: entry => store.preview({ key: entry.key, etag: entry.etag, path: entry.path, versionId: entry.manifest!.version_id }), target: path => store.observeTarget(path), submit });
    const root = new FakeElement("div"); installModalContainer(modal, root); modal.onOpen(); await flush();
    return { modal, root, submit };
  }
  it("shows direct R2 source, time, size, reason, cleanup tools and local mirror instructions", async () => {
    const { root } = await setup();
    for (const text of ["全局恢复中心", "直接来自 R2", "note.md", "2020-01-01", "backup", "本地遗留镜像"]) expect(root.allText).toContain(text);
    for (const button of ["刷新 R2", "按路径清理历史版本", "按年龄批量清理", "清空恢复中心", "查看与恢复"]) expect(root.button(button)).toBeDefined();
  });
  it("previews Markdown and exposes new name, cancel, explicit overwrite", async () => {
    const { root, submit } = await setup(); root.button("查看与恢复")!.click(); await flush();
    expect(root.allText).toContain("# R2 preview");
    for (const label of ["恢复", "新名称", "取消", "明确覆盖"]) expect(root.button(label)).toBeDefined();
    root.button("恢复")!.click(); await flush(); expect(submit).not.toHaveBeenCalled();
    root.button("新名称")!.click(); root.button("恢复")!.click(); await flush();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ action: "restore", identity: "namespace", confirmed: true, expectedTargetETag: null, selection: expect.objectContaining({ versionId: expect.any(String), etag: expect.any(String), path: "note.md" }) }));
  });
  it("age cleanup and empty-center confirmation submit only listed version identities", async () => {
    for (const label of ["按年龄批量清理", "清空恢复中心"]) {
      const { root, submit } = await setup(); const confirmRoot = new FakeElement("div");
      vi.spyOn(RecoveryConfirmation.prototype, "open").mockImplementation(function(this: RecoveryConfirmation) { installModalContainer(this, confirmRoot); this.onOpen(); });
      root.button(label)!.click(); await flush(); expect(submit).not.toHaveBeenCalled();
      confirmRoot.button("确认真实删除")!.click(); await flush();
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ action: "clean", selections: [expect.objectContaining({ path: "note.md", versionId: expect.any(String) })] }));
      vi.restoreAllMocks();
    }
  });
  it("notification refresh preserves a selected preview instead of resetting its restore buttons", async () => {
    const { modal, root } = await setup(); root.button("查看与恢复")!.click(); await flush();
    await modal.refresh(); expect(root.allText).toContain("# R2 preview"); expect(root.button("恢复")).toBeDefined();
  });
  it("shows pending cleanup until R2 finishes, blocks repeated clicks and retains the result", async () => {
    const { modal, root, submit } = await setup();
    let complete!: () => void;
    submit.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const confirmRoot = new FakeElement("div");
    vi.spyOn(RecoveryConfirmation.prototype, "open").mockImplementation(function(this: RecoveryConfirmation) { installModalContainer(this, confirmRoot); this.onOpen(); });
    root.button("清空恢复中心")!.click(); await flush();
    confirmRoot.button("确认真实删除")!.click(); await flush();
    expect(root.allText).toContain("正在清理 R2");
    expect(root.allText).toContain("共 1 项");
    expect(root.allText).toContain("已等待 0 秒");
    expect(root.button("清空恢复中心")).toBeUndefined();
    await modal.refresh(); expect(submit).toHaveBeenCalledTimes(1);
    complete(); await flush();
    expect(root.allText).toContain("R2 操作已完成");
    expect(root.button("清空恢复中心")).toBeDefined();
  });
  it("retains cleanup failure in the refreshed UI", async () => {
    const { root, submit } = await setup();
    submit.mockRejectedValueOnce(new Error("ETag changed"));
    const confirmRoot = new FakeElement("div");
    vi.spyOn(RecoveryConfirmation.prototype, "open").mockImplementation(function(this: RecoveryConfirmation) { installModalContainer(this, confirmRoot); this.onOpen(); });
    root.button("清空恢复中心")!.click(); await flush();
    confirmRoot.button("确认真实删除")!.click(); await flush();
    expect(root.allText).toContain("操作未全部完成");
    expect(root.allText).toContain("ETag changed");
    expect(root.allText).not.toContain("R2 操作已完成");
  });
  it("requires confirmation with accepted race disclosure for real cleanup and binds ETag", async () => {
    const { root, submit } = await setup(); let confirmation: RecoveryConfirmation | undefined;
    const confirmRoot = new FakeElement("div");
    vi.spyOn(RecoveryConfirmation.prototype, "open").mockImplementation(function(this: RecoveryConfirmation) { confirmation = this; installModalContainer(this, confirmRoot); this.onOpen(); });
    root.button("删除版本")!.click(); await flush();
    expect(submit).not.toHaveBeenCalled(); expect(confirmRoot.allText).toContain(DELETE_RISK);
    confirmRoot.button("取消")!.click(); await flush(); expect(submit).not.toHaveBeenCalled();
    root.button("删除版本")!.click(); await flush(); expect(confirmation).toBeDefined();
    confirmRoot.button("确认真实删除")!.click(); await flush();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ action: "clean", confirmed: true, selections: [expect.objectContaining({ key: expect.stringContaining(".mineral/versions/"), etag: expect.any(String) })] }));
  });
});

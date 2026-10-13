import { Component, MarkdownRenderer, Modal, Notice, type App } from "obsidian";
import { DELETE_RISK, recoverySelection, type RecoveryEntry, type RecoveryIntent, type RecoveryObject } from "@mineral/sync-core/recovery";

export interface RecoveryUI {
  identity: string;
  list(): Promise<RecoveryEntry[]>;
  preview(entry: RecoveryEntry): Promise<Uint8Array>;
  target(path: string): Promise<RecoveryObject | null>;
  submit(intent: RecoveryIntent): Promise<void>;
}
export class RecoveryConfirmation extends Modal {
  private resolved = false;
  constructor(app: App, private readonly title: string, private readonly description: string, private readonly resolve: (accepted: boolean) => void) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.title });
    this.contentEl.createEl("p", { text: this.description });
    this.contentEl.createEl("p", { text: DELETE_RISK, cls: "mineral-recovery-risk" });
    const buttons = this.contentEl.createDiv({ cls: "mineral-recovery-actions" });
    buttons.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    buttons.createEl("button", { text: "确认真实删除", cls: "mod-warning" }).addEventListener("click", () => { this.resolved = true; this.resolve(true); this.close(); });
  }
  onClose(): void { if (!this.resolved) { this.resolved = true; this.resolve(false); } this.contentEl.empty(); }
}
export function confirmPhysicalDelete(app: App, description: string): Promise<boolean> {
  return new Promise(resolve => new RecoveryConfirmation(app, "真实 R2 删除确认", description, resolve).open());
}

/** One responsive Obsidian modal for Windows and Android. Only read functions and bound intents. */
export class RecoveryCenter extends Modal {
  private entries: RecoveryEntry[] = [];
  private busy = false;
  private alive = false;
  private selected?: RecoveryEntry;
  private component = new Component();
  constructor(app: App, private readonly ui: RecoveryUI) { super(app); }
  onOpen(): void { this.alive = true; this.component.load(); this.contentEl.addClass("mineral-recovery-center"); void this.refresh(); }
  onClose(): void { this.alive = false; this.component.unload(); this.contentEl.empty(); }
  async refresh(): Promise<void> {
    if (this.busy || !this.alive) return;
    this.busy = true;
    if (!this.selected) { this.contentEl.empty(); this.contentEl.createEl("p", { text: "正在读取 R2 恢复中心…" }); }
    try {
      this.entries = await this.ui.list();
      if (this.alive && (!this.selected || !this.entries.some(e => e.key === this.selected?.key && e.etag === this.selected?.etag))) this.renderList();
    }
    catch (error) { if (this.alive) { this.contentEl.empty(); this.contentEl.createEl("p", { text: `R2 读取失败：${String(error)}` }); this.button(this.contentEl, "重试", () => this.refresh()); } }
    finally { this.busy = false; }
  }
  private button(parent: HTMLElement, text: string, run: () => void | Promise<void>): void {
    parent.createEl("button", { text }).addEventListener("click", () => { if (!this.busy) void this.run(run); });
  }
  private async run(work: () => void | Promise<void>): Promise<void> {
    try { await work(); } catch (error) { new Notice(`恢复中心：${String(error)}`); }
  }
  private renderList(): void {
    this.selected = undefined;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Mineral 全局恢复中心" });
    this.contentEl.createEl("p", { text: "数据直接来自 R2。网关离线仍可查看、恢复和清理。" });
    const actions = this.contentEl.createDiv({ cls: "mineral-recovery-actions" });
    this.button(actions, "刷新 R2", () => this.refresh());
    const pathInput = this.contentEl.createEl("input", { attr: { placeholder: "按原路径筛选（精确路径）", "aria-label": "原路径筛选" } });
    this.button(actions, "按路径清理历史版本", () => this.clean(this.entries.filter(e => e.kind === "version" && e.path === pathInput.value), `清理路径 ${pathInput.value} 的历史版本`));
    const days = this.contentEl.createEl("input", { attr: { type: "number", min: "1", placeholder: "保留天数", "aria-label": "保留天数" } }); days.value = "30";
    this.button(actions, "按年龄批量清理", () => {
      const age = Number(days.value); if (!Number.isSafeInteger(age) || age < 1) throw new Error("请输入大于 0 的整数天数");
      return this.clean(this.entries.filter(e => e.kind !== "invalid" && e.kind !== "legacy-version" && e.state !== "legacy-read-only" && Date.parse(e.createdAt) < Date.now() - age * 86400000), `真实删除超过 ${age} 天的恢复记录`);
    });
    this.button(actions, "清空恢复中心", () => {
      if (this.entries.some(e => e.kind === "invalid" || e.kind === "legacy-version" || e.state === "legacy-read-only")) throw new Error("存在损坏或旧格式记录，不能宣称清空；请先验证迁移这些记录");
      return this.clean(this.entries, "清空 R2 恢复中心。只删除版本和墓碑，普通笔记不会被删除");
    });
    this.contentEl.createEl("p", { text: "本地遗留镜像不参与恢复。确认 R2 中所需版本完整后，可手动备份并清理 Vault 的 .mineral/versions；Mineral 不会自动删除本地文件。" });
    if (!this.entries.length) this.contentEl.createEl("p", { text: "R2 恢复中心为空" });
    const list = this.contentEl.createDiv();
    for (const e of this.entries) {
      const row = list.createDiv({ cls: "mineral-recovery-row" });
      row.createEl("strong", { text: e.path });
      row.createEl("p", { text: `${e.createdAt} · ${e.size < 0 ? "原大小未知" : `${e.size} B`} · ${e.reason} · ${stateLabel(e.state)}` });
      if (e.error) row.createEl("p", { text: e.error });
      if (e.kind === "version") this.button(row, "查看与恢复", () => this.detail(e));
      if (e.kind === "tombstone") {
        this.button(row, "预览旧删除正文", () => this.detail(e));
        this.button(row, "保存为版本副本", () => this.submit({ identity: this.ui.identity, confirmed: true, action: "migrate", selection: recoverySelection(e) }));
      }
      if (e.kind === "legacy-version") {
        this.button(row, "预览旧版本", () => this.detail(e));
        this.button(row, "迁移旧版本", async () => {
          if (await confirmPhysicalDelete(this.app, `将 ${e.path} 的旧版本复制为 TOML 与 content 格式；字节验证成功后真实删除旧副本。`)) await this.submit({ identity: this.ui.identity, confirmed: true, action: "migrate", selection: recoverySelection(e) });
        });
      }
      if (e.kind !== "invalid" && e.kind !== "legacy-version" && e.state !== "legacy-read-only") this.button(row, e.kind === "version" ? "删除版本" : "清理墓碑记录", () => this.clean([e], `真实删除 ${e.path} 的${e.kind === "version" ? "版本副本" : "墓碑元数据；不删除当前普通文件"}`));
      if (e.state === "delete-pending") this.button(row, "确认并重试删除", async () => {
        if (await confirmPhysicalDelete(this.app, `重试删除 R2 普通路径 ${e.path}，仍需匹配旧 ETag`)) await this.submit({ identity: this.ui.identity, confirmed: true, action: "retry", selection: recoverySelection(e) });
      });
    }
  }
  private async detail(e: RecoveryEntry): Promise<void> {
    this.selected = e;
    this.busy = true;
    try {
      const bytes = e.path.toLowerCase().endsWith(".md") ? await this.ui.preview(e) : undefined;
      this.contentEl.empty(); this.contentEl.createEl("h2", { text: e.path });
      this.contentEl.createEl("p", { text: `${e.size < 0 ? "原大小未知" : `${e.size} B`} · ${e.manifest?.content_type ?? e.contentType ?? "文件信息"} · ${stateLabel(e.state)}` });
      if (e.manifest?.anomaly) this.contentEl.createEl("p", { text: `${DELETE_RISK}\n风险记录：${e.manifest.anomaly}` });
      if (bytes) {
        const preview = this.contentEl.createDiv({ cls: "mineral-recovery-preview" });
        await MarkdownRenderer.render(this.app, new TextDecoder().decode(bytes).slice(0, 100000), preview, e.path, this.component);
      } else this.contentEl.createEl("p", { text: "二进制文件：仅显示文件信息，恢复时保留原始字节与元数据。" });
      const target = this.contentEl.createEl("input", { attr: { "aria-label": "恢复目标路径", placeholder: "恢复目标路径" } }); target.value = e.path;
      this.button(this.contentEl, "恢复", () => this.restore(e, target.value, false));
      this.button(this.contentEl, "新名称", () => { const slash = e.path.lastIndexOf("."); target.value = slash >= 0 ? `${e.path.slice(0, slash)}-restored-${Date.now()}${e.path.slice(slash)}` : `${e.path}-restored-${Date.now()}`; });
      this.button(this.contentEl, "明确覆盖", () => this.restore(e, target.value, true));
      this.button(this.contentEl, "取消", () => { this.renderList(); });
    } finally { this.busy = false; }
  }
  private async restore(e: RecoveryEntry, target: string, overwrite: boolean): Promise<void> {
    if (e.kind !== "version") throw new Error("请返回列表先迁移或保存为版本副本，再恢复 TOML 版本");
    const current = await this.ui.target(target);
    if (current && !overwrite) throw new Error("同名文件已存在。请选择新名称、取消，或明确覆盖。");
    if (current && overwrite && !await this.confirmRestore(target)) return;
    await this.submit({ identity: this.ui.identity, confirmed: true, action: "restore", selection: recoverySelection(e), target, expectedTargetETag: current?.etag ?? null });
  }
  private confirmRestore(target: string): Promise<boolean> {
    return new Promise(resolve => {
      const modal = new Modal(this.app); let accepted = false;
      modal.onOpen = () => { modal.contentEl.createEl("h2", { text: "明确覆盖当前 R2 文件" }); modal.contentEl.createEl("p", { text: `${target} 的当前版本将先备份，再以刚读取的 ETag 条件覆盖。` }); modal.contentEl.createEl("button", { text: "取消" }).addEventListener("click", () => modal.close()); modal.contentEl.createEl("button", { text: "确认覆盖" }).addEventListener("click", () => { accepted = true; modal.close(); }); };
      modal.onClose = () => resolve(accepted); modal.open();
    });
  }
  private async clean(entries: RecoveryEntry[], description: string): Promise<void> {
    if (!entries.length) { new Notice("没有符合条件的记录"); return; }
    if (!await confirmPhysicalDelete(this.app, `${description}，共 ${entries.length} 项。版本正文与 manifest 将真实删除；无法撤销。`)) return;
    await this.submit({ identity: this.ui.identity, confirmed: true, action: "clean", selections: entries.map(recoverySelection) });
  }
  private async submit(intent: RecoveryIntent): Promise<void> {
    this.busy = true;
    try { await this.ui.submit(intent); new Notice("R2 操作完成"); }
    finally { this.busy = false; this.selected = undefined; await this.refresh(); }
  }
}
export function stateLabel(state: string): string { return ({ "delete-pending": "删除待确认", deleted: "已真实删除（已记录窗口风险）", anomaly: "异常，需人工恢复", backup: "版本备份", tombstone: "墓碑", "legacy-read-only": "旧墓碑（只读兼容）", invalid: "不完整或旧格式，禁止清理", migration: "已迁移", "legacy-version": "旧格式（可预览，请先迁移）", "cleanup-pending": "清理待确认，可重试清理" } as Record<string, string>)[state] ?? state; }
export const RECOVERY_CSS = ".mineral-recovery-center input{width:100%;margin:6px 0}.mineral-recovery-actions{display:flex;flex-wrap:wrap;gap:8px}.mineral-recovery-row{border-bottom:1px solid var(--background-modifier-border);padding:12px 0;overflow-wrap:anywhere}.mineral-recovery-row button{margin:4px}.mineral-recovery-preview{max-height:45vh;overflow:auto}.mineral-recovery-risk{color:var(--text-warning)}";

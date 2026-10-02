import { Modal, Notice, Setting, type App } from "obsidian";
import type { HotConflictReason } from "../hot/coordinator";

/**
 * The one screen a frozen hot conflict needs: which file, what each side holds, and the two ways out.
 *
 * Three things this screen has to get right, all of them learned from a real session:
 *
 * - **It has to say what each side is.** "Keep local / take the other side" is a coin flip when the user
 *   cannot see that one side is empty or a few bytes and the other is their work. Sizes are shown, and the
 *   destructive direction says so in the button.
 * - **It has to react.** A resolution that succeeds silently, in a modal that stays open, is
 *   indistinguishable from a broken button.
 * - **It has to close its own loop.** Once nothing is frozen, the window goes away.
 *
 * A hot conflict is not a cold one, and the cold resolver cannot settle it: the two versions are "what
 * this device has" versus "what the authority has", not two files to diff. When a cold merge has already
 * been prepared, it is offered here as a third answer — the text travels into the room through this
 * screen because the room is the path's only writer.
 */
export interface HotConflictEntry {
  canonicalPath: string;
  reason: HotConflictReason;
  /** Bytes on disk, when it could be read. */
  localSize?: number;
  /** Bytes the server holds for this path, when it could be asked. */
  remoteSize?: number;
  pendingRoomRevision?: number;
  /**
   * A hand-made result that is already sitting in the cold conflict's resolution intent.
   *
   * The cold resolver can compose a merge but cannot apply it while this path is hot: the room is the
   * only writer, and a cold write is exactly what the fence prevents. Rather than making the user retype
   * a result they already prepared, the same text is offered here, where applying it goes through the
   * room. Absent when there is no such intent, in which case the choice stays binary.
   */
  mergedDraft?: string;
}

/** A decision the hot side can carry out, including one that has to bring its own text. */
export type HotConflictDecision = "keep-local" | "accept-remote" | "merged";

export class HotConflictModal extends Modal {
  private readonly decided = new Set<string>();

  constructor(
    app: App,
    private readonly conflicts: HotConflictEntry[],
    private readonly decide: (canonicalPath: string, decision: HotConflictDecision, mergedText?: string) => Promise<{ outcome: string; detail?: string }>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h3", { text: "热同步冲突" });
    this.contentEl.createEl("p", {
      text: "这些文件的冷同步已被暂停，任何一侧的内容都还没有被覆盖。选择之后该文件会重新开始同步。",
      cls: "setting-item-description",
    });
    if (this.conflicts.length === 0) {
      this.contentEl.createEl("p", { text: "没有需要处理的冲突。" });
      return;
    }
    for (const conflict of this.conflicts) {
      const row = new Setting(this.contentEl)
        .setName(conflict.canonicalPath)
        .setDesc(`${explain(conflict.reason)}\n${sizes(conflict)}`);
      const labels = buttonLabels(conflict.reason);
      row.addButton(button => button.setButtonText(labels.keepLocal).onClick(async () => {
        await this.apply(conflict, "keep-local", row);
      }));
      row.addButton(button => button.setButtonText(labels.acceptRemote).setWarning().onClick(async () => {
        await this.apply(conflict, "accept-remote", row);
      }));
      // The prepared result is the one answer that preserves both sides, so it is offered first and
      // carries the text, because the room cannot read it from anywhere else.
      if (conflict.mergedDraft !== undefined) {
        row.addButton(button => button.setButtonText("使用已准备好的合并结果").setCta().onClick(async () => {
          await this.apply(conflict, "merged", row, conflict.mergedDraft);
        }));
      }
    }
  }

  /**
   * A decision is applied once, and both the row and the user are told what happened.
   *
   * A failed decision leaves the row actionable on purpose: the conflict is still there, and hiding that
   * would be worse than an error message.
   */
  private async apply(conflict: HotConflictEntry, decision: HotConflictDecision, row: Setting, mergedText?: string): Promise<void> {
    if (this.decided.has(conflict.canonicalPath)) return;
    this.decided.add(conflict.canonicalPath);
    row.setDesc(`${explain(conflict.reason)}\n正在处理…`);
    let result: { outcome: string; detail?: string };
    try {
      result = await this.decide(conflict.canonicalPath, decision, mergedText);
    } catch (error) {
      result = { outcome: "failed", detail: error instanceof Error ? error.message : "unknown" };
    }
    if (result.outcome === "failed") {
      this.decided.delete(conflict.canonicalPath);
      const message = `未能应用这次选择（${result.detail ?? "unknown"}）。可以重试，或先处理磁盘上的内容。`;
      row.setDesc(message);
      new Notice(`Mineral Sync：${conflict.canonicalPath} ${message}`);
      return;
    }
    const message = result.outcome === "pending-confirmation"
      // The honest answer for a handoff: the save has been requested, but "requested" is not "proved".
      ? "已请求重新保存。该文件会保持冻结，直到确认内容确实写入 R2（重新打开该文件即可继续核对）。"
      : result.outcome === "abandoned"
        ? "已放弃本机的热会话，该文件交回冷同步；如果两端内容不同，冷同步会弹出它自己的冲突窗口。"
        // A merge is this device's own edit, so it lands in the document and the file first; the room
        // then saves it on its own schedule. Saying "已保存" here would claim a receipt that has not
        // arrived, which is the one thing this screen must not do.
        : decision === "merged"
          ? "合并结果已写入文档与文件，并已请求房间保存到服务器。该文件会重新开始同步。"
          : "已按你的选择处理，该文件会重新开始同步。";
    row.setDesc(message);
    row.settingEl.addClass("mineral-sync-hot-conflict--resolved");
    new Notice(`Mineral Sync：${conflict.canonicalPath} — ${message}`);
    if (this.decided.size >= this.conflicts.length) this.close();
  }
}

/** What each side holds, in bytes — the difference between an informed choice and a coin flip. */
function sizes(conflict: HotConflictEntry): string {
  const local = conflict.localSize === undefined ? "未知" : `${conflict.localSize} 字节`;
  const remote = conflict.remoteSize === undefined ? "未知" : `${conflict.remoteSize} 字节`;
  const pending = conflict.pendingRoomRevision === undefined ? "" : `\n热会话还有第 ${conflict.pendingRoomRevision} 次修改尚未保存。采用服务器版本会放弃这份未保存修改；使用合并结果会用合并文本替换它。`;
  return `本机文件：${local}　服务器已保存版本：${remote}${pending}`;
}

/**
 * Button wording per kind, because "the other side" means opposite things.
 *
 * For an edit made underneath this device, the *file* is the external version and the session holds this
 * device's; for a server conflict, the file is this device's and the server holds the other. Saying which
 * one overwrites what is the whole point of the screen.
 */
function buttonLabels(reason: HotConflictReason): { keepLocal: string; acceptRemote: string } {
  if (reason === "external-local-edit") return { keepLocal: "使用磁盘上的内容", acceptRemote: "使用会话内容（写回文件）" };
  return { keepLocal: "保留本机文件（写入服务器）", acceptRemote: "采用服务器版本（覆盖本机文件）" };
}

/** Why this path is frozen, said in terms of what the user can do about it. */
function explain(reason: HotConflictReason): string {
  if (reason === "external-local-edit") {
    return "这个文件在热会话期间被本机上的其他程序改写过。当前磁盘内容与热会话内容不一致，插件没有覆盖任何一侧。";
  }
  if (reason === "handoff-pending") {
    return "上次关闭这个文件时，内容没能确认保存到 R2。热会话仍持有该文件，冷同步保持让路，直到这次交接完成。";
  }
  return "服务端发现该路径的 R2 版本与本机版本已经分叉（可能是其他设备或外部程序改写、删除），或者本机内容与该文档服务器端已知的版本不一致。任何一侧都还没有被覆盖。";
}

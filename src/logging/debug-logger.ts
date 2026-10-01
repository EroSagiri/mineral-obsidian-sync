import type { App } from "obsidian";

/**
 * The plugin's debug logger — three independent sinks behind one entry point.
 *
 * A sink is a place a log line can land. Each is gated by its own flag, so a single
 * call to `log()` may end up in zero, one, two, or three places:
 *
 * - **console**: gated by `debugLogging`. Goes to the WebView dev console; on
 *   Android it does not reach `logcat` and is effectively invisible.
 * - **ring**: always on, capped at `ringCapacity` lines (default 200). Lives in
 *   memory only; Obsidian restart clears it. Read by the resolve-failure report
 *   and the `Show Debug Log` command.
 * - **disk**: gated by `persistDebugLog`. Appends to `<pluginDir>/debug.log`,
 *   rotated by line count (default 2000). This is the sink that survives a
 *   restart and the only one a phone user can pull with `adb`.
 *
 * Every line carries a **tag** identifying the module that emitted it: a single
 * setting (`enabledLogTags`) filters which tags are allowed through. `"*"` means
 * "all tags"; an array means "only these" (with the legacy `"main"` tag kept on
 * for callers that go through the plugin's `this.debug()` façade). Per-tag
 * suppression happens before the sinks are touched, so a disabled tag costs the
 * same as no call at all.
 *
 * Two operators act on top of the ring:
 *
 * - `mark(label)` writes a separator line and starts a selection window.
 * - `captureSlice(label?)` writes the lines since the last `mark` (or the entire
 *   ring if no mark was set) to `<pluginDir>/debug-slices/<iso>-<label>.log`,
 *   separately from the main disk log. A slice never overwrites the main log
 *   and never resets it; the main log keeps appending.
 *
 * Disk writes go through Obsidian's vault adapter, which is async and not safe
 * to call in parallel from `log()` because the sink itself can produce lines
 * while a previous write is in flight. The logger serialises them.
 */
export interface DebugLoggerSettings {
  debugLogging: boolean;
  persistDebugLog: boolean;
  persistDebugLogMaxLines?: number;
  /** `"*"` allows every tag; an array restricts to those (plus the legacy `"main"`). */
  enabledLogTags: string[] | "*";
}

export interface DebugLoggerOptions {
  getSettings(): DebugLoggerSettings;
  pluginDir: string;
  ringCapacity?: number;
  now?: () => Date;
}

const DEFAULT_RING_CAPACITY = 200;
const DEFAULT_DISK_MAX_LINES = 2000;

/** Read-only view of the in-memory ring, exposed for tests and the resolve-failure report. */
export interface DebugRingView {
  readonly lines: readonly string[];
  /** The 0-based ring index of the most recent `mark()` separator, or -1 if no mark has been set. */
  readonly markIndex: number;
}

/** A bound log function for a specific tag. Returns a function that takes (message: string). */
export type TaggedLogger = (message: string) => void;

export class DebugLogger {
  private readonly ring: string[] = [];
  private readonly ringCapacity: number;
  private readonly diskMaxLines: number;
  private readonly now: () => Date;
  private markIndex = -1;
  /** Serialised disk writes so a slow adapter call does not interleave with new lines. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly app: App, private readonly opts: DebugLoggerOptions) {
    this.ringCapacity = opts.ringCapacity ?? DEFAULT_RING_CAPACITY;
    this.diskMaxLines = opts.getSettings().persistDebugLogMaxLines ?? DEFAULT_DISK_MAX_LINES;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * The single entry point. Tag identifies the module; a tag-suppressed caller
   * sees the call short-circuit before any sink is touched.
   */
  log(tag: string, message: string): void {
    if (!this.isTagEnabled(tag)) return;
    const line = `${this.now().toISOString()} [${tag}] ${message}`;
    const settings = this.opts.getSettings();
    if (settings.debugLogging) console.log(`[Mineral Obsidian Sync] ${line}`);
    this.appendRing(line);
    if (settings.persistDebugLog) this.appendDisk(line);
  }

  /**
   * Returns a bound function that emits under it. The resulting function is safe to
   * pass into module constructors as the `debug` dependency; the tag is closed over
   * once at construction.
   */
  tag(tag: string): TaggedLogger {
    return (message) => this.log(tag, message);
  }

  /**
   * A separator line plus the start of a selection window. A subsequent `captureSlice()`
   * will dump everything since the last `mark` to a dedicated file. Marks are emitted
   * under the synthetic `"mark"` tag so they always bypass the user's per-tag filter.
   */
  mark(label: string): void {
    const line = `${this.now().toISOString()} [mark] === MARK ${label} ===`;
    const settings = this.opts.getSettings();
    if (settings.debugLogging) console.log(`[Mineral Obsidian Sync] ${line}`);
    this.appendRing(line);
    this.markIndex = this.ring.length - 1;
    if (settings.persistDebugLog) this.appendDisk(line);
  }

  /**
   * Writes the ring slice since the last `mark()` to `<pluginDir>/debug-slices/<iso>-<label>.log`.
   *
   * If no mark has been set, the full ring is captured (so the first slice after plugin start is
   * not empty). The slice is best-effort — a write that cannot complete is logged to console but
   * never thrown, because a debug sink must not crash the host.
   */
  async captureSlice(label: string): Promise<string | undefined> {
    const lines = this.sliceLines();
    const header = [
      `${this.now().toISOString()} === SLICE ${label} ===`,
      `ring-size: ${this.ring.length}`,
      `window-size: ${lines.length}`,
      "",
    ];
    const body = header.concat(lines).concat([""]);
    return await this.writeSlice(label, body);
  }

  /** Last `limit` lines from the ring, oldest → newest. */
  read(lines = 60): readonly string[] {
    if (lines <= 0) return [];
    if (this.ring.length <= lines) return this.ring.slice();
    return this.ring.slice(this.ring.length - lines);
  }

  /** Read-only view of the ring, for callers that need the mark index too. */
  view(): DebugRingView {
    return { lines: this.ring.slice(), markIndex: this.markIndex };
  }

  /**
   * Replace the live ring with the most recent `keep` lines from `disk`.
   *
   * Called at startup when the user enabled `persistDebugLog`. The previous ring was already
   * discarded by the constructor; this restores whatever fit under the disk line cap.
   */
  async restoreFromDisk(): Promise<void> {
    const path = this.diskPath();
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(path))) return;
      const raw = await adapter.read(path);
      const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
      const keep = lines.slice(-this.ringCapacity);
      this.ring.length = 0;
      this.ring.push(...keep);
      this.markIndex = -1;
    } catch (error) {
      console.log(`[Mineral Obsidian Sync] debug log restore error: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  /**
   * Flush any pending disk writes. Awaited on `onunload` so a settings toggle right before close
   * does not lose its last lines.
   */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  /** Path of the main disk log. Exposed so the "Show Debug Log" command can surface it. */
  diskPath(): string {
    return `${this.opts.pluginDir}/debug.log`;
  }

  /** Path of the slice directory. */
  sliceDir(): string {
    return `${this.opts.pluginDir}/debug-slices`;
  }

  /** Path of the most recent slice file with the given label. */
  slicePath(label: string): string {
    const safe = label.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return `${this.sliceDir()}/${this.now().toISOString().replace(/[:.]/g, "-")}-${safe}.log`;
  }

  /**
   * The set of tags currently allowed through. Useful for the settings UI.
   */
  effectiveEnabledTags(): string[] | "*" {
    return this.opts.getSettings().enabledLogTags;
  }

  private isTagEnabled(tag: string): boolean {
    if (tag === "main") return true; // legacy callers never get filtered
    const enabled = this.opts.getSettings().enabledLogTags;
    if (enabled === "*") return true;
    return Array.isArray(enabled) && enabled.includes(tag);
  }

  private sliceLines(): string[] {
    if (this.markIndex < 0) return this.ring.slice();
    return this.ring.slice(this.markIndex + 1);
  }

  private appendRing(line: string): void {
    this.ring.push(line);
    if (this.ring.length > this.ringCapacity) this.ring.splice(0, this.ring.length - this.ringCapacity);
  }

  private appendDisk(line: string): void {
    const path = this.diskPath();
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const adapter = this.app.vault.adapter;
        if (!(await adapter.exists(path))) await adapter.write(path, "");
        await adapter.append(path, `${line}\n`);
        await this.rotateIfNeeded(path);
      } catch (error) {
        console.log(`[Mineral Obsidian Sync] debug log write error: ${error instanceof Error ? error.message : "unknown"}`);
      }
    });
  }

  private async rotateIfNeeded(path: string): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      const raw = await adapter.read(path);
      const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
      if (lines.length <= this.diskMaxLines) return;
      const keep = lines.slice(-this.diskMaxLines);
      await adapter.write(path, `${keep.join("\n")}\n`);
    } catch (error) {
      console.log(`[Mineral Obsidian Sync] debug log rotate error: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  private async writeSlice(label: string, body: string[]): Promise<string | undefined> {
    const path = this.slicePath(label);
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const adapter = this.app.vault.adapter;
        if (!(await adapter.exists(this.sliceDir()))) await adapter.mkdir(this.sliceDir());
        await adapter.write(path, body.join("\n"));
      } catch (error) {
        console.log(`[Mineral Obsidian Sync] debug slice write error: ${error instanceof Error ? error.message : "unknown"}`);
      }
    });
    await this.writeQueue;
    return path;
  }
}
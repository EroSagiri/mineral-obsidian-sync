import { describe, expect, it } from "vitest";
import { DebugLogger, type DebugLoggerSettings } from "./debug-logger";

/**
 * The minimal vault adapter the logger talks to.
 *
 * Obsidian's adapter is async; the tests use `memfs`-style maps that record writes, appends, and
 * exist calls. The logger serialises its writes, so the test harness does not need to.
 */
class FakeAdapter {
  files = new Map<string, string>();
  existsCalls = 0;
  mkdirCalls = 0;

  async exists(path: string): Promise<boolean> {
    this.existsCalls += 1;
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async append(path: string, content: string): Promise<void> {
    const previous = this.files.get(path) ?? "";
    this.files.set(path, `${previous}${content}`);
  }

  async mkdir(path: string): Promise<void> {
    this.mkdirCalls += 1;
    if (this.files.has(path)) return;
    this.files.set(path, "");
  }
}

interface Harness {
  logger: DebugLogger;
  adapter: FakeAdapter;
  settings: DebugLoggerSettings;
  recordedConsole: string[];
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const adapter = overrides.adapter ?? new FakeAdapter();
  const settings: DebugLoggerSettings = overrides.settings ?? {
    debugLogging: false,
    persistDebugLog: false,
    enabledLogTags: "*",
  };
  const recordedConsole = overrides.recordedConsole ?? [];
  const originalLog = console.log;
  console.log = (line: string) => recordedConsole.push(line);
  const fixedDate = new Date("2026-10-01T12:00:00.000Z");
  const logger = new DebugLogger(
    { vault: { adapter } } as unknown as ConstructorParameters<typeof DebugLogger>[0],
    {
      getSettings: () => settings,
      pluginDir: "/test-plugin",
      ringCapacity: 5,
      now: () => fixedDate,
    },
  );
  // Reset between tests; vitest's `beforeEach` cannot easily reach console.log's previous binding.
  void originalLog;
  return { logger, adapter, settings, recordedConsole };
}

describe("DebugLogger", () => {
  it("appends to the ring even when both console and disk are disabled", async () => {
    const { logger, recordedConsole } = harness();
    logger.log("coordinator", "hello");
    logger.log("session", "world");
    expect(logger.read()).toEqual([
      `${new Date("2026-10-01T12:00:00.000Z").toISOString()} [coordinator] hello`,
      `${new Date("2026-10-01T12:00:00.000Z").toISOString()} [session] world`,
    ]);
    expect(recordedConsole).toEqual([]);
    await logger.flush();
  });

  it("writes to console only when debugLogging is enabled", async () => {
    const ctx = harness({ settings: { debugLogging: true, persistDebugLog: false, enabledLogTags: "*" } });
    ctx.logger.log("coordinator", "alpha");
    expect(ctx.recordedConsole).toEqual([`[Mineral Obsidian Sync] ${new Date("2026-10-01T12:00:00.000Z").toISOString()} [coordinator] alpha`]);
    await ctx.logger.flush();
  });

  it("appends a single tagged line per log to the disk file", async () => {
    const ctx = harness({ settings: { debugLogging: false, persistDebugLog: true, enabledLogTags: "*" } });
    ctx.logger.log("coordinator", "first");
    ctx.logger.log("session", "second");
    await ctx.logger.flush();
    const written = ctx.adapter.files.get("/test-plugin/debug.log") ?? "";
    const lines = written.split("\n").filter((line) => line.length > 0);
    expect(lines).toEqual([
      `${new Date("2026-10-01T12:00:00.000Z").toISOString()} [coordinator] first`,
      `${new Date("2026-10-01T12:00:00.000Z").toISOString()} [session] second`,
    ]);
  });

  it("rotates the disk log when it exceeds the configured cap", async () => {
    const ctx = harness({
      settings: { debugLogging: false, persistDebugLog: true, persistDebugLogMaxLines: 3, enabledLogTags: "*" },
    });
    ctx.logger.log("a", "a");
    ctx.logger.log("b", "b");
    ctx.logger.log("c", "c");
    ctx.logger.log("d", "d");
    ctx.logger.log("e", "e");
    await ctx.logger.flush();
    const written = ctx.adapter.files.get("/test-plugin/debug.log") ?? "";
    const lines = written.split("\n").filter((line) => line.length > 0);
    expect(lines).toEqual([
      `${new Date("2026-10-01T12:00:00.000Z").toISOString()} [c] c`,
      `${new Date("2026-10-01T12:00:00.000Z").toISOString()} [d] d`,
      `${new Date("2026-10-01T12:00:00.000Z").toISOString()} [e] e`,
    ]);
  });

  it("drops ring entries past the configured cap", () => {
    const { logger } = harness();
    for (let i = 0; i < 12; i++) logger.log("x", `line-${i}`);
    const lines = logger.read();
    // Each line is `${iso} [x] line-N`; pull out the `line-N` tail.
    expect(lines.map((line) => line.split(" ").slice(2).join(" "))).toEqual([
      "line-7", "line-8", "line-9", "line-10", "line-11",
    ]);
  });

  it("filters by `enabledLogTags` when set to a list", async () => {
    const ctx = harness({
      settings: { debugLogging: true, persistDebugLog: false, enabledLogTags: ["coordinator"] },
    });
    ctx.logger.log("coordinator", "kept");
    ctx.logger.log("session", "filtered");
    ctx.logger.log("executor", "filtered");
    const out = ctx.logger.read();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("[coordinator] kept");
    expect(ctx.recordedConsole).toHaveLength(1);
    await ctx.logger.flush();
  });

  it("`main` is exempt so the legacy `this.debug` façade always reaches them", async () => {
    const ctx = harness({
      settings: { debugLogging: true, persistDebugLog: false, enabledLogTags: [] },
    });
    ctx.logger.log("main", "kept");
    ctx.logger.log("session", "filtered");
    expect(ctx.logger.read()).toHaveLength(1);
    expect(ctx.recordedConsole).toEqual([expect.stringContaining("[main] kept")]);
    await ctx.logger.flush();
  });

  it("`tag(name)` returns a bound function that emits under that tag", () => {
    const ctx = harness();
    const sessionLog = ctx.logger.tag("session");
    sessionLog("hi");
    expect(ctx.logger.read()[0]).toContain("[session] hi");
  });

  it("`tag(name)` closures respect the filter at call time, not capture time", () => {
    const ctx = harness({
      settings: { debugLogging: false, persistDebugLog: false, enabledLogTags: [] },
    });
    const sessionLog = ctx.logger.tag("session");
    sessionLog("dropped");
    expect(ctx.logger.read()).toEqual([]);
  });

  it("writes a `=== MARK ... ===` separator under the synthetic `mark` tag", async () => {
    const ctx = harness({ settings: { debugLogging: true, persistDebugLog: true, enabledLogTags: "*" } });
    ctx.logger.log("coordinator", "before");
    ctx.logger.mark("opening X.md");
    ctx.logger.log("session", "after");
    expect(ctx.recordedConsole).toContain(`[Mineral Obsidian Sync] ${new Date("2026-10-01T12:00:00.000Z").toISOString()} [mark] === MARK opening X.md ===`);
    await ctx.logger.flush();
    const written = ctx.adapter.files.get("/test-plugin/debug.log") ?? "";
    expect(written).toContain("[mark] === MARK opening X.md ===");
    expect(written.indexOf("[mark] === MARK opening X.md ===")).toBeGreaterThan(written.indexOf("[coordinator] before"));
    expect(written.indexOf("[session] after")).toBeGreaterThan(written.indexOf("[mark] === MARK opening X.md ==="));
  });

  it("`mark` ignores the per-tag filter", () => {
    const ctx = harness({
      settings: { debugLogging: false, persistDebugLog: false, enabledLogTags: ["coordinator"] },
    });
    ctx.logger.mark("still visible after X");
    expect(ctx.logger.read()).toHaveLength(1);
    expect(ctx.logger.read()[0]).toContain("[mark]");
  });

  it("captureSlice writes only the lines after the most recent mark", async () => {
    const ctx = harness({ settings: { debugLogging: false, persistDebugLog: true, enabledLogTags: "*" } });
    ctx.logger.log("coordinator", "before-1");
    ctx.logger.log("coordinator", "before-2");
    ctx.logger.mark("incident");
    ctx.logger.log("session", "after-1");
    ctx.logger.log("session", "after-2");
    const path = await ctx.logger.captureSlice("incident-capture");
    expect(path).toBe("/test-plugin/debug-slices/2026-10-01T12-00-00-000Z-incident-capture.log");
    const written = ctx.adapter.files.get(path ?? "") ?? "";
    expect(written).toContain("[session] after-1");
    expect(written).toContain("[session] after-2");
    expect(written).not.toContain("before-1");
    expect(written).not.toContain("before-2");
  });

  it("captureSlice falls back to the full ring when no mark has been set", async () => {
    const ctx = harness({ settings: { debugLogging: false, persistDebugLog: false, enabledLogTags: "*" } });
    ctx.logger.log("coordinator", "only-this-thing");
    const path = await ctx.logger.captureSlice("first");
    const written = ctx.adapter.files.get(path ?? "") ?? "";
    expect(written).toContain("[coordinator] only-this-thing");
  });

  it("restores the ring from disk on startup when persistDebugLog is on", async () => {
    const adapter = new FakeAdapter();
    adapter.files.set("/test-plugin/debug.log", [
      `${new Date("2026-10-01T12:00:00.000Z").toISOString()} [coordinator] persisted-1`,
      `${new Date("2026-10-01T12:00:00.000Z").toISOString()} [coordinator] persisted-2`,
      `${new Date("2026-10-01T12:00:00.000Z").toISOString()} [session] persisted-3`,
    ].join("\n"));
    const ctx = harness({
      adapter,
      settings: { debugLogging: false, persistDebugLog: true, enabledLogTags: "*" },
    });
    await ctx.logger.restoreFromDisk();
    expect(ctx.logger.read()).toEqual([
      `${new Date("2026-10-01T12:00:00.000Z").toISOString()} [coordinator] persisted-1`,
      `${new Date("2026-10-01T12:00:00.000Z").toISOString()} [coordinator] persisted-2`,
      `${new Date("2026-10-01T12:00:00.000Z").toISOString()} [session] persisted-3`,
    ]);
  });

  it("never throws when the adapter is broken", async () => {
    class BrokenAdapter {
      async exists(): Promise<boolean> { return false; }
      async read(): Promise<string> { throw new Error("no"); }
      async write(): Promise<void> { throw new Error("no"); }
      async append(): Promise<void> { throw new Error("no"); }
      async mkdir(): Promise<void> { throw new Error("no"); }
    }
    const ctx = harness({
      adapter: new BrokenAdapter() as unknown as FakeAdapter,
      settings: { debugLogging: false, persistDebugLog: true, enabledLogTags: "*" },
    });
    expect(() => ctx.logger.log("x", "hi")).not.toThrow();
    await expect(ctx.logger.captureSlice("test")).resolves.toBeDefined();
  });

  it("serialises disk writes so a slow adapter call does not interleave new lines", async () => {
    const adapter = new FakeAdapter();
    const order: string[] = [];
    const originalAppend = adapter.append.bind(adapter);
    adapter.append = async (path: string, content: string) => {
      order.push(`append-start:${content}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`append-end:${content}`);
      await originalAppend(path, content);
    };
    const ctx = harness({
      adapter,
      settings: { debugLogging: false, persistDebugLog: true, enabledLogTags: "*" },
    });
    ctx.logger.log("a", "a");
    ctx.logger.log("b", "b");
    ctx.logger.log("c", "c");
    await ctx.logger.flush();
    const fixed = new Date("2026-10-01T12:00:00.000Z").toISOString();
    expect(order).toEqual([
      `append-start:${fixed} [a] a\n`,
      `append-end:${fixed} [a] a\n`,
      `append-start:${fixed} [b] b\n`,
      `append-end:${fixed} [b] b\n`,
      `append-start:${fixed} [c] c\n`,
      `append-end:${fixed} [c] c\n`,
    ]);
  });

  it("returns `*` from `effectiveEnabledTags` when the filter is off", () => {
    const ctx = harness();
    expect(ctx.logger.effectiveEnabledTags()).toBe("*");
  });

  it("returns the array from `effectiveEnabledTags` when the filter is on", () => {
    const ctx = harness({ settings: { debugLogging: false, persistDebugLog: false, enabledLogTags: ["a", "b"] } });
    expect(ctx.logger.effectiveEnabledTags()).toEqual(["a", "b"]);
  });
});
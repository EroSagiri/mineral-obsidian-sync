import { describe, expect, it } from "vitest";
import { scanLocal } from "../local/scan-local";
import { scanRemote } from "../remote/scan-remote";
import { createVaultPathFilter } from "./ignore";

describe("vault path filter", () => {
  it("matches configured paths and their descendants on both scan sides", async () => {
    const filter = createVaultPathFilter({ ignoredPaths: [".history", "attachments/cache/", "daily/private.md"] });
    expect(filter.ignores(".history/revision/note.md")).toBe(true);
    expect(filter.ignores("attachments/cache/image.png")).toBe(true);
    expect(filter.ignores("daily/private.md")).toBe(true);
    expect(filter.ignores("daily/private-copy.md")).toBe(false);
    const local = scanLocal({ getFiles: () => [
      { path: ".history/a.md", stat: { size: 1, mtime: 1 } },
      { path: "daily/private.md", stat: { size: 1, mtime: 1 } },
      { path: "daily/visible.md", stat: { size: 1, mtime: 1 } },
    ] } as never, filter);
    const remote = await scanRemote({ listObjects: async () => [
      { key: ".history/a.md", size: 1, lastModified: 1 },
      { key: "daily/private.md", size: 1, lastModified: 1 },
      { key: "daily/visible.md", size: 1, lastModified: 1 },
    ], getObject: async () => new ArrayBuffer(0), headObject: async () => ({ key: "", size: 0, lastModified: 0 }), putObject: async () => ({ key: "", size: 0, lastModified: 0 }) }, filter);
    expect([...local.keys()]).toEqual(["daily/visible.md"]);
    expect([...remote.keys()]).toEqual(["daily/visible.md"]);
  });

  it("always excludes plugin and common temporary paths, and safely ignores invalid entries", () => {
    const filter = createVaultPathFilter({ ignoredPaths: ["../invalid", "/../invalid"] });
    expect(filter.ignores(".obsidian/plugins/mineral-obsidian-sync/main.js")).toBe(true);
    expect(filter.ignores("folder/Thumbs.db")).toBe(true);
    expect(filter.ignores("folder/note.tmp")).toBe(true);
    expect(filter.ignores("normal.md")).toBe(false);
  });
});

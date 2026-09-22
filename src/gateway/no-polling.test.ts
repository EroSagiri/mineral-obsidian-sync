import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Gateway disconnect must never degrade into remote polling.
 *
 * This is enforced as a source audit rather than a behavioral test because the failure it guards
 * against is an *addition*: a future change that adds a periodic R2 LIST to compensate for a broken
 * socket would pass every behavioral test while quietly turning the plugin into a poller. The only
 * permitted recurring timers are the Android local metadata probe and the explicitly named,
 * foreground-only integrity verification requested by the sync contract.
 */

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith("test-support.ts") ? [path] : [];
  });
}

describe("no desktop remote polling", () => {
  const files = sourceFiles(join(process.cwd(), "src"));

  it("has only the Android local probe and foreground integrity verification intervals", () => {
    const intervalSites = files.flatMap((path) => {
      const text = readFileSync(path, "utf8");
      const matches = [...text.matchAll(/setInterval\(/g)];
      return matches.map(() => path.replace(`${process.cwd()}\\`, "").replace(/\\/g, "/"));
    });
    expect(intervalSites).toHaveLength(2);
    expect(intervalSites.every((path) => path.includes("main.ts"))).toBe(true);
    const main = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");
    // The method body, not the call site inside onLayoutReady.
    const definition = main.lastIndexOf("private registerAndroidLocalDriftDetector");
    expect(definition).toBeGreaterThan(-1);
    const intervalBlock = main.slice(definition, definition + 1200);
    expect(intervalBlock).toContain("Platform.isAndroidApp");
    expect(intervalBlock).toContain("scanLocalAdapterMetadata");
    expect(intervalBlock).not.toContain("scanRemote");
    const integrity = main.lastIndexOf("private maybeRequestIntegrityReconcile");
    expect(integrity).toBeGreaterThan(-1);
    const integrityBlock = main.slice(integrity, integrity + 700);
    expect(integrityBlock).toContain('document.visibilityState === "hidden"');
    expect(integrityBlock).toContain('requestReconcile("integrity-check")');
  });

  it("never lists R2 from the gateway layer", () => {
    const gateway = files.filter((path) => path.includes(`${"gateway"}`));
    expect(gateway.length).toBeGreaterThan(0);
    for (const path of gateway) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toContain("listObjects");
      expect(text, path).not.toContain("LIST");
      expect(text, path).not.toContain("headObject");
      expect(text, path).not.toContain("getObject");
      expect(text, path).not.toContain("putObject");
    }
  });

  it("reaches the network from the gateway layer only through injected transports", () => {
    const gateway = files.filter((path) => path.includes("gateway"));
    for (const path of gateway) {
      const text = readFileSync(path, "utf8");
      // No direct fetch, and requestUrl only inside the one transport implementation.
      expect(text, path).not.toContain("fetch(");
      if (text.includes("requestUrl")) expect(path.endsWith("transport.ts")).toBe(true);
    }
  });

  it("does not mention forbidden future features in production sources", () => {
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      for (const forbidden of ["LiveDocumentRoom", "CRDT", "EventNotification", "new WebSocketServer"]) {
        expect(text, `${path} mentions ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

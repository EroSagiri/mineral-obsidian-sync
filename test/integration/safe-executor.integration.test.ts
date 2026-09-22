import { beforeEach, describe, expect, it } from "vitest";
import type { Vault } from "obsidian";
import { convergenceScenarioNames, lostResponseClient, runConvergenceScenarios, scanLocalNamespace } from "../../src/dev/integration/convergence";
import type { ConvergenceContext } from "../../src/dev/integration/convergence";
import { ignorePolicyFingerprint } from "../../src/sync/ignore";
import { SafeExecutor } from "../../src/sync/executor";
import { resetRequestUrlHandler } from "../obsidian";
import { installDomParserShim } from "./dom-parser-shim";
import type { FakeR2Options } from "./fake-r2";
import { createFakeVault, createMemoryStateStore } from "./fake-vault";
import type { FakeVault, FakeVaultOptions } from "./fake-vault";
import { CONFIG, createConvergenceHarness } from "./harness";

const statuses = (results: Array<{ name: string; status: string }>): string[] => results.map((result) => `${result.name}:${result.status}`);

async function build(fakeOptions: FakeR2Options = { bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId }, vaultOptions: FakeVaultOptions = {}) {
  const vault = createFakeVault({}, vaultOptions);
  const harness = await createConvergenceHarness(vault, fakeOptions);
  const state = createMemoryStateStore();
  const context: ConvergenceContext = {
    vault: vault as unknown as Vault,
    client: harness.convergenceClient,
    state,
    scratch: harness.scratch,
    identity: harness.convergenceIdentity,
    ignorePolicy: ignorePolicyFingerprint({ ignoredPaths: [] }),
    ambiguousClient: lostResponseClient(harness.convergenceClient),
  };
  return { ...harness, vault: vault as FakeVault, state, context };
}

describe("SafeExecutor integration over an in-process R2 emulator", () => {
  beforeEach(() => {
    // The harness observes remote state with ListObjectsV2, so the XML parser shim is needed.
    installDomParserShim();
    resetRequestUrlHandler();
  });

  it("creates the hidden scratch folder chain, because Vault.createBinary does not mkdir parents", async () => {
    const { vault, scratch } = await build();
    expect(scratch.kind).toBe("hidden");
    expect(scratch.root).toBe(`.mineral-sync-test/20260922T001500Z/convergence/`);
    expect(vault.folders.has(".mineral-sync-test")).toBe(true);
    expect(vault.folders.has(".mineral-sync-test/20260922T001500Z/convergence")).toBe(true);
    expect(scratch.diagnostics.every((entry) => !entry.includes("FAILED"))).toBe(true);
  });

  it("converges, then treats the second reconciliation as a noop", async () => {
    const { fake, vault, state, scratch, context } = await build();
    const results = await runConvergenceScenarios(context);

    expect(statuses(results)).toEqual(convergenceScenarioNames().map((name) => `${name}:pass`));

    const converge = results.find((result) => result.name === "safe-executor-convergence")!;
    expect(converge.observations.find((entry) => entry.name === "first plan")?.value).toBe("upload:1");
    expect(converge.observations.find((entry) => entry.name === "first execution")?.value).toBe("applied:1");
    expect(converge.observations.find((entry) => entry.name === "previous-state commit")?.value).toBe("1 entry");
    expect(converge.observations.find((entry) => entry.name === "second plan")?.value).toBe("noop:1");

    // Baselines exist for the reconciled uploads and for every applied download.
    expect([...state.entries.keys()].sort()).toEqual([
      `${scratch.root}existing/parent/kept.md`,
      `${scratch.root}multi/level/deep/foo.md`,
      `${scratch.root}one-level/foo.md`,
      `${scratch.root}remote-advanced.md`,
      `${scratch.root}root-file.md`,
      `${scratch.root}stale-remote.md`,
      `${scratch.root}test-file.md`,
    ]);

    // Every remote object stays inside the run prefix, and every local file inside the run base
    // (the capability probe lives outside the scenario root so it can never enter a plan).
    const base = scratch.root.slice(0, -"convergence/".length);
    expect(fake.objects.size).toBe(11);
    expect([...fake.objects.keys()].every((key) => key.startsWith(`sync/.mineral-sync-test/20260922T001500Z/`))).toBe(true);
    expect([...vault.files.keys()].every((key) => key.startsWith(base))).toBe(true);
    expect([...vault.files.keys()].some((key) => key === `${base}local-probe/probe.bin`)).toBe(true);
    expect(scanLocalNamespace(vault as unknown as Vault, scratch.root).size).toBe(11);

    // The execution path never issues a HEAD: remote state comes from LIST, writes are recorded
    // from their own PUT response, and reads are conditional GETs. This is why the Android
    // limitation on non-2xx HEAD responses cannot affect the product.
    expect(fake.requests.filter((request) => (request.method ?? "GET").toUpperCase() === "HEAD")).toEqual([]);
  });

  it("records the stale, unresolved and blocked outcomes it observed", async () => {
    const { context } = await build();
    const results = await runConvergenceScenarios(context);
    const observation = (scenario: string, name: string) => results.find((result) => result.name === scenario)?.observations.find((entry) => entry.name === name)?.value;

    expect(observation("stale-remote-preserved", "execution")).toBe("stale/remote-changed");
    expect(observation("stale-remote-preserved", "previous state mutated")).toBe(false);
    expect(observation("stale-remote-preserved", "newer remote body preserved")).toBe(true);
    expect(observation("stale-local-preserved", "execution")).toBe("stale/local-changed");
    expect(observation("stale-local-preserved", "previous state mutated")).toBe(false);
    expect(observation("state-commit-failure", "execution")).toBe("unresolved/state-commit-failed");
    expect(observation("state-commit-failure", "R2 write preserved")).toBe(true);
    expect(observation("ambiguous-put", "execution")).toBe("unresolved/ambiguous-put");
    expect(observation("ambiguous-put", "remote object present")).toBe(true);
  });

  it("uses the visible fallback root and still keeps every object key inside the run prefix", async () => {
    const { fake, vault, scratch, context } = await build({ bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId }, { refuseDotFolders: true });

    expect(scratch.kind).toBe("fallback");
    expect(scratch.root).toBe("private/mineral-sync-test-local/20260922T001500Z/convergence/");
    expect(scratch.clientPrefix).toBe("sync/.mineral-sync-test/20260922T001500Z/");

    const results = await runConvergenceScenarios(context);
    expect(statuses(results)).toEqual(convergenceScenarioNames().map((name) => `${name}:pass`));

    expect(vault.files.size).toBeGreaterThan(0);
    const base = scratch.root.slice(0, -"convergence/".length);
    expect([...vault.files.keys()].every((key) => key.startsWith(base))).toBe(true);
    expect(fake.objects.size).toBe(11);
    expect([...fake.objects.keys()].every((key) => key.startsWith("sync/.mineral-sync-test/20260922T001500Z/"))).toBe(true);
  });

  it("fails the stale-remote scenario when the endpoint ignores If-Match", async () => {
    const { context } = await build({ bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId, ignoreIfMatch: true });
    const results = await runConvergenceScenarios(context);

    expect(results.find((result) => result.name === "stale-remote-preserved")?.status).toBe("fail");
    expect(results.find((result) => result.name === "stale-remote-preserved")?.detail).toContain("instead of stale");
    expect(results.find((result) => result.name === "safe-executor-convergence")?.status).toBe("pass");
  });

  it("fails closed instead of overwriting an existing local file at a scratch key", async () => {
    const { vault, scratch, context } = await build();
    const key = scratch.key("test-file.md");
    vault.files.set(key, { bytes: new Uint8Array([9, 9]), mtime: 1 });

    const results = await runConvergenceScenarios(context);
    const converge = results.find((result) => result.name === "safe-executor-convergence")!;
    expect(converge.status).toBe("fail");
    expect(converge.detail).toContain("refusing to create");
    expect(vault.files.get(key)!.bytes).toEqual(new Uint8Array([9, 9]));
  });

  it("keeps remote deletion blocked, because it cannot name the version it would remove", async () => {
    const { context, scratch } = await build();
    const executor = new SafeExecutor(context.vault, context.client, context.state, context.identity, context.ignorePolicy);
    const key = scratch.key("test-file.md");

    await expect(executor.execute({ type: "delete-remote", key, reason: "integration" })).resolves.toEqual({ status: "blocked", key, reason: "remote-deletion-requires-version-identity" });
  });

  it("propagates a remote deletion to the local file through trash, then retires the baseline", async () => {
    const { context, vault, state, scratch } = await build();
    const key = scratch.key("deletion-target.md");
    await vault.createBinary(key, new Uint8Array([1, 2, 3]).buffer);
    state.put({ key, local: { size: 3, mtime: 1 }, remote: { size: 3, etag: "A" }, syncedAt: 1 });
    const stat = await vault.adapter.stat(key);
    const trashed: string[] = [];
    const executor = new SafeExecutor(context.vault, context.client, context.state, context.identity, context.ignorePolicy, { trash: async (target) => { trashed.push(target.path); await vault.remove(target); } });

    const result = await executor.execute({ type: "delete-local", key, reason: "integration", expectedLocal: { key, size: stat!.size, mtime: stat!.mtime } });
    expect(result).toEqual({ status: "applied", key });
    expect(trashed).toEqual([key]);
    expect(vault.getFileByPath(key)).toBeNull();
    // Both sides are now absent, so the baseline that described this key has been retired.
    expect(state.entries.has(key)).toBe(false);
  });
});

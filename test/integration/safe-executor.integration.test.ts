import { beforeEach, describe, expect, it } from "vitest";
import type { Vault } from "obsidian";
import { convergenceScenarioNames, lostResponseClient, runConvergenceScenarios, scanLocalNamespace } from "../../src/dev/integration/convergence";
import type { ConvergenceContext } from "../../src/dev/integration/convergence";
import { ignorePolicyFingerprint } from "../../src/sync/ignore";
import { SafeExecutor } from "../../src/sync/executor";
import { resetRequestUrlHandler } from "../obsidian";
import type { FakeR2Options } from "./fake-r2";
import { createFakeVault, createMemoryStateStore } from "./fake-vault";
import { CONFIG, createHarness } from "./harness";

const statuses = (results: Array<{ name: string; status: string }>): string[] => results.map((result) => `${result.name}:${result.status}`);

function build(options: FakeR2Options = { bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId }) {
  const harness = createHarness(options);
  const vault = createFakeVault();
  const state = createMemoryStateStore();
  const context: ConvergenceContext = {
    vault: vault as unknown as Vault,
    client: harness.client,
    state,
    namespace: harness.namespace,
    identity: harness.identity,
    ignorePolicy: ignorePolicyFingerprint({ ignoredPaths: [] }),
    ambiguousClient: lostResponseClient(harness.client),
  };
  return { ...harness, vault, state, context };
}

describe("SafeExecutor integration over an in-process R2 emulator", () => {
  beforeEach(() => resetRequestUrlHandler());

  it("converges, then treats the second reconciliation as a noop", async () => {
    const { fake, vault, state, namespace, context } = build();
    const results = await runConvergenceScenarios(context);

    expect(statuses(results)).toEqual(convergenceScenarioNames().map((name) => `${name}:pass`));

    const converge = results.find((result) => result.name === "safe-executor-convergence")!;
    expect(converge.observations.find((entry) => entry.name === "first plan")?.value).toBe("upload:1");
    expect(converge.observations.find((entry) => entry.name === "first execution")?.value).toBe("applied:1");
    expect(converge.observations.find((entry) => entry.name === "previous-state commit")?.value).toBe("1 entry");
    expect(converge.observations.find((entry) => entry.name === "second plan")?.value).toBe("noop:1");

    // Only the two successfully reconciled keys hold a baseline.
    expect([...state.entries.keys()].sort()).toEqual([`${namespace.root}convergence/stale-remote.md`, `${namespace.root}convergence/test-file.md`]);

    // Every remote object lives inside the run prefix, and every local file inside the run root.
    expect(fake.objects.size).toBe(5);
    expect([...fake.objects.keys()].every((key) => key.startsWith(`sync/${namespace.root}`))).toBe(true);
    expect([...vault.files.keys()].every((key) => key.startsWith(namespace.root))).toBe(true);
    expect(scanLocalNamespace(vault as unknown as Vault, namespace.root).size).toBe(5);
  });

  it("records the stale, unresolved and blocked outcomes it observed", async () => {
    const { context } = build();
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

  it("fails the stale-remote scenario when the endpoint ignores If-Match", async () => {
    const { context } = build({ bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId, ignoreIfMatch: true });
    const results = await runConvergenceScenarios(context);

    expect(results.find((result) => result.name === "stale-remote-preserved")?.status).toBe("fail");
    expect(results.find((result) => result.name === "stale-remote-preserved")?.detail).toContain("instead of stale");
    // The convergence path itself is unaffected, which proves the failure is specific.
    expect(results.find((result) => result.name === "safe-executor-convergence")?.status).toBe("pass");
  });

  it("fails closed instead of overwriting an existing local file at a test key", async () => {
    const { vault, namespace, context } = build();
    vault.files.set(namespace.key("convergence/test-file.md"), { bytes: new Uint8Array([9, 9]), mtime: 1 });

    const results = await runConvergenceScenarios(context);
    const converge = results.find((result) => result.name === "safe-executor-convergence")!;
    expect(converge.status).toBe("fail");
    expect(converge.detail).toContain("refusing to create");
    expect(vault.files.get(namespace.key("convergence/test-file.md"))!.bytes).toEqual(new Uint8Array([9, 9]));
  });

  it("keeps deletion hard-blocked through the real executor", async () => {
    const { context } = build();
    const executor = new SafeExecutor(context.vault, context.client, context.state, context.identity, context.ignorePolicy);
    const key = context.namespace.key("convergence/test-file.md");

    await expect(executor.execute({ type: "delete-remote", key, reason: "integration" })).resolves.toEqual({ status: "blocked", key, reason: "deletion-not-supported-in-phase-2a" });
    await expect(executor.execute({ type: "delete-local", key, reason: "integration" })).resolves.toEqual({ status: "blocked", key, reason: "deletion-not-supported-in-phase-2a" });
  });
});

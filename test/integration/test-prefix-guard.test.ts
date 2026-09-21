import { beforeEach, describe, expect, it } from "vitest";
import { GuardedIntegrationClient, IntegrationTestEscapeError } from "../../src/dev/integration/guarded-client";
import {
  INTEGRATION_FALLBACK_ROOT,
  INTEGRATION_TEST_ROOT,
  IntegrationTestNamespace,
  assertIntegrationLocalKey,
  assertIntegrationObjectKey,
  assertIntegrationTestKey,
  formatRunId,
  mintScopedKey,
} from "../../src/dev/integration/test-namespace";
import { SignedR2ListClient } from "../../src/remote/r2-client";
import { resetRequestUrlHandler } from "../obsidian";
import { installDomParserShim } from "./dom-parser-shim";
import { CONFIG, RUN_ID, createHarness } from "./harness";

const RUN_ROOT = `${INTEGRATION_TEST_ROOT}${RUN_ID}/`;
const FALLBACK_RUN_ROOT = `${INTEGRATION_FALLBACK_ROOT}${RUN_ID}/`;

describe("integration test-prefix guard", () => {
  beforeEach(() => {
    installDomParserShim();
    resetRequestUrlHandler();
  });

  it("accepts only run-scoped keys under .mineral-sync-test/", () => {
    expect(INTEGRATION_TEST_ROOT).toBe(".mineral-sync-test/");
    for (const key of [`${RUN_ROOT}x.md`, `${RUN_ROOT}convergence/deep/file.bin`]) expect(() => assertIntegrationTestKey(key)).not.toThrow();
  });

  it("rejects every key that could reach a canonical Vault object", () => {
    const escaped = [
      "Notes/private.md",
      ".mineral-sync-test/",
      ".mineral-sync-test",
      ".mineral-sync-test/../Notes/private.md",
      ".mineral-sync-test-evil/private.md",
      ".mineral-sync-test/not-a-run-id/private.md",
      "/.mineral-sync-test/20260101T000000Z/private.md",
      "../.mineral-sync-test/20260101T000000Z/private.md",
      "sync/.mineral-sync-test/20260101T000000Z/private.md",
    ];
    for (const key of escaped) expect(() => assertIntegrationTestKey(key), key).toThrow(IntegrationTestEscapeError);
  });

  it("mints scoped keys and refuses traversal leaves", () => {
    const namespace = IntegrationTestNamespace.fromRunId(RUN_ID);
    expect(namespace.key("convergence/test-file.md")).toBe(`${RUN_ROOT}convergence/test-file.md`);
    expect(mintScopedKey(FALLBACK_RUN_ROOT, "convergence/test-file.md")).toBe(`${FALLBACK_RUN_ROOT}convergence/test-file.md`);
    for (const leaf of ["../escape.md", "/absolute.md", "a/../b.md", "", "a//b.md", "a\\b.md", "."]) {
      expect(() => namespace.key(leaf), leaf).toThrow(IntegrationTestEscapeError);
      expect(() => mintScopedKey(FALLBACK_RUN_ROOT, leaf), leaf).toThrow(IntegrationTestEscapeError);
    }
    expect(() => namespace.assertOwns(`${INTEGRATION_TEST_ROOT}20260101T000000Z/x.md`)).toThrow(IntegrationTestEscapeError);
  });

  it("formats run ids as UTC second stamps", () => {
    expect(formatRunId(new Date("2026-09-22T00:15:00.000Z"))).toBe("20260922T001500Z");
    const namespace = IntegrationTestNamespace.mint(new Date("2026-09-22T00:15:00.000Z"));
    expect(namespace.root).toBe(RUN_ROOT);
    expect(namespace.preferredLocalBase).toBe(RUN_ROOT);
    expect(namespace.fallbackLocalBase).toBe(FALLBACK_RUN_ROOT);
  });

  it("verifies the mapped object key against the configured remote prefix", () => {
    expect(() => assertIntegrationObjectKey(`sync/${RUN_ROOT}a.md`, "sync", RUN_ROOT)).not.toThrow();
    expect(() => assertIntegrationObjectKey(`${RUN_ROOT}a.md`, "", RUN_ROOT)).not.toThrow();
    // The fallback local root nests, but the object key still sits inside the run root.
    expect(() => assertIntegrationObjectKey(`sync/${RUN_ROOT}${FALLBACK_RUN_ROOT}a.md`, "sync", RUN_ROOT)).not.toThrow();
    for (const objectKey of [`sync/${RUN_ROOT.slice(0, -1)}`, "sync/Notes/private.md", `other/${RUN_ROOT}a.md`, `sync/${INTEGRATION_TEST_ROOT}20260101T000000Z/x.md`]) {
      expect(() => assertIntegrationObjectKey(objectKey, "sync", RUN_ROOT), objectKey).toThrow(IntegrationTestEscapeError);
    }
  });

  it("verifies the local scratch key against the resolved local root", () => {
    expect(() => assertIntegrationLocalKey(`${RUN_ROOT}convergence/a.md`, `${RUN_ROOT}convergence/`)).not.toThrow();
    expect(() => assertIntegrationLocalKey(`${RUN_ROOT}a.md`, `${RUN_ROOT}convergence/`)).toThrow(IntegrationTestEscapeError);
    expect(() => assertIntegrationLocalKey("Notes/private.md", `${RUN_ROOT}convergence/`)).toThrow(IntegrationTestEscapeError);
  });

  it("refuses escaped keys before any HTTP request is made", async () => {
    const { fake, client } = createHarness();
    const body = new Uint8Array([1, 2, 3]).buffer;
    for (const key of ["Notes/private.md", ".mineral-sync-test/../private.md", ".mineral-sync-test-evil/x.md", ".mineral-sync-test/20260922T001500Z-evil/x.md"]) {
      await expect(client.putObject(key, body, { ifNoneMatch: "*" })).rejects.toBeInstanceOf(IntegrationTestEscapeError);
      await expect(client.getObject(key)).rejects.toBeInstanceOf(IntegrationTestEscapeError);
      await expect(client.headObject(key)).rejects.toBeInstanceOf(IntegrationTestEscapeError);
    }
    expect(fake.requests).toHaveLength(0);
    expect(fake.objects.size).toBe(0);
  });

  it("never lists a key outside the run namespace", async () => {
    const { fake, namespace, client } = createHarness();
    fake.objects.set("sync/Notes/real-vault-note.md", { bytes: new Uint8Array([1]), etag: "etag-real", lastModified: 1 });
    fake.objects.set(`sync/${namespace.root}list/inside.md`, { bytes: new Uint8Array([2]), etag: "etag-test", lastModified: 2 });

    expect((await client.listObjects()).map((entry) => entry.key)).toEqual([`${namespace.root}list/inside.md`]);
  });

  it("never lists a key outside the run namespace when no remote prefix is configured", async () => {
    const { fake, namespace } = createHarness();
    fake.objects.set("Notes/real-vault-note.md", { bytes: new Uint8Array([1]), etag: "etag-real", lastModified: 1 });
    fake.objects.set(`${namespace.root}list/inside.md`, { bytes: new Uint8Array([2]), etag: "etag-test", lastModified: 2 });

    const unprefixed = new GuardedIntegrationClient(new SignedR2ListClient({ ...CONFIG, remotePrefix: "" }), "", {
      configuredPrefix: "",
      objectRoot: namespace.objectRoot,
      localRoot: namespace.root,
    });
    expect((await unprefixed.listObjects()).map((entry) => entry.key)).toEqual([`${namespace.root}list/inside.md`]);
  });
});

import type { Vault } from "obsidian";
import { sameBytes, utf8 } from "./bytes";
import { errorMessage } from "./result";
import { INTEGRATION_FALLBACK_ROOT, assertIntegrationLocalKey, mintScopedKey, normalizeConfiguredPrefix } from "./test-namespace";
import type { IntegrationTestNamespace } from "./test-namespace";

/**
 * Resolves a Vault-relative scratch root the **real** Obsidian Vault API can actually use.
 *
 * Why this exists: `Vault.createBinary` does not create missing parent folders, and Obsidian
 * may additionally refuse to create a dot-directory. A real run on 2026-09-21T17:10Z failed
 * with `ENOENT ... .mineral-sync-test/<run>/convergence/test-file.md` before a single byte was
 * written. So the harness now:
 *
 *   1. creates the folder chain explicitly (never relying on `createBinary` to mkdir),
 *   2. *probes* the preferred hidden root end-to-end with the exact Vault calls the scenarios
 *      use (`createBinary`/`getFileByPath`/`getFiles`/`readBinary`/`adapter.stat`/`modifyBinary`),
 *   3. falls back to a run-scoped visible root under `private/` only if that probe fails.
 *
 * The R2 invariant does not depend on which root wins: for the fallback the convergence client
 * is configured with a remote prefix that already ends in `.mineral-sync-test/<run-id>/`, so
 * every object key still lands inside the test root.
 */

export interface LocalScratch {
  kind: "hidden" | "fallback";
  /** Vault-relative root containing every local scratch file the convergence scenarios use. */
  root: string;
  /** Full remotePrefix the convergence R2 client must be built with. */
  clientPrefix: string;
  /** R2 object prefix, relative to the user's configured prefix, every object key must be inside. */
  objectRoot: string;
  /** Probe trail, reported verbatim so a failure is diagnosable without another blind run. */
  diagnostics: string[];
  key(leaf: string): string;
}

interface ProbeResult {
  ok: boolean;
  diagnostics: string[];
}

const PROBE_LEAF = "local-probe/probe.bin";
const PROBE_BYTES = utf8("mineral sync integration local probe v1");
const PROBE_UPDATE = utf8("mineral sync integration local probe v1 edited");

async function folderExists(vault: Vault, path: string): Promise<boolean> {
  try {
    return await vault.adapter.exists(path);
  } catch {
    return false;
  }
}

/** Creates one folder, tolerating "already exists" and falling back to the raw adapter. */
export async function ensureFolder(vault: Vault, path: string): Promise<void> {
  if (await folderExists(vault, path)) return;
  let failure: unknown;
  try {
    await vault.createFolder(path);
  } catch (error) {
    failure = error;
  }
  if (await folderExists(vault, path)) return;
  try {
    await vault.adapter.mkdir(path);
  } catch (error) {
    failure ??= error;
  }
  if (await folderExists(vault, path)) return;
  throw new Error(`could not create folder "${path}": ${errorMessage(failure)}`);
}

/** Creates every ancestor level; `Vault.createFolder` is not recursive. */
export async function ensureFolderTree(vault: Vault, path: string): Promise<void> {
  const segments = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
  for (let index = 1; index <= segments.length; index += 1) await ensureFolder(vault, segments.slice(0, index).join("/"));
}

/** Exercises exactly the Vault surface the convergence scenarios depend on. */
async function probeLocalRoot(vault: Vault, base: string, label: string): Promise<ProbeResult> {
  const diagnostics: string[] = [];
  const step = async (name: string, action: () => Promise<void>): Promise<boolean> => {
    try {
      await action();
      diagnostics.push(`${label}:${name}=ok`);
      return true;
    } catch (error) {
      diagnostics.push(`${label}:${name}=FAILED (${errorMessage(error)})`);
      return false;
    }
  };

  if (!(await step("create-folders", () => ensureFolderTree(vault, `${base}convergence`)))) return { ok: false, diagnostics };
  if (!(await step("create-folders-probe", () => ensureFolderTree(vault, `${base}local-probe`)))) return { ok: false, diagnostics };

  const probeKey = `${base}${PROBE_LEAF}`;
  if (!(await step("createBinary", async () => void (await vault.createBinary(probeKey, PROBE_BYTES))))) return { ok: false, diagnostics };
  if (!(await step("getFileByPath", async () => void requireFile(vault, probeKey)))) return { ok: false, diagnostics };
  if (!(await step("getFiles", async () => {
    if (!vault.getFiles().some((file) => file.path === probeKey)) throw new Error("created file is not present in vault.getFiles()");
  }))) return { ok: false, diagnostics };
  if (!(await step("readBinary", async () => {
    if (!sameBytes(await vault.readBinary(requireFile(vault, probeKey)), PROBE_BYTES)) throw new Error("readBinary returned different bytes");
  }))) return { ok: false, diagnostics };
  if (!(await step("adapter.stat", async () => {
    const stat = await vault.adapter.stat(probeKey);
    if (!stat || stat.size !== PROBE_BYTES.byteLength) throw new Error(`adapter.stat returned ${stat ? stat.size : "null"}`);
  }))) return { ok: false, diagnostics };
  if (!(await step("modifyBinary", async () => {
    await vault.modifyBinary(requireFile(vault, probeKey), PROBE_UPDATE);
    if (!sameBytes(await vault.readBinary(requireFile(vault, probeKey)), PROBE_UPDATE)) throw new Error("modifyBinary did not take effect");
  }))) return { ok: false, diagnostics };

  return { ok: true, diagnostics };
}

function requireFile(vault: Vault, path: string): NonNullable<ReturnType<Vault["getFileByPath"]>> {
  const file = vault.getFileByPath(path);
  if (!file) throw new Error(`vault.getFileByPath("${path}") returned null`);
  return file;
}

function buildScratch(kind: LocalScratch["kind"], base: string, objectRoot: string, clientPrefix: string, diagnostics: string[]): LocalScratch {
  const root = `${base}convergence/`;
  return {
    kind,
    root,
    objectRoot,
    clientPrefix,
    diagnostics,
    key: (leaf: string): string => {
      const key = mintScopedKey(root, leaf);
      assertIntegrationLocalKey(key, root);
      return key;
    },
  };
}

export type LocalScratchResolution = { ok: true; scratch: LocalScratch } | { ok: false; diagnostics: string[] };

export async function resolveLocalScratch(vault: Vault, namespace: IntegrationTestNamespace, configuredPrefix: string): Promise<LocalScratchResolution> {
  const configured = normalizeConfiguredPrefix(configuredPrefix);

  const hidden = await probeLocalRoot(vault, namespace.preferredLocalBase, "hidden");
  if (hidden.ok) {
    return { ok: true, scratch: buildScratch("hidden", namespace.preferredLocalBase, namespace.objectRoot, configuredPrefix, [...hidden.diagnostics, `chosen local root: ${namespace.preferredLocalBase}convergence/`]) };
  }

  const fallback = await probeLocalRoot(vault, namespace.fallbackLocalBase, "fallback");
  if (fallback.ok) {
    // The fallback Vault path does not start with the test root, so the remote prefix is widened
    // until it does: every object key is still forced inside `.mineral-sync-test/<run-id>/`.
    const scratch = buildScratch("fallback", namespace.fallbackLocalBase, namespace.objectRoot, `${configured}${namespace.objectRoot}`, [
      ...hidden.diagnostics,
      ...fallback.diagnostics,
      `chosen local root: ${namespace.fallbackLocalBase}convergence/ (Obsidian refused ${namespace.preferredLocalBase})`,
    ]);
    return { ok: true, scratch };
  }

  return { ok: false, diagnostics: [...hidden.diagnostics, ...fallback.diagnostics] };
}

export { INTEGRATION_FALLBACK_ROOT };

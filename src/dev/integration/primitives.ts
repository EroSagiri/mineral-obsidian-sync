import type { RemoteEntry } from "../../sync/types";
import { randomBytes as secureRandomBytes, toArrayBuffer, utf8 } from "./bytes";
import { classifyTransportError } from "./classify";
import { headErrorsAreOpaque } from "./context";
import type { TransportScenarioContext } from "./context";
import { errorMessage, observation, ScenarioFailure } from "./result";
import type { ScenarioObservation } from "./result";

/**
 * Per-primitive capability matrix: happy paths **and** error paths.
 *
 * The scenario-style tests abort at their first failed request, which is the wrong shape for
 * diagnosing a platform, and a matrix of only successful calls is worse: on Obsidian for Android
 * (2026-09-21) all twelve happy-path probes passed while every scenario still failed, because
 * every scenario begins by HEADing a key that does not exist yet. A 404 HEAD carries no body and
 * Android's transport throws `Request Failed. IOException Stream closed` for it, so the matrix now
 * probes the error paths too.
 *
 * It also solves the attribution problem: the product's `putObject` confirms a write with a
 * conditional `HEAD`, so a broken HEAD would make a *successful* PUT look failed. `ListObjectsV2`
 * is a plain GET, so after each write the matrix lists the run root and records whether the object
 * actually landed. That separates "the write failed" from "the confirmation failed".
 */

const UPDATE_V1 = "primitive probe v1";
const UPDATE_V2 = "primitive probe v2 updated";
const BIG_SIZE = 64 * 1024;
/** Never a real ETag, so every If-Match built from it must be rejected as stale. */
const STALE_ETAG = "0000000000000000000000000000dead";

export async function primitivesScenario(context: TransportScenarioContext): Promise<ScenarioObservation[]> {
  const observations: ScenarioObservation[] = [];
  const failures: string[] = [];
  const record = (name: string, value: string): void => {
    observations.push(observation(name, value));
    if (value.startsWith("FAILED")) failures.push(name);
  };
  const attempt = async (name: string, action: () => Promise<string>): Promise<void> => {
    try {
      record(name, await action());
    } catch (error) {
      record(name, `FAILED: ${errorMessage(error)}`);
    }
  };
  /**
   * An error path is "ok" only when it produces the expected *typed* error, not a transport throw.
   *
   * `safeWhenOpaque` marks the two HEAD probes: on mobile the platform cannot deliver a non-2xx
   * HEAD response at all, and an opaque failure on those requests is harmless because a HEAD never
   * gates a write — it only confirms one. Every probe the product's correctness depends on (GET and
   * PUT error paths, and all happy paths) stays strictly typed on every platform.
   */
  const expectError = async (name: string, expected: string, action: () => Promise<unknown>, safeWhenOpaque = false): Promise<void> => {
    try {
      await action();
      record(name, `FAILED: expected ${expected}, but the call succeeded`);
    } catch (error) {
      const kind = classifyTransportError(error);
      if (kind === expected) {
        record(name, `ok: ${kind}`);
        return;
      }
      if (safeWhenOpaque && kind === "transport-error" && headErrorsAreOpaque(context.platform)) {
        record(name, "ok on mobile: transport-error, response dropped by the platform (never gates a write)");
        return;
      }
      record(name, `FAILED: expected ${expected}, got ${kind} (${errorMessage(error)})`);
    }
  };

  const list = async (): Promise<Map<string, RemoteEntry>> => new Map((await context.client.listObjects()).map((entry) => [entry.key, entry]));
  const quietList = async (): Promise<Map<string, RemoteEntry>> => list().catch(() => new Map<string, RemoteEntry>());
  /** Ground truth: did the object really land, whatever the write call reported? */
  const presence = async (name: string, key: string, expectedSize: number): Promise<void> => {
    const entry = (await quietList()).get(key);
    if (!entry) {
      record(name, "FAILED: object absent — the write did not land");
      return;
    }
    record(name, entry.size === expectedSize ? `present size=${entry.size} etag=${entry.etag ?? "none"}` : `FAILED: present with size=${entry.size}, expected ${expectedSize}`);
  };

  const smallKey = context.namespace.key("primitives/small.txt");
  const bigKey = context.namespace.key("primitives/large.bin");
  const absentKey = context.namespace.key("primitives/absent.txt");
  const v1 = utf8(UPDATE_V1);
  const v2 = utf8(UPDATE_V2);
  const big = toArrayBuffer((context.randomBytes ?? secureRandomBytes)(BIG_SIZE));

  // ---- happy paths ----
  await attempt("LIST", async () => `ok, ${(await list()).size} object(s) under the run root`);

  await attempt("PUT If-None-Match:* small", async () => `ok etag=${(await context.client.putObject(smallKey, v1, { ifNoneMatch: "*" })).etag ?? "none"}`);
  await presence("LIST after small PUT", smallKey, v1.byteLength);

  await attempt("PUT If-None-Match:* 64 KiB", async () => `ok etag=${(await context.client.putObject(bigKey, big, { ifNoneMatch: "*" })).etag ?? "none"}`);
  await presence("LIST after 64 KiB PUT", bigKey, BIG_SIZE);

  await attempt("GET", async () => `ok, ${(await context.client.getObject(smallKey)).byteLength} B`);
  await attempt("GET 64 KiB", async () => `ok, ${(await context.client.getObject(bigKey)).byteLength} B`);
  await attempt("HEAD", async () => `ok, size=${(await context.client.headObject(smallKey)).size}`);

  // An ETag from LIST lets the conditional primitives be probed even when HEAD is unusable.
  const etag = (await quietList()).get(smallKey)?.etag;
  if (etag) {
    await attempt("GET If-Match (matching)", async () => `ok, ${(await context.client.getObject(smallKey, { ifMatch: etag })).byteLength} B`);
    await attempt("HEAD If-Match (matching)", async () => `ok, size=${(await context.client.headObject(smallKey, { ifMatch: etag })).size}`);
    await attempt("PUT If-Match (update)", async () => `ok etag=${(await context.client.putObject(smallKey, v2, { ifMatch: etag })).etag ?? "none"}`);
    await presence("LIST after update", smallKey, v2.byteLength);
  } else {
    record("conditional happy paths", "skipped: LIST returned no ETag, so If-Match cannot be probed");
  }

  // ---- error paths: 404 and 412 on every method the product uses ----
  await expectError("HEAD absent → http-404", "http-404", () => context.client.headObject(absentKey), true);
  await expectError("GET absent → http-404", "http-404", () => context.client.getObject(absentKey));
  await expectError("HEAD If-Match (stale) → precondition", "precondition-failed", () => context.client.headObject(smallKey, { ifMatch: STALE_ETAG }), true);
  await expectError("GET If-Match (stale) → precondition", "precondition-failed", () => context.client.getObject(smallKey, { ifMatch: STALE_ETAG }));
  await expectError("PUT If-None-Match:* on existing → precondition", "precondition-failed", () => context.client.putObject(smallKey, v1, { ifNoneMatch: "*" }));
  await expectError("PUT If-Match (stale) → precondition", "precondition-failed", () => context.client.putObject(smallKey, v1, { ifMatch: STALE_ETAG }));
  // A rejected conditional write must leave the object exactly as it was.
  await presence("LIST after rejected create", smallKey, v2.byteLength);
  await presence("LIST after rejected stale write", smallKey, v2.byteLength);

  if (failures.length) throw new ScenarioFailure(`${failures.length} of ${observations.length} primitive probes failed: ${failures.join(", ")}`, observations);
  return observations;
}

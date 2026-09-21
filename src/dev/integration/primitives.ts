import type { RemoteEntry } from "../../sync/types";
import { randomBytes as secureRandomBytes, toArrayBuffer, utf8 } from "./bytes";
import type { TransportScenarioContext } from "./context";
import { observation, ScenarioFailure } from "./result";
import type { ScenarioObservation } from "./result";

/**
 * Per-primitive capability matrix.
 *
 * The scenario-style tests abort at their first failed request, which is exactly the wrong shape
 * for diagnosing a platform: on Android (2026-09-21) every transport scenario died at its first
 * `HEAD`, so PUT, conditional PUT and conditional GET were never reached at all.
 *
 * This matrix probes each primitive independently and never aborts.
 *
 * It also solves the attribution problem: the product's `putObject` confirms a write with a
 * conditional `HEAD`, so a broken HEAD makes a *successful* PUT look failed. `ListObjectsV2` is a
 * plain GET, so after each write the matrix lists the run root and records whether the object
 * actually landed. That separates "the write failed" from "the confirmation failed".
 */

const UPDATE_V1 = "primitive probe v1";
const UPDATE_V2 = "primitive probe v2 updated";
const BIG_SIZE = 64 * 1024;

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
      record(name, `FAILED: ${error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 160) : "unknown error"}`);
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
  const v1 = utf8(UPDATE_V1);
  const v2 = utf8(UPDATE_V2);
  const big = toArrayBuffer((context.randomBytes ?? secureRandomBytes)(BIG_SIZE));

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
    record("conditional primitives", "skipped: LIST returned no ETag, so If-Match cannot be probed");
  }

  if (failures.length) throw new ScenarioFailure(`${failures.length} of ${observations.length} primitive probes failed: ${failures.join(", ")}`, observations);
  return observations;
}

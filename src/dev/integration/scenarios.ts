import { RemoteHttpError, RemoteObjectChangedError } from "../../remote/errors";
import type { R2Client } from "../../remote/r2-client";
import { sha256 } from "../../sync/fingerprint";
import { randomBytes as secureRandomBytes, sameBytes, toArrayBuffer, utf8 } from "./bytes";
import type { TransportScenarioContext } from "./context";
import { primitivesScenario } from "./primitives";
import { IntegrationTestEscapeError } from "./test-namespace";
import { observation, require, runScenario } from "./result";
import type { ScenarioObservation, ScenarioResult } from "./result";

/**
 * Transport-level scenarios. They exercise conditional create/update/GET, binary bodies and
 * scoped listing through whatever {@link R2Client} they are handed. The same module is used
 * by the in-process R2 emulator tests and by the real Obsidian `requestUrl` self-test, so a
 * difference in the two runs isolates the transport itself.
 */

const CREATE_V1 = "mineral sync integration create v1";
const SHOULD_NOT_OVERWRITE = "SHOULD NOT OVERWRITE";
/** Never a real ETag; a conditional HEAD must reject it instead of returning metadata. */
const BOGUS_ETAG = "0000000000000000000000000000dead";

export const BINARY_SIZES = { small: 64 * 1024, large: 1024 * 1024 } as const;

export type { TransportScenarioContext } from "./context";

export function transportScenarioNames(): string[] {
  return ["test-prefix-guard", "transport-primitives", "conditional-create", "conditional-update", "conditional-get", "conditional-head", "list-scoped", "binary-roundtrip-64k", "binary-roundtrip-1m"];
}

/** Maps a thrown error onto a stable category so a report never depends on message text. */
function classify(error: unknown): string {
  if (error instanceof RemoteObjectChangedError) return "precondition-failed";
  if (error instanceof RemoteHttpError) return `http-${error.status}`;
  if (error instanceof IntegrationTestEscapeError) return "guard-rejected";
  return error instanceof Error ? error.name : "unknown";
}

function preconditionFailed(outcome: string): boolean {
  return outcome === "precondition-failed" || outcome === "http-412" || outcome === "http-409";
}

async function absent(client: R2Client, key: string): Promise<boolean> {
  try {
    await client.headObject(key);
    return false;
  } catch (error) {
    if (error instanceof RemoteHttpError && error.status === 404) return true;
    throw error;
  }
}

export async function runTransportScenarios(context: TransportScenarioContext): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const [name, body] of [
    ["test-prefix-guard", () => guardScenario(context)],
    ["transport-primitives", () => primitivesScenario(context)],
    ["conditional-create", () => createScenario(context)],
    ["conditional-update", () => updateScenario(context)],
    ["conditional-get", () => conditionalGetScenario(context)],
    ["conditional-head", () => conditionalHeadScenario(context)],
    ["list-scoped", () => listScenario(context)],
    ["binary-roundtrip-64k", () => binaryScenario(context, `binary-${BINARY_SIZES.small}.bin`, BINARY_SIZES.small)],
    ["binary-roundtrip-1m", () => binaryScenario(context, `binary-${BINARY_SIZES.large}.bin`, BINARY_SIZES.large)],
  ] as const) {
    results.push(await runScenario(name, body));
  }
  return results;
}

/** Phase 5 evidence: the guard refuses escaped keys before any request is made. */
async function guardScenario(context: TransportScenarioContext): Promise<ScenarioObservation[]> {
  const escaped = [
    "Notes/private.md",
    ".mineral-sync-test/../Notes/private.md",
    ".mineral-sync-test-evil/private.md",
    ".mineral-sync-test/not-a-run-id/private.md",
    "/.mineral-sync-test/20260101T000000Z/absolute.md",
  ];
  const attempts: Array<[string, () => Promise<unknown>]> = [];
  for (const key of escaped) {
    attempts.push([`PUT ${key}`, () => context.client.putObject(key, utf8("guard canary"), { ifNoneMatch: "*" })]);
    attempts.push([`GET ${key}`, () => context.client.getObject(key)]);
    attempts.push([`HEAD ${key}`, () => context.client.headObject(key)]);
  }
  for (const [label, call] of attempts) {
    let outcome = "accepted";
    try {
      await call();
    } catch (error) {
      outcome = classify(error);
    }
    require(outcome === "guard-rejected", `the test-prefix guard did not reject ${label} (${outcome})`);
  }
  const listed = await context.client.listObjects();
  require(listed.every((entry) => context.namespace.isOwned(entry.key)), "listObjects surfaced a key outside the run root");
  return [
    observation("escaped key attempts rejected", attempts.length),
    observation("keys outside the run root visible via list", 0),
  ];
}

/** Phase 6: conditional create, rejected second create, original body preserved. */
async function createScenario(context: TransportScenarioContext): Promise<ScenarioObservation[]> {
  const key = context.namespace.key("create.txt");
  require(await absent(context.client, key), `run root ${context.namespace.root} is not fresh: ${key} already exists; re-run to mint a new run id`);

  const v1 = utf8(CREATE_V1);
  const created = await context.client.putObject(key, v1, { ifNoneMatch: "*" });
  require(Boolean(created.etag), "PutObject with If-None-Match:* succeeded but returned no ETag");
  require(created.size === v1.byteLength, `created object size ${created.size} did not match ${v1.byteLength}`);
  require(sameBytes(await context.client.getObject(key), v1), "the created object body did not match byte-for-byte");

  let secondCreate = "succeeded";
  try {
    await context.client.putObject(key, utf8(SHOULD_NOT_OVERWRITE), { ifNoneMatch: "*" });
  } catch (error) {
    secondCreate = classify(error);
  }
  require(preconditionFailed(secondCreate), `a second conditional create was not rejected (${secondCreate})`);
  require(sameBytes(await context.client.getObject(key), v1), "the rejected conditional create overwrote the existing object");

  return [
    observation("first create", "2xx with ETag"),
    observation("second create", secondCreate),
    observation("original body preserved", true),
  ];
}

/** Phase 7: If-Match update, ETag advance, stale update rejected, newer body preserved. */
async function updateScenario(context: TransportScenarioContext): Promise<ScenarioObservation[]> {
  const key = context.namespace.key("update.txt");
  require(await absent(context.client, key), `run root ${context.namespace.root} is not fresh: ${key} already exists`);

  const etagA = (await context.client.putObject(key, utf8("v1"), { ifNoneMatch: "*" })).etag;
  require(Boolean(etagA), "conditional create did not return an ETag");

  const etagB = (await context.client.putObject(key, utf8("v2"), { ifMatch: etagA })).etag;
  require(Boolean(etagB), "conditional update did not return an ETag");
  require(etagB !== etagA, `the ETag did not advance after a successful update (A=${etagA} B=${etagB})`);
  require(sameBytes(await context.client.getObject(key), utf8("v2")), "the conditional update did not store v2");

  // Simulated external writer: the plan's expected ETag is now stale.
  const etagC = (await context.client.putObject(key, utf8("v3"), { ifMatch: etagB })).etag;
  require(Boolean(etagC) && etagC !== etagB, `the external write did not advance the ETag (B=${etagB} C=${etagC})`);

  let staleUpdate = "succeeded";
  try {
    await context.client.putObject(key, utf8("stale-v4"), { ifMatch: etagB });
  } catch (error) {
    staleUpdate = classify(error);
  }
  require(preconditionFailed(staleUpdate), `a stale If-Match update was not rejected (${staleUpdate})`);
  require(sameBytes(await context.client.getObject(key), utf8("v3")), "the stale conditional update overwrote newer remote content");

  return [
    observation("If-Match update", "2xx"),
    observation("ETag advanced", etagA !== etagB),
    observation("stale If-Match", staleUpdate),
    observation("newer remote body preserved", true),
  ];
}

/** Phase 8: conditional GET must fail loudly rather than return the newer body. */
async function conditionalGetScenario(context: TransportScenarioContext): Promise<ScenarioObservation[]> {
  const key = context.namespace.key("conditional-get.txt");
  require(await absent(context.client, key), `run root ${context.namespace.root} is not fresh: ${key} already exists`);

  const etagA = (await context.client.putObject(key, utf8("v1"), { ifNoneMatch: "*" })).etag;
  require(Boolean(etagA), "conditional create did not return an ETag");
  require(sameBytes(await context.client.getObject(key, { ifMatch: etagA }), utf8("v1")), "conditional GET with a matching ETag returned the wrong body");

  const etagB = (await context.client.putObject(key, utf8("v2"), { ifMatch: etagA })).etag;
  require(Boolean(etagB) && etagB !== etagA, "the object did not advance to v2");

  let staleGet = "succeeded";
  let staleBody: ArrayBuffer | undefined;
  try {
    staleBody = await context.client.getObject(key, { ifMatch: etagA });
  } catch (error) {
    staleGet = classify(error);
  }
  require(preconditionFailed(staleGet), `a conditional GET with a stale ETag was not rejected (${staleGet})`);
  require(staleBody === undefined, "conditional GET returned a body despite a precondition failure");
  require(sameBytes(await context.client.getObject(key), utf8("v2")), "the object body did not advance to v2");

  return [
    observation("matching ETag GET", "2xx with exact body"),
    observation("stale ETag GET", staleGet),
    observation("stale body suppressed", true),
  ];
}

/**
 * `putObject` confirms a write with a conditional HEAD. This probe records how the endpoint
 * treats `If-Match` on HEAD so that behaviour is observed rather than assumed. A 501 is a
 * failure because every successful PUT would then be reported as ambiguous.
 */
async function conditionalHeadScenario(context: TransportScenarioContext): Promise<ScenarioObservation[]> {
  const key = context.namespace.key("head-probe.txt");
  require(await absent(context.client, key), `run root ${context.namespace.root} is not fresh: ${key} already exists`);

  const created = await context.client.putObject(key, utf8("head probe v1"), { ifNoneMatch: "*" });
  require(Boolean(created.etag), "conditional create did not return an ETag");
  const plain = await context.client.headObject(key);
  require(plain.etag === created.etag, `HEAD returned ETag ${plain.etag} instead of ${created.etag}`);
  require(plain.size === utf8("head probe v1").byteLength, `HEAD reported size ${plain.size}`);

  let outcome: string;
  try {
    await context.client.headObject(key, { ifMatch: BOGUS_ETAG });
    outcome = "ignored (200)";
  } catch (error) {
    outcome = classify(error);
  }
  require(outcome !== "http-501" && outcome !== "http-400" && !outcome.startsWith("http-5"), `conditional HEAD is not usable (${outcome}); post-PUT confirmation would fail`);
  require(outcome === "precondition-failed" || outcome === "ignored (200)", `conditional HEAD behaved unexpectedly (${outcome})`);

  return [
    observation("HEAD metadata", "canonical"),
    observation("HEAD If-Match with an unknown ETag", outcome),
  ];
}

/** Phase 1 regression at the integration layer: listing stays inside the run namespace. */
async function listScenario(context: TransportScenarioContext): Promise<ScenarioObservation[]> {
  const payloads = new Map<string, ArrayBuffer>();
  for (const leaf of ["list/a.txt", "list/b.txt", "list/c.txt"]) {
    const key = context.namespace.key(leaf);
    require(await absent(context.client, key), `run root ${context.namespace.root} is not fresh: ${key} already exists`);
    const body = utf8(`payload:${leaf}`);
    payloads.set(key, body);
    await context.client.putObject(key, body, { ifNoneMatch: "*" });
  }

  const listed = new Map((await context.client.listObjects()).map((entry) => [entry.key, entry]));
  for (const [key, body] of payloads) {
    const entry = listed.get(key);
    require(entry, `ListObjectsV2 did not return ${key}`);
    require(entry.size === body.byteLength, `ListObjectsV2 reported size ${entry.size} for ${key}`);
    require(Boolean(entry.etag), `ListObjectsV2 returned no ETag for ${key}`);
  }
  require([...listed.keys()].every((key) => context.namespace.isOwned(key)), "ListObjectsV2 returned a key outside the run root");

  return [
    observation("listed test objects", payloads.size),
    observation("keys outside run root", 0),
  ];
}

/** Phase 9: binary round trip, byte-for-byte and SHA-256. */
async function binaryScenario(context: TransportScenarioContext, leaf: string, size: number): Promise<ScenarioObservation[]> {
  const key = context.namespace.key(leaf);
  require(await absent(context.client, key), `run root ${context.namespace.root} is not fresh: ${key} already exists`);

  const payload = toArrayBuffer((context.randomBytes ?? secureRandomBytes)(size));
  require(payload.byteLength === size, `random payload length ${payload.byteLength} != ${size}`);
  const written = await context.client.putObject(key, payload, { ifNoneMatch: "*" });
  require(written.size === size, `stored object size ${written.size} != ${size}`);

  const readBack = await context.client.getObject(key);
  require(readBack.byteLength === size, `round-tripped length ${readBack.byteLength} != ${size}`);
  const [expected, actual] = await Promise.all([sha256(payload), sha256(readBack)]);
  require(expected.value === actual.value, "round-tripped bytes hashed differently (SHA-256 mismatch)");
  require(sameBytes(payload, readBack), "round-tripped bytes differed byte-for-byte");

  return [
    observation("payload size", size),
    observation("byte-for-byte", true),
    observation("sha256", actual.value),
  ];
}

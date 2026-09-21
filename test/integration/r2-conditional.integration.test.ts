import { beforeEach, describe, expect, it } from "vitest";
import { runTransportScenarios, transportScenarioNames } from "../../src/dev/integration/scenarios";
import type { ScenarioResult } from "../../src/dev/integration/result";
import { SignedR2ListClient } from "../../src/remote/r2-client";
import { resetRequestUrlHandler } from "../obsidian";
import { FakeR2 } from "./fake-r2";
import { installDomParserShim } from "./dom-parser-shim";
import { CONFIG, FIXED_NOW, RUN_ID, createHarness } from "./harness";

const statuses = (results: ScenarioResult[]): string[] => results.map((result) => `${result.name}:${result.status}`);

function find(results: ScenarioResult[], name: string): ScenarioResult {
  const result = results.find((entry) => entry.name === name);
  expect(result, `scenario ${name} is missing`).toBeDefined();
  return result!;
}

function value(result: ScenarioResult, name: string): string | number | boolean | undefined {
  return result.observations.find((entry) => entry.name === name)?.value;
}

describe("R2 conditional transport: real signer + real RequestUrlTransport over an in-process R2 emulator", () => {
  beforeEach(() => {
    installDomParserShim();
    resetRequestUrlHandler();
  });

  it("passes every transport scenario", async () => {
    const { fake, namespace, client } = createHarness();
    const results = await runTransportScenarios({ namespace, client });

    expect(statuses(results)).toEqual(transportScenarioNames().map((name) => `${name}:pass`));
    expect(namespace.root).toBe(`.mineral-sync-test/${RUN_ID}/`);
  });

  it("only ever touches objects inside the run root, and signs every request", async () => {
    const { fake, namespace, client } = createHarness();
    await runTransportScenarios({ namespace, client });

    expect(fake.objects.size).toBeGreaterThan(0);
    expect([...fake.objects.keys()].every((key) => key.startsWith(`sync/${namespace.root}`))).toBe(true);
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests.every((request) => request.headers?.Authorization?.startsWith("AWS4-HMAC-SHA256 "))).toBe(true);
    expect(fake.requests.some((request) => request.method === "PUT" && request.headers?.["if-none-match"] === "*")).toBe(true);
    expect(fake.requests.some((request) => request.method === "PUT" && typeof request.headers?.["if-match"] === "string")).toBe(true);
    expect(fake.requests.some((request) => request.method === "GET" && typeof request.headers?.["if-match"] === "string")).toBe(true);
  });

  it("records the observed conditional outcomes", async () => {
    const { namespace, client } = createHarness();
    const results = await runTransportScenarios({ namespace, client });

    const create = find(results, "conditional-create");
    expect(value(create, "first create")).toBe("2xx with ETag");
    expect(String(value(create, "second create"))).toMatch(/precondition-failed|http-41[29]/);
    expect(value(create, "original body preserved")).toBe(true);

    const update = find(results, "conditional-update");
    expect(value(update, "ETag advanced")).toBe(true);
    expect(String(value(update, "stale If-Match"))).toMatch(/precondition-failed|http-41[29]/);
    expect(value(update, "newer remote body preserved")).toBe(true);

    const get = find(results, "conditional-get");
    expect(String(value(get, "stale ETag GET"))).toMatch(/precondition-failed|http-41[29]/);
    expect(value(get, "stale body suppressed")).toBe(true);

    expect(value(find(results, "binary-roundtrip-64k"), "byte-for-byte")).toBe(true);
    expect(String(value(find(results, "binary-roundtrip-64k"), "sha256"))).toMatch(/^[0-9a-f]{64}$/);
    expect(value(find(results, "binary-roundtrip-1m"), "payload size")).toBe(1024 * 1024);
    expect(value(find(results, "list-scoped"), "keys outside run root")).toBe(0);
    expect(value(find(results, "test-prefix-guard"), "escaped key attempts rejected")).toBe(15);
  });

  it("still passes paginated listing when the endpoint pages the namespace", async () => {
    const { namespace, client } = createHarness({ bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId, pageSize: 2 });
    const results = await runTransportScenarios({ namespace, client });
    expect(statuses(results)).toEqual(transportScenarioNames().map((name) => `${name}:pass`));
  });

  it("documents a body-less non-2xx HEAD as a transport error on a strict platform", async () => {
    // A desktop-like platform must never turn a typed error into an opaque throw: the matrix fails
    // loudly, while every error path the product depends on stays typed and all scenarios pass.
    const { namespace, client } = createHarness({ bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId, failHeadNon2xx: true });
    const results = await runTransportScenarios({ namespace, client });
    const matrix = find(results, "transport-primitives");
    const probe = (name: string): string => String(matrix.observations.find((entry) => entry.name === name)?.value);

    expect(matrix.status).toBe("fail");
    expect(matrix.detail).toContain("HEAD absent → http-404");
    expect(probe("HEAD absent → http-404")).toContain("got transport-error");
    expect(probe("HEAD If-Match (stale) → precondition")).toContain("got transport-error");
    // Error paths whose response carries a body are unaffected.
    expect(probe("GET absent → http-404")).toBe("ok: http-404");
    expect(probe("GET If-Match (stale) → precondition")).toBe("ok: precondition-failed");
    expect(probe("PUT If-None-Match:* on existing → precondition")).toBe("ok: precondition-failed");
    expect(probe("PUT If-Match (stale) → precondition")).toBe("ok: precondition-failed");
    // A rejected conditional write leaves the object untouched.
    expect(probe("LIST after rejected create")).toContain("present size=26");
    // And no scenario depends on a 404 HEAD any more, so only the HEAD-specific probes complain.
    expect(statuses(results).filter((entry) => entry.endsWith(":fail"))).toEqual(["transport-primitives:fail", "conditional-head:fail"]);
  });

  it("accepts the documented mobile limitation without losing any product-critical check", async () => {
    const { namespace, client } = createHarness({ bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId, failHeadNon2xx: true });
    const results = await runTransportScenarios({ namespace, client, platform: "android" });
    const matrix = find(results, "transport-primitives");
    const probe = (name: string): string => String(matrix.observations.find((entry) => entry.name === name)?.value);

    // The limitation is recorded verbatim, never hidden…
    expect(matrix.status).toBe("pass");
    expect(probe("HEAD absent → http-404")).toContain("ok on mobile: transport-error");
    expect(probe("HEAD If-Match (stale) → precondition")).toContain("ok on mobile: transport-error");
    // …and every check the product's correctness depends on is still strict.
    expect(probe("GET absent → http-404")).toBe("ok: http-404");
    expect(probe("GET If-Match (stale) → precondition")).toBe("ok: precondition-failed");
    expect(probe("PUT If-None-Match:* on existing → precondition")).toBe("ok: precondition-failed");
    expect(probe("PUT If-Match (stale) → precondition")).toBe("ok: precondition-failed");
    expect(probe("LIST after small PUT")).toContain("present size=18");
    expect(statuses(results)).toEqual(transportScenarioNames().map((name) => `${name}:pass`));
  });

  it("is independent of HEAD: writes and reads survive a completely broken HEAD", async () => {
    // The strongest form of the Android finding: with every HEAD failing, the only things that
    // break are the two HEAD probes. Nothing in the execution path (LIST / PUT / GET) needs HEAD.
    const { namespace, client } = createHarness({ bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId, failHead: true });
    const results = await runTransportScenarios({ namespace, client });
    const matrix = find(results, "transport-primitives");
    const probe = (name: string): string => String(matrix.observations.find((entry) => entry.name === name)?.value);

    expect(probe("HEAD")).toContain("FAILED");
    expect(probe("HEAD If-Match (matching)")).toContain("FAILED");
    expect(probe("HEAD absent → http-404")).toContain("FAILED");
    expect(probe("HEAD If-Match (stale) → precondition")).toContain("FAILED");

    expect(probe("PUT If-None-Match:* small")).toContain("ok etag=");
    expect(probe("PUT If-None-Match:* 64 KiB")).toContain("ok etag=");
    expect(probe("PUT If-Match (update)")).toContain("ok etag=");
    expect(probe("GET")).toContain("ok");
    expect(probe("GET 64 KiB")).toContain("ok");
    expect(probe("GET If-Match (matching)")).toContain("ok");
    // The writes really landed, and a rejected conditional write left the object untouched.
    expect(probe("LIST after small PUT")).toContain("present size=18");
    expect(probe("LIST after 64 KiB PUT")).toContain("present size=65536");
    expect(probe("LIST after update")).toContain("present size=26");
    expect(probe("LIST after rejected create")).toContain("present size=26");

    // Exactly the two HEAD-specific checks fail; every scenario the product's paths rely on passes.
    expect(statuses(results).filter((entry) => entry.endsWith(":fail"))).toEqual(["transport-primitives:fail", "conditional-head:fail"]);
  });

  it("fails the create scenario when the endpoint ignores If-None-Match", async () => {
    const { namespace, client } = createHarness({ bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId, ignoreIfNoneMatch: true });
    const results = await runTransportScenarios({ namespace, client });
    expect(find(results, "conditional-create").status).toBe("fail");
    expect(find(results, "conditional-create").detail).toContain("second conditional create was not rejected");
  });

  it("fails the update scenario when the endpoint ignores If-Match", async () => {
    const { namespace, client } = createHarness({ bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId, ignoreIfMatch: true });
    const results = await runTransportScenarios({ namespace, client });
    expect(find(results, "conditional-update").status).toBe("fail");
    expect(find(results, "conditional-update").detail).toContain("stale If-Match update was not rejected");
  });

  it("rejects a request that is not signed, so a broken signer cannot pass", async () => {
    const fake = new FakeR2({ bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId });
    const unsigned = new SignedR2ListClient({ ...CONFIG }, () => FIXED_NOW, {
      sign: async (request) => ({ method: request.method, url: request.url, headers: request.headers ?? {}, body: request.body }),
    });
    await expect(unsigned.listObjects()).rejects.toMatchObject({ status: 403 });
    expect(fake.requests).toHaveLength(1);
  });
});

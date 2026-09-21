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

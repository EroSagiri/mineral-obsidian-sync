import { describe, expect, it } from "vitest";
import { MAX_PENDING_MUTATIONS, classifyIngressStatus, createMutationIngressReporter, mutationIngressConfig, type MutationIngressSettings } from "./mutation-ingress";
import type { GatewayHttpRequest, GatewayTransport } from "./transport";

/**
 * The writer side of the mutation ingress.
 *
 * Two properties matter more than any other, and both come from the same fact — the R2 write is already
 * durable when this runs. A report never changes a sync outcome, and a report that cannot be delivered is
 * retried with the *same* idempotency key, because the only thing a lost response leaves unknown is
 * whether the ingress already recorded it.
 */

const settings = (overrides: Partial<MutationIngressSettings> = {}): MutationIngressSettings => ({ enabled: true, endpoint: "https://vault.example", token: "secret", ...overrides });

function transport(responses: Array<number | "throw">) {
  const sent: GatewayHttpRequest[] = [];
  let index = 0;
  const subject: GatewayTransport = {
    async send(request) {
      sent.push(request);
      const next = responses[Math.min(index++, responses.length - 1)];
      if (next === "throw" || next === undefined) throw new Error("transport unavailable");
      return { status: next, text: "" };
    },
  };
  return { subject, sent };
}

const reporter = (responses: Array<number | "throw">, overrides: { settings?: MutationIngressSettings; debug?: string[] } = {}) => {
  const { subject, sent } = transport(responses);
  const debug: string[] = overrides.debug ?? [];
  let id = 0;
  const instance = createMutationIngressReporter({
    settings: () => overrides.settings ?? settings(),
    transport: subject,
    now: () => 1_700_000_000_000,
    newId: (now) => `obsidian-${now.toString(36)}-${(id += 1)}`,
    debug: (message) => debug.push(message),
  });
  return { instance, sent, debug };
};

const put = (path = "notes/a.md", etag = "ETAG-1", size = 12) => ({ op: "put" as const, path, etag, size });

describe("what is reported", () => {
  it("reports a landed put with the exact revision, to the ingress path, with the bearer token", async () => {
    const { instance, sent } = reporter([202]);

    await instance.report([put()]);

    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://vault.example/internal/mutations");
    expect(request.token).toBe("secret");
    expect(JSON.parse(request.body!)).toEqual({ id: expect.stringMatching(/^obsidian-[0-9a-z]+-\d+$/), source: "obsidian", committedAt: 1_700_000_000_000, op: "put", path: "notes/a.md", etag: "ETAG-1", size: 12 });
  });

  it("gives every write its own idempotency key, even for the same path and revision", async () => {
    // A content-derived key would be wrong: an ETag is a digest of the content, so a note deleted and
    // re-created with identical text produces the same one, and the second write would look like a
    // duplicate of the first instead of the new fact it is.
    const { instance, sent } = reporter([202, 202]);

    await instance.report([put()]);
    await instance.report([put()]);

    const ids = sent.map((request) => JSON.parse(request.body!).id as string);
    expect(new Set(ids).size).toBe(2);
  });

  it("normalizes a trailing slash on the endpoint", async () => {
    const { instance, sent } = reporter([202], { settings: settings({ endpoint: "https://vault.example/" }) });
    await instance.report([put()]);
    expect(sent[0]!.url).toBe("https://vault.example/internal/mutations");
  });

  it("reports a logical deletion with the revision it retired", async () => {
    // A delete that names a revision is verified against R2 exactly as a put is, which is the only way a
    // logical deletion — a tombstone with the object left in place — can be checked at all.
    const { instance, sent } = reporter([202]);

    await instance.report([{ op: "delete", path: "notes/gone.md", etag: "ETAG-GONE" }]);

    expect(JSON.parse(sent[0]!.body!)).toEqual({ id: expect.any(String), source: "obsidian", committedAt: 1_700_000_000_000, op: "delete", path: "notes/gone.md", etag: "ETAG-GONE" });
  });

  it("reports nothing for a write whose landed revision it never observed", async () => {
    // An ambiguous PUT has no revision to name, and the ingress checks a report against R2, so there is
    // nothing honest to send.
    const { instance, sent, debug } = reporter([202]);

    await instance.report([{ op: "put", path: "notes/a.md", etag: "", size: 3 }, { op: "put", path: "notes/b.md", etag: "E", size: Number.NaN }, { op: "delete", path: "notes/c.md", etag: "" }]);

    expect(sent).toEqual([]);
    expect(debug).toContain("mutation ingress skipped reason=no-verified-revision count=3");
  });

  it("does nothing at all when it is not configured", async () => {
    for (const config of [settings({ enabled: false }), settings({ endpoint: "  " }), settings({ token: "" })]) {
      const { instance, sent } = reporter([202], { settings: config });
      await instance.report([put()]);
      expect(sent).toEqual([]);
    }
  });
});

describe("how an answer is classified", () => {
  it("maps the ingress statuses onto what a writer has to do", () => {
    expect(classifyIngressStatus(202)).toBe("recorded");
    expect(classifyIngressStatus(200)).toBe("recorded");
    expect(classifyIngressStatus(204)).toBe("not-a-mutation");
    // A report that does not describe R2 cannot be fixed by sending it again.
    expect(classifyIngressStatus(409)).toBe("state-mismatch");
    expect(classifyIngressStatus(401)).toBe("permanent");
    expect(classifyIngressStatus(403)).toBe("permanent");
    expect(classifyIngressStatus(413)).toBe("permanent");
    expect(classifyIngressStatus(400)).toBe("permanent");
    // The journal could not commit, or the call never completed: the report must be retried.
    expect(classifyIngressStatus(503)).toBe("retryable");
    expect(classifyIngressStatus(500)).toBe("retryable");
    expect(classifyIngressStatus(429)).toBe("retryable");
  });
});

describe("retry and rejection", () => {
  it("retries a deferred report with the same idempotency key", async () => {
    // The retry is safe precisely because the key is unchanged: if the first attempt was recorded and its
    // answer was lost, the ingress recognises the id and replays the original result.
    const { instance, sent, debug } = reporter([503, 202]);

    await instance.report([put()]);
    expect(instance.pendingCount()).toBe(1);
    expect(debug).toContain("mutation ingress deferred pending=1");

    await instance.report([]);

    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1]!.body!).id).toBe(JSON.parse(sent[0]!.body!).id);
    expect(instance.pendingCount()).toBe(0);
  });

  it("retries a report whose transport failed, and never throws", async () => {
    const { instance } = reporter(["throw", 202]);
    await expect(instance.report([put()])).resolves.toBeUndefined();
    expect(instance.pendingCount()).toBe(1);
    await instance.report([]);
    expect(instance.pendingCount()).toBe(0);
  });

  it("drops a state mismatch and a credential failure instead of retrying them forever", async () => {
    const { instance, sent, debug } = reporter([409, 401, 202]);

    await instance.report([put("notes/stale.md")]);
    await instance.report([put("notes/denied.md")]);

    expect(instance.pendingCount()).toBe(0);
    expect(debug.some((line) => line.startsWith("mutation ingress rejected reason=state-mismatch path-digest="))).toBe(true);
    expect(debug.some((line) => line.startsWith("mutation ingress rejected reason=not-accepted path-digest="))).toBe(true);
    // A rejection empties the queue just like an acceptance, so the summary must not call it recorded:
    // this is the one line an operator reads, and it is where a stale report would otherwise look fine.
    // The count is per report call, because each call summarises what it did.
    expect(debug.filter((line) => line === "mutation ingress rejected count=1")).toHaveLength(2);
    expect(debug.some((line) => line.startsWith("mutation ingress recorded"))).toBe(false);
    // Neither log names the path.
    expect(debug.join("\n")).not.toContain("notes/");
    expect(sent).toHaveLength(2);
  });

  it("keeps its deferred facts bounded, oldest first", async () => {
    const { instance } = reporter([503]);
    await instance.report(Array.from({ length: MAX_PENDING_MUTATIONS + 8 }, (_value, index) => put(`notes/${index}.md`, `E${index}`)));
    // One attempt each, and only the newest survivors are kept, so an outage cannot grow without limit.
    expect(instance.pendingCount()).toBe(MAX_PENDING_MUTATIONS);
  });

  it("logs a summary when everything was recorded", async () => {
    const debug: string[] = [];
    const { instance } = reporter([202, 202], { debug });
    await instance.report([put("notes/a.md"), put("notes/b.md", "E2")]);
    expect(debug).toContain("mutation ingress recorded count=2");
  });
});

describe("settings mapping", () => {
  it("reads the stored, prefixed fields", () => {
    expect(mutationIngressConfig({ mutationIngressEnabled: true, mutationIngressEndpoint: "https://vault.example", mutationIngressToken: "secret" })).toEqual({ enabled: true, endpoint: "https://vault.example", token: "secret" });
  });
});

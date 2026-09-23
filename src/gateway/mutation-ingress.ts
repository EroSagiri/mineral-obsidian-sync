import type { RemoteChange } from "@mineral/sync-core/sync-change";
import { pathDigest } from "../sync/path";
import type { GatewayTransport } from "./transport";

/**
 * The writer side of the Mutation Ingress.
 *
 * A mutation is a durable fact about an R2 write that **already happened**: the Vault journals it, the
 * Sync Publisher turns it into a gateway generation, and the index consumes it. Two consequences shape
 * everything here.
 *
 * First, this never changes a sync outcome. The R2 write is committed before any of this runs, so a
 * failure is a deferred report, never a failed write, never a reclassification, and never a retry that
 * can roll anything back.
 *
 * Second, the fact must carry the exact revision. The ingress checks a `put` against R2 (`head`), so an
 * ETag this device did not receive from the PUT response would be rejected as a state mismatch (409) —
 * which is why the revision has to travel from the executor's result and not be re-read or guessed.
 *
 * **Deletion is reportable because the report can name the revision it retired.** This plugin deletes
 * logically — an immutable tombstone, with the object left in place so the deletion stays recoverable —
 * and the ingress verifies a `delete` that carries a revision against R2 exactly as it verifies a `put`.
 * A `delete` with no revision means "the object is gone" instead, which is not something this plugin can
 * claim about its own deletions, so it never sends one.
 */

/**
 * A write this device landed, in the journal's vocabulary.
 *
 * Deliberately not the Gateway's `RemoteChange`: a mutation is verified against R2 by the receiver, so a
 * `put` must name the revision it left and a logical `delete` must name the revision it retired, while
 * the Gateway's change vocabulary forbids an ETag on a delete and describes a wake-up hint rather than a
 * fact. The two are derived from the same result and diverge here, at the only place that needs to.
 */
export type LandedWrite =
  | { op: "put"; path: string; etag: string; size: number }
  | { op: "delete"; path: string; etag: string };

/** The mutation vocabulary, as the Vault's ingress accepts it from a writer. */
export interface WriterMutation {
  id: string;
  source: "obsidian";
  committedAt: number;
  op: "put" | "delete";
  path: string;
  etag: string;
  size?: number;
}

export interface MutationIngressSettings {
  enabled: boolean;
  endpoint: string;
  token: string;
}

/**
 * The same three facts as they are stored.
 *
 * Settings are flat and prefixed so they cannot collide with the R2 fields (`endpoint`, `token` are
 * already taken), while the reporter works with one self-contained config value captured per report.
 * The mapping lives here so the two spellings cannot drift apart in the settings tab.
 */
export interface MutationIngressSettingsFields {
  mutationIngressEnabled: boolean;
  mutationIngressEndpoint: string;
  mutationIngressToken: string;
}

export const DEFAULT_MUTATION_INGRESS_SETTINGS: MutationIngressSettingsFields = { mutationIngressEnabled: false, mutationIngressEndpoint: "", mutationIngressToken: "" };

export function mutationIngressConfig(settings: MutationIngressSettingsFields): MutationIngressSettings {
  return { enabled: settings.mutationIngressEnabled, endpoint: settings.mutationIngressEndpoint, token: settings.mutationIngressToken };
}

export const MUTATION_INGRESS_PATH = "/internal/mutations";

/**
 * Deferred reports are bounded: an outage must not turn into an unbounded queue in plugin memory, and
 * the oldest facts are the ones a consumer is least likely to still need. Dropping is reported, never
 * silent, so a long outage is visible in diagnostics instead of looking like nothing happened.
 */
export const MAX_PENDING_MUTATIONS = 64;

export interface MutationIngressDependencies {
  settings(): MutationIngressSettings;
  transport: GatewayTransport;
  now(): number;
  /** Injected so a test can make ids deterministic; production uses time plus randomness. */
  newId?(now: number): string;
  debug?(message: string): void;
}

export interface MutationIngressReporter {
  /** Reports the writes a cycle landed. Never throws, and never blocks on an unconfigured ingress. */
  report(writes: readonly LandedWrite[]): Promise<void>;
  /** How many facts are waiting for a retry. Diagnostics only. */
  pendingCount(): number;
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * A stable idempotency key for one landed write.
 *
 * It is deliberately **not** derived from the path or the revision: an ETag is a digest of the content,
 * so a note deleted and re-created with identical text has the same one, and a content-derived key would
 * make the second, genuinely new write look like a duplicate of the first. Time plus randomness gives
 * one key per write event, and the same key is reused for every retry of that event, which is what makes
 * a lost response safe to resend.
 */
function defaultNewId(now: number): string {
  let suffix = "";
  for (let index = 0; index < 8; index++) suffix += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length) % ID_ALPHABET.length];
  return `obsidian-${now.toString(36)}-${suffix}`;
}

/**
 * The mutation a landed write becomes, or nothing when the write cannot be verified.
 *
 * A `put` needs both the revision and the size the PUT response reported, and a logical `delete` needs
 * the revision it retired: the ingress checks the report against R2, so a fact without them could only
 * be rejected. There is no "report it anyway" path — an unverifiable report is noise, not evidence.
 */
export function mutationForWrite(write: LandedWrite, id: string, committedAt: number): WriterMutation | undefined {
  if (!write.etag || write.etag.length > 256) return undefined;
  if (write.op === "delete") return { id, source: "obsidian", committedAt, op: "delete", path: write.path, etag: write.etag };
  if (!Number.isFinite(write.size) || write.size < 0) return undefined;
  return { id, source: "obsidian", committedAt, op: "put", path: write.path, etag: write.etag, size: write.size };
}

/** How the ingress answered, reduced to what a writer has to do about it. */
export type IngressVerdict =
  /** 2xx: the fact is durable. A retry with the same id is a no-op. */
  | "recorded"
  /** 204: bytes someone else already wrote are not a new fact. */
  | "not-a-mutation"
  /** 409: the report does not describe R2. Retrying the report cannot fix it. */
  | "state-mismatch"
  /** The credential or the request itself is wrong; retrying cannot fix it either. */
  | "permanent"
  /** The journal could not commit, or the call never completed: the report **must** be retried. */
  | "retryable";

export function classifyIngressStatus(status: number): IngressVerdict {
  if (status === 204) return "not-a-mutation";
  if (status >= 200 && status < 300) return "recorded";
  if (status === 409) return "state-mismatch";
  // Rate limiting is the one 4xx that says "ask again", exactly as the R2 path treats it.
  if (status === 429) return "retryable";
  if (status >= 400 && status < 500) return "permanent";
  return "retryable";
}

export function createMutationIngressReporter(dependencies: MutationIngressDependencies): MutationIngressReporter {
  const newId = dependencies.newId ?? defaultNewId;
  /** Facts whose report has not been answered yet, oldest first, keyed by their idempotency key. */
  const pending = new Map<string, WriterMutation>();

  const send = async (mutation: WriterMutation, settings: MutationIngressSettings): Promise<IngressVerdict> => {
    try {
      const response = await dependencies.transport.send({
        url: `${settings.endpoint.replace(/\/+$/, "")}${MUTATION_INGRESS_PATH}`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutation),
        token: settings.token,
        timeoutMs: 15_000,
      });
      return classifyIngressStatus(response.status);
    } catch {
      // A timeout or a transport failure says nothing about whether the ingress recorded the fact, which
      // is exactly what the idempotency key is for: the retry carries the same id.
      return "retryable";
    }
  };

  return {
    pendingCount: () => pending.size,
    async report(writes: readonly LandedWrite[]): Promise<void> {
      const settings = dependencies.settings();
      if (!settings.enabled || !settings.endpoint.trim() || !settings.token.trim()) return;

      const now = dependencies.now();
      let unreportable = 0;
      for (const write of writes) {
        const mutation = mutationForWrite(write, newId(now), now);
        if (!mutation) { unreportable += 1; continue; }
        // A write to the same path in a later cycle is a new fact; only a retry reuses an id.
        pending.set(mutation.id, mutation);
      }

      // Retries first: an older fact is the one a consumer has been missing for longer.
      let deferred = 0;
      for (const mutation of [...pending.values()]) {
        const verdict = await send(mutation, settings);
        if (verdict === "retryable") { deferred += 1; continue; }
        pending.delete(mutation.id);
        if (verdict === "state-mismatch") dependencies.debug?.(`mutation ingress rejected reason=state-mismatch path-digest=${pathDigest(mutation.path)}`);
        else if (verdict === "permanent") dependencies.debug?.(`mutation ingress rejected reason=not-accepted path-digest=${pathDigest(mutation.path)}`);
      }

      while (pending.size > MAX_PENDING_MUTATIONS) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }

      if (deferred > 0) dependencies.debug?.(`mutation ingress deferred pending=${pending.size}`);
      if (unreportable > 0) dependencies.debug?.(`mutation ingress skipped reason=no-verified-revision count=${unreportable}`);
      if (pending.size === 0 && deferred === 0 && unreportable === 0) dependencies.debug?.(`mutation ingress recorded count=${writes.length}`);
    },
  };
}

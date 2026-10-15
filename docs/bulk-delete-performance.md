# Bulk folder deletion — 2026-10-15

## Measured bottlenecks

Windows debug.log showed a no-change cycle taking 10,129 ms. Its ordinary remote
scan took about 1,511 ms; recovery retry discovery accounted for most of the rest.
`retryPending()` used the recovery-center listing, including historical tombstones.
Every fresh deletion also re-listed and downloaded its just-written backup and
re-checked the tombstone. The scheduler deleted serially and the executor waited
for a recovery notification after every file. Mutation ingress also sent serially.

## Changes

- Fresh deletion privately carries its successfully committed manifest into the
  immediate continuation. External retries still validate manifest identity, group
  completeness, body bytes/ETag, tombstone and current source before deletion.
- Retry discovery lists versions once and reads manifests with a limit of four;
  it does not scan tombstones or download historical bodies just to find pending work.
- Desktop executes at most four distinct ordinary remote deletions together. Other
  operation kinds remain ordered. Every in-flight result is accounted for before
  stopping on visibility, configuration change, authentication failure or unload.
- Android keeps its single-operation background pause boundary. Both platforms
  benefit from fewer recovery requests and coalesced notifications.
- Recovery refresh/notification is flushed once per cycle, including interrupted
  cycles. Mutation journal reports use at most four requests, preserve same-path
  ordering and idempotency keys, and stop launching requests after a retryable wave.
  The journal still receives one fact per file; its protocol was not replaced by a
  bulk notification. An unreachable gateway costs at most one wave of timeouts.
- Progress displays completed/total and unsuccessful counts. Logs separately time
  recovery retries, coalesced recovery notification and mutation ingress.
- Preserves the previous uncommitted Windows background-sync fix and its tests.

## Real R2 comparison

Disposable independent `mineral-bulk-benchmark/<UUID>/` prefixes, 8 small Markdown
files, real signed S3 requests and SafeExecutor, same computer/network:

| Measurement | Before | After |
| --- | ---: | ---: |
| Delete wall time | 41,314 ms | 9,030 ms |
| Delete requests | 128 | 80 |
| Recovery retry discovery wall time | 2,932 ms | 805 ms |
| Recovery retry discovery requests | 19 | 9 |
| Recovery notification callbacks | 8 | 1 |

Deletion was 78.1% faster in this sample, with 37.5% fewer requests. Network timing
is variable; this is not a throughput guarantee. Callback counts use a local
notifier, excluding gateway latency. The journal's bounded concurrency/offline
behavior is separately tested. A 12-file after-run took 13,639 ms / 120 requests.
Two earlier before-runs each encountered a transport failure; they are retained
as failure evidence and excluded from the successful comparison. Their test
objects were subsequently safely removed.

The detailed JSON includes count and accumulated request time for scanning,
source validation/read, backup-body PUT, manifest PUT/GET, tombstone HEAD/PUT/GET,
DELETE and absence HEAD. Accumulated request times overlap under concurrency and
must not be summed as wall time.

## Safety boundaries

Planner remains pure and SafeExecutor remains the plugin mutation boundary.
Each deletion validates the expected source ETag, reads the body conditionally,
commits version body + manifest + tombstone, revalidates the source, then deletes
and checks absence. Failure before these writes never permits source deletion.
Unknown DELETE outcomes retain pending recovery state. Retry re-reads the backup;
ETag changes preserve the changed source. No prefix deletion or gateway lock was
introduced. `.mineral/` storage, legacy read-only tombstones, ignored internal
paths and recovery-cleanup confirmation requirements are unchanged.

R2's accepted validation-to-DELETE race remains: recreation in that window can
still be removed. Backups preserve the pre-delete version, not an unseen recreation.

## Validation

- Plugin: 682 passed, 1 skipped, including local integration tests; typecheck/build passed.
- Shared/backend: 266 passed in workerd; all typechecks and all three dry-run builds passed.
- New tests cover bounded deletion, partial failure, draining on stop, deferred
  notification with gateway offline, unknown DELETE retry, changed ETag, failed
  backup, bounded manifest discovery and bounded journal retries.
- Windows: deployed and reloaded 0.0.3; verified runtime concurrency 4. Created and
  synced 12 disposable files, then trashed their parent folder through Obsidian.
  With the window hidden, deletion execution took 8,457 ms; its full cycle took
  16,034 ms. Progress reached 12/12 with zero failures and subsequent reconciliation
  returned idle. Local filesystem and Obsidian cache reported the folder absent.
- Android device was listed as offline; deployment and runtime verification were
  unavailable. Platform background-pause regression tests passed.
- Cleanup verified zero ordinary and recovery objects in every benchmark prefix
  and the Windows test folder. A transient TLS disconnect interrupted Windows
  recovery cleanup; retry resumed from the retained cleanup state and verified zero.
- No Worker deployment was required for the client optimization; shared source and
  the plugin's vendored package are updated together.

Baseline, complete working-tree snapshots, verified Git bundles and raw reports:
`C:\Users\i\work\baselines\20261015-bulk-delete-154408`.

Reproduce the isolated comparison by bundling `scripts/recovery-diag.ts` with
esbuild (`platform=node`, `format=esm`, alias `obsidian=./test/obsidian.ts`), then
running `scripts/benchmark-delete.mjs <absolute-bundle> <data.json> <report.json>
<file-count> <1-or-4>`. Never publish the settings file; reports omit credentials.

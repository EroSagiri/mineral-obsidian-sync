# Bulk folder deletion — 2026-10-15

## Configurable deletion and batch protocol — 0.0.4

The sections below this update retain the earlier 0.0.3 optimization record. This
update starts from plugin `0764a4a` and shared library `cbaa476`. Both main branches
and working trees were clean. Main SHAs, complete source/working-tree archives
(excluding reproducible dependencies and Wrangler caches), binary diffs and
verified complete Git bundles were saved before edits under
`C:\Users\i\work\baselines\20261015-222336-direct-delete`.

### Configuration and invariants

Settings → 文件同步／删除 → 删除方式 persists `deletionMode` as `backup` or
`direct`. Missing/unrecognized legacy values select `backup`. The setting says:
**删除前不创建云端恢复副本，删除的内容可能无法恢复。** Ordinary deletion does
not prompt each time. Recovery-copy cleanup retains its existing confirmation.

| Behavior | 备份后删除 (default) | 直接删除 |
| --- | --- | --- |
| New version content and manifest | Preserved before deletion | Neither created |
| Existing historical versions | Preserved | Preserved |
| Tombstone JSON and source ETag validation | Required | Required |
| Real R2 deletion and verified absence | Required | Required |
| Durable retry state | Existing version manifest | One immutable task per identity/path/ETag in `.mineral/delete-tasks/` |

The planner is unchanged and pure. The scheduler passes observed operations to
SafeExecutor; UI recovery intents remain identity/path/ETag-bound. Both modes can
use explicit DeleteObjects batches (desktop batches of four, Android one).
DeleteObjects rejects internal keys, directories, duplicate keys and batches over
32. No deletion enumerates a prefix and blindly submits everything underneath it.

New direct tasks store their mode, remote identity, path, expected ETag and original
modification time. A settings change affects new tasks, including when retrying
tasks from the other mode. A reload discovers direct tasks independently of version
manifests; there is no shared global deletions file. Changed ETags or changed source
timestamps stop the old task. A conflict is logged and the changed object is left
for normal conflict reconciliation. Damaged/mismatched tasks remain pending and
are reported; they never authorize a source DELETE.

The direct path conditionally creates a tombstone with `If-None-Match: *`, without
a preliminary tombstone HEAD. Only a definite precondition collision permits
reading and validating the existing record. Failed or unknown writes stop the
file. Source verification happens again after the task and tombstone are durable.
The signed recovery adapter also uses this conditional-create path for backups.

Delete responses distinguish requested, failed, missing and unknown results.
HTTP 200 is parsed per key, with duplicate/malformed responses treated as unknown.
Only a subsequent absence proof produces `physicalDeleted: true` and retires a
baseline. Same-parent batches use a complete affected-range LIST, following up to
four pages. Overflow, malformed/missing/repeated pagination tokens, failed listings,
scattered parents and single-item batches fall back to exact HEAD/native GET
observations. An unfinished LIST is never an absence proof. Unknown requests are
reconciled before retry, and a surviving source must pass fresh ETag/time checks.

Every task/retry wave checks visibility, settings generation/current settings and
unload. Android recovery discovery no longer unconditionally starts four manifest
reads: it uses the supplied single-item boundary. Windows background execution
remains enabled. Notifications flush once per cycle and cannot gate R2 writes.

`.mineral/` remains excluded from ordinary Vault synchronization; tombstones have
their separate scan and the legacy tombstone namespace remains read-only. The
recovery center still reads R2, never the Windows local mirror. A tombstone with no
surviving body has no preview/recover action; historical version actions remain.

R2 DELETE still has the accepted verification-to-DELETE race: a recreation in that
window may be deleted. Direct mode has no new recovery copy for either the old
bytes or that unseen recreation. ETag checks narrow this window but cannot make
DELETE atomic. No gateway-only writer, distributed lock or hot-sync path was added.
See [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) and
[DeleteObjects response semantics](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html).

### Real R2 comparison: 100 small Markdown files per run

Final comparisons use new UUID prefixes under `.mineral/benchmarks/bulk-delete/`,
which are invisible to running root-prefix sync clients. Same computer, credentials,
network, signed native S3 protocol and four-item waves. Upload setup and fixture
cleanup are excluded. This is a network sample, not a throughput guarantee.

| Measurement | 0.0.3 baseline | 0.0.4 backup | 0.0.4 direct |
| --- | ---: | ---: | ---: |
| First delete execution | 105,551 ms | 90,906 ms | 76,275 ms |
| First delete requests | 1,001 | 742 | 572 |
| Initially incomplete files | 1 | 3 | 4 |
| Retry/discovery + final ordinary absence proof | 12,710 ms / 110 requests | 23,090 ms / 229 requests | 13,349 ms / 33 requests |
| Total through ordinary absence proof | 118,261 ms | 113,996 ms | 89,624 ms |
| Additional complete metadata rescan | Failed: TLS disconnect | 2,292 ms / 206 requests | 6,137 ms / 105 requests |
| Full convergence including metadata rescan | Unavailable | 116,295 ms | 95,766 ms |
| Final ordinary objects / pending direct tasks | 0 / not applicable | 0 / 0 | 0 / 0 |
| Tombstones / version objects before teardown | Not fully rescanned | 100 / 200 | 100 / 0 |

Compared with the baseline, the direct first execution used 42.9% fewer requests
and took 27.7% less time. Backup first execution used 25.9% fewer requests. Including
retry and the complete rescan, the final backup and direct runs used 1,177 and 710
requests respectively; full convergence was 17.7% faster with direct mode.

All initial shortfalls in the final runs converged without deleting a changed
source. Actual TLS resets interrupted PUT/read/finalization paths. The backup
rescan retried one failed read-only scan. The earlier isolated direct run took
67,492 ms / 573 requests, then failed its metadata rescan; it is preserved as
failure evidence rather than substituted for the final complete run. The old
baseline's failed final rescan is explicitly not presented as complete convergence.

Earlier runs using the old `mineral-bulk-benchmark/<UUID>/` helper prefix could be
observed by the live root-prefix clients after reload. Those interfered runs are
excluded from the comparison. Both clients were paused; only those recorded test
paths were removed from active Vault storage using Obsidian trash. No existing
user note was a destructive test fixture. The benchmark now uses the reserved
internal namespace and a bounded diagnostic transport timeout.

### Code checks, deployment and real devices

- Plugin: **705 passed, 1 existing manual skip**; all local integration suites,
  typecheck and production build passed. Signed HTTP integration runs both modes
  through the real signer, transport, recovery adapter and SafeExecutor, including
  Android non-2xx HEAD fallback and paginated LIST. Parser tests cover per-item
  HTTP-200 failures, missing/duplicate/unknown results and LIST fallback.
- Shared/backend: **287 passed** in workerd; all four typechecks, binding/layering
  checks and all three Worker dry-run builds passed. Added durable-task tests cover
  corruption, conditional tombstones, failed writes, recreated ETags/timestamps,
  reload/switch recovery and Android retry boundaries.
- Windows native runtime: deployed/reloaded **0.0.4**. With the actual window
  hidden and gateway endpoint set to unreachable `https://127.0.0.1:9`, the plugin's
  captured SafeExecutor cycle deleted **12/12** isolated R2 fixtures in **6,297 ms**.
  Persisted direct mode was checked and original backup settings restored. Gateway
  diagnostics recorded a transport error. An extra diagnostic call used a wrong
  accessor after the delete completed; its instrumentation error is retained in
  evidence and did not invalidate the 12 applied/absence-proven outcomes.
- Android **UWAQYLIVJV558DT8**: deployed/reloaded **0.0.4**; actual Obsidian/native
  R2 transport, not an emulator. Direct mode persisted; the phone deleted 8 files
  before Home/background paused execution, leaving 4 incomplete. A background
  retry/scan did not delete those four. On foreground resume, durable retry completed
  one and explicit continuation completed the other three. Original backup settings
  were restored. The gateway endpoint was unreachable for this test too.
- Both real settings pages rendered the two choices and exact warning, with backup
  selected after restoration. Final runtime checks confirm latest settings fencing,
  Windows batch size four, Android batch size one, and scheduler resumed.
- Final ordinary Vault status: Windows was idle with 426 noops and no errors or
  conflicts. Android was idle with 419 `both-created-different` planner entries:
  read-only investigation found 425 stored baselines, of which 418 carry the old
  `[".history",".trash"]` ignore-policy fingerprint while current settings use `[]`.
  Only seven baselines are currently accepted. The original Android settings backup
  also has `[]`; this task did not change that policy. These are unproven first-sync
  equivalences, not 419 established body differences. No test path remains in those
  observations. We did not force-adopt the old baselines, change ignore preferences,
  merge user content, or claim whole-Vault Android convergence. A separate read-only
  byte comparison / verified-baseline initialization remains outstanding there.
- Both installed final bundles have SHA-256
  `628e93b51217177f8ca0f2e231dda3501ae0d91681c93fc68ca2802510903fe8`.
  Shared package is **0.0.4**, vendored with its recorded integrity hash. No gateway
  route or deployment changed; Worker builds were validated, not deployed. Published
  0.0.3 tags were not rewritten.

The device exercise invokes the real plugin's captured execution cycle with
identity/ETag-bound fixture operations. It is not a fresh folder-click/whole-Vault
UI acceptance run. Pending-task reload and HTTP failure combinations are automated
tests; phone background/foreground and native R2 requests are actual-device evidence.
The accepted final validation-to-DELETE recreation race is not claimed solved.

### Cleanup and reproducibility

All **10** prefixes (including failed/interfered runs, the probe, both live-device
tests and the final comparison runs) were checked empty after teardown: ordinary
objects, versions/orphans, tombstones and direct tasks. Fixture cleanup validates
the client's recorded UUID prefix, accepts only explicit recognized fixture keys,
rechecks their ETags, and verifies absence after each DELETE. Unknown outcomes are
checked before retry; a changed surviving ETag stops cleanup. This test-only cleanup
does not weaken the production recovery center's corrupt-record protections.
Local fixture copies were moved to Windows system trash / Android local trash;
they are absent from active Vault paths, and recycle bins were not emptied.

The sanitized [JSON evidence](evidence/bulk-delete-20261015.json) includes request
breakdowns, runtime checks and cleanup results. Full raw reports, private deployment
settings backups, source archives and Git bundles remain in the baseline directory
above; private settings were not committed. The shared commit is
`49e40f7a0108ba897f8d6f3f327760cf82f8c506`.

Reproduce with a Node diagnostic bundle of `scripts/recovery-diag.ts`, then:

```text
node scripts/benchmark-delete.mjs <absolute-bundle> <private-data.json> <report.json> 100 4 backup
node scripts/benchmark-delete.mjs <absolute-bundle> <private-data.json> <report.json> 100 4 direct
```

Use the baseline bundle and final argument `legacy` to compare 0.0.3. The script
generates its own reserved UUID prefix and performs teardown even after failure.
Raw failed-run reports are retained rather than rewritten as successes.

---

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

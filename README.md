# Mineral Sync — Phase 2A.5

This Obsidian plugin inspects an R2-backed Vault, establishes a per-device baseline only for files that are proven byte-for-byte identical, and executes an already-observed plan through a sequential, conditional, fail-safe executor.

**Inspect Sync State** is a diagnostic, not a synchronization action. There is no manual sync, push, pull, or automatic scheduler in this phase.

## Bootstrap rule

For a key with no complete previous state and both a local file and R2 object:

1. Different sizes are immediately a conflict; no bodies are read.
2. Equal sizes cause a lazy binary read of only that key.
3. Both byte streams are SHA-256 hashed with Web Crypto.
4. A baseline is saved only when both hashes match. R2 reads use `If-Match` with the scanned ETag when available; a `412` is unresolved, never accepted.

Local file metadata is checked before and after its binary read. A changed local file, changed R2 ETag, or per-file network failure remains unresolved and is eligible for a later retry. Verification runs with concurrency three and stops starting new work after plugin unload.

Existing complete baselines use the normal metadata cost model (`mtime` + size locally; ETag + size remotely) and do not download or hash unchanged files again.

## Executor rule

`SafeExecutor` runs one operation at a time and commits one key of previous state per proven operation:

- `upload` uses `If-None-Match: *` for a new object and `If-Match: <observed ETag>` otherwise.
- `download` uses `GET If-Match: <observed ETag>` and re-checks the local file before and after the write.
- A `412` is `stale`, never an overwrite. A received 4xx is a definitive failure.
- Only a 5xx/429 response, a transport throw, or a failed state commit is `unresolved`; `unresolved` never claims success and never commits a baseline.
- `delete-local` and `delete-remote` are hard-blocked.

## Safety boundary

- R2 `ListObjectsV2`, `GetObject`, `HeadObject`, conditional `PutObject`: implemented.
- R2 `DELETE`, `COPY`, multipart upload: absent.
- Vault write: only through a proven `download`; Vault delete: absent.
- IndexedDB writes: only `PreviousEntry` values for proven-equal or proven-transferred keys.
- Manual sync / push / pull action: absent.
- Status bar: passive status only; it never starts synchronization.
- Automatic scheduler, Vault event listener, polling, Gateway, WebSocket: absent.

Credentials are saved by Obsidian's normal plugin settings mechanism and are not encrypted by this plugin. Use a narrowly scoped R2 token and protect the device profile. Do not commit credentials or settings data.

## R2 transport integration harness (development only)

`src/dev/integration/` exists to answer one question: does `aws4fetch` (sign-only) → `SignedRequest` → `RequestUrlTransport` → Obsidian `requestUrl` → Cloudflare R2 actually behave as designed?

It is not a sync feature. It has no production entry point.

### Hard test-prefix guard

Two invariants are enforced, and they are deliberately separate.

**Remote (non-negotiable).** Every R2 object key an integration helper can produce must land inside `<configuredPrefix>.mineral-sync-test/<run-id>/`. `GuardedIntegrationClient` is the only R2 client the harness may hold, and it checks the **mapped object key** — what R2 will actually receive — before any signing or networking happens.

**Local.** Every Vault path must live inside a run-scoped scratch root, and callers never hand-build a path: they mint a leaf through `LocalScratch.key(leaf)` or `IntegrationTestNamespace.key(leaf)`.

- `putObject`, `getObject`, `headObject`, and `listObjects` all reject or filter anything outside the scratch root.
- `.mineral-sync-test-evil/…`, `.mineral-sync-test/../…`, an absolute path, a missing run id, a sibling run directory, and a sibling run prefix are all refused.
- Nothing is deleted. Each run leaves its objects under its own run prefix, which the report prints for manual cleanup.

### Local scratch root resolution

`Vault.createBinary` does not create missing parent folders — a real run on 2026-09-21T17:10Z failed with `ENOENT … .mineral-sync-test/<run>/convergence/test-file.md` before writing a single byte. Obsidian may also refuse to create a dot-directory.

So the harness now creates the folder chain explicitly (never relying on `createBinary`), then **probes** the preferred hidden root end-to-end with the exact Vault calls the scenarios use (`createBinary`, `getFileByPath`, `getFiles`, `readBinary`, `adapter.stat`, `modifyBinary`). Only if that probe fails does it fall back to a run-scoped visible root under `private/`. Either way the R2 invariant holds: for the fallback the convergence client's remote prefix already ends in `.mineral-sync-test/<run-id>/`, so object keys still land inside the test root. The report names the chosen root and prints the whole probe trail.

The capability probe writes one file under `<run-base>/local-probe/`, outside the scenario root, so it can never enter a sync plan.

### In-Obsidian self-test (the only real `requestUrl` evidence)

```powershell
npm run dev          # dev build: registers the self-test commands
# reload the plugin in Obsidian, then run one of:
#   "Mineral Sync (dev): R2 Transport Self-Test"
#   "Mineral Sync (dev): R2 Convergence Self-Test"
```

The transport self-test covers conditional create, conditional update, conditional GET, a conditional HEAD probe, scoped listing, and 64 KiB/1 MiB binary round trips. The convergence self-test covers local scan → remote scan → planner → `SafeExecutor` → R2 → state commit → second plan, plus stale-remote, stale-local, state-commit-failure, and ambiguous-PUT cases. Both print a report window that can be copied.

`npm run build` (production) does not register these commands and does not bundle `src/dev`: the `__DEV__` flag is folded at compile time and the development module is replaced with an empty stub. Verified by grepping the built `main.js`.

### Opt-in real-R2 diagnostic from Node

With a real, disposable bucket and a narrowly scoped token:

```powershell
$env:MINERAL_TEST_R2_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
$env:MINERAL_TEST_R2_BUCKET="..."
$env:MINERAL_TEST_R2_ACCESS_KEY_ID="..."
$env:MINERAL_TEST_R2_SECRET_ACCESS_KEY="..."
$env:MINERAL_TEST_R2_PREFIX="some-prefix"
npx vitest run test/integration/r2-real.manual.test.ts
```

This exercises real signing and real R2 conditional semantics over Node `fetch`. It bypasses `requestUrl`, so **a pass here is not evidence that the Obsidian transport works**. Never commit these variables (`.env*` is gitignored) and never paste the report without checking it.

Unit and in-process integration tests (`npx vitest run`) use an in-process R2 emulator on top of the real signer and the real `RequestUrlTransport`. Those tests are regression protection, not real-endpoint validation.

## Android smoke test (not yet performed)

The same `RequestUrlTransport` is used on desktop and mobile; there is no separate mobile transport. The following still require a real device:

1. `R2 Sync: Test Connection` — ListObjectsV2 against the real bucket.
2. `Mineral Sync (dev): R2 Transport Self-Test` — conditional create/update/GET.
3. Binary round trip of 64 KiB and 1 MiB (memory and `ArrayBuffer` handling).
4. Web Crypto `SHA-256` availability on the device WebView.
5. IndexedDB `previous-sync-state` read/write, including the separate integration database.
6. Confirm the self-test report renders and the run prefix stays inside `.mineral-sync-test/`.

Until those steps are run, mobile support must be described as unverified.

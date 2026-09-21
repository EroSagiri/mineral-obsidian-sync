# Mineral Sync — Phase 1.5

This Obsidian plugin safely inspects an R2-backed Vault and establishes a per-device initial baseline only for files that are proven byte-for-byte identical.

It provides local and paginated R2 metadata scans, a deterministic three-way planner, an IndexedDB previous-state store, and **Mineral Sync: Inspect Sync State**. The command is a diagnostic, not a synchronization action.

## Bootstrap rule

For a key with no complete previous state and both a local file and R2 object:

1. Different sizes are immediately a conflict; no bodies are read.
2. Equal sizes cause a lazy binary read of only that key.
3. Both byte streams are SHA-256 hashed with Web Crypto.
4. A baseline is saved only when both hashes match. R2 reads use `If-Match` with the scanned ETag when available; a `412` is unresolved, never accepted.

Local file metadata is checked before and after its binary read. A changed local file, changed R2 ETag, or per-file network failure remains unresolved and is eligible for a later retry. Verification runs with concurrency three and stops starting new work after plugin unload.

Existing complete baselines use the normal metadata cost model (`mtime` + size locally; ETag + size remotely) and do not download or hash unchanged files again.

## Safety boundary

- R2 `ListObjectsV2` and `GetObject`: allowed.
- R2 `PUT`, `DELETE`, `COPY`, multipart upload: absent.
- Vault write/delete: absent.
- IndexedDB writes: only `PreviousEntry` values for SHA-256-verified-identical pairs.
- Manual sync / push / pull action: absent.
- Status bar: passive status only; it never starts synchronization.

Credentials are saved by Obsidian's normal plugin settings mechanism and are not encrypted by this plugin. Use a narrowly scoped R2 token and protect the device profile. Do not commit credentials or settings data.

The plugin uses Obsidian `requestUrl`; desktop and mobile transport behavior, IndexedDB behavior, and a real Vault/R2 bootstrap still require device-level verification.

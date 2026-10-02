# Safe deletion semantics

`previous` is the last confirmed local/remote convergence point. It is not a deletion command.
When a full local scan and a full effective-remote scan both prove a previous key absent, the client
removes only that device-local baseline entry. This baseline GC does not touch a Vault file or R2.

## Logical remote deletion

The plugin first archives the exact retired bytes under
`.mineral/versions/deleted-<tombstone identity>/<original path>`, then creates an immutable JSON tombstone under the
reserved remote-prefix namespace `.mineral/tombstones/<sha256(path,etag)>.json` with
conditional `If-None-Match: *` creation:

Legacy `.mineral-sync/tombstones/` records remain readable only during migration. New writes use
`.mineral/tombstones/`; MCP backup and delete copies share `.mineral/versions/`. The migration tool
`scripts/migrate-internal-storage.mjs` preserves the original R2 acceptance time as `r2AcceptedAt`.
All writers must be paused and every backend/plugin upgraded before retiring old keys.

```json
{"protocol":1,"path":"notes/a.md","deletedRemoteETag":"ETAG_A","createdAt":"2026-09-22T00:00:00.000Z"}
```

The path is canonicalized and the key is hash-derived. The namespace is excluded from Vault scans,
ordinary remote object counts, and user paths. Bad JSON, unsupported protocols, invalid paths, or a
metadata-key mismatch fail the remote scan closed; they never mean a file was deleted.

Effective remote state is: object A plus tombstone(A) is deleted; object B plus tombstone(A) is B;
and an absent object plus a valid tombstone is deleted. Thus recreating a path writes B and is not
blocked by an old tombstone(A). After successful archival and tombstone creation, the source version
is checked again and the original object is removed. Hot deletion and rename retirement use the same
archive-before-remove sequence. Archive failure leaves the original intact. Existing logical deletions
are not bulk-purged automatically.

R2 does not implement conditional DELETE. Gateway coordination excludes participating writers, but
the final version check cannot atomically exclude an external S3 writer between checking and deletion.
Writers bypassing the Gateway must be paused during deletion or migration. Recycle copies remain outside
ordinary sync scans and use the existing version restore mechanism.

Before tombstoning a locally deleted file, the executor conditionally HEADs the expected ETag and
then conditionally creates the tombstone. Ambiguous tombstone PUTs do not retire `previous`; the next
full reconciliation decides the result. Remote logical deletion notifies the Gateway best-effort.
Local trashing, baseline GC, and local restores do not notify it.

## Conflicts

`local-modified-remote-deleted` offers **Keep Local / Restore** or **Accept Remote Delete**.
`local-deleted-remote-modified` offers **Restore Remote** or **Accept Local Delete**. Each button
persists a version-bound `ResolutionIntent`; only the planner and SafeExecutor can apply it. Text
conflicts remain separate. Automatic three-way text merge, rename inference, archive retention, queues,
and remote polling are outside this phase.

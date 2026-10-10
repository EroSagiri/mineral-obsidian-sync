# Safe deletion semantics

`previous` is the last confirmed local/remote convergence point. It is not a deletion command.
When a full local scan and a full effective-remote scan both prove a previous key absent, the client
removes only that device-local baseline entry. This baseline GC does not touch a Vault file or R2.

## Logical remote deletion

The plugin never uses R2 `DeleteObject`. Instead it creates an immutable JSON tombstone under the
reserved remote-prefix namespace `.mineral-sync/tombstones/<sha256(path,etag)>.json` with
conditional `If-None-Match: *` creation:

```json
{"protocol":1,"path":"notes/a.md","deletedRemoteETag":"ETAG_A","createdAt":"2026-09-22T00:00:00.000Z"}
```

The path is canonicalized and the key is hash-derived. The namespace is excluded from Vault scans,
ordinary remote object counts, and user paths. Bad JSON, unsupported protocols, invalid paths, or a
metadata-key mismatch fail the remote scan closed; they never mean a file was deleted.

Effective remote state is: object A plus tombstone(A) is deleted; object B plus tombstone(A) is B;
and an absent object plus a valid tombstone is deleted. Thus recreating a path writes B and is not
blocked by an old tombstone(A). Old R2 objects intentionally remain stored: physical R2 garbage
collection is deferred because an unconditional DELETE could erase a concurrent version.

Before tombstoning a locally deleted file, the executor conditionally HEADs the expected ETag and
then conditionally creates the tombstone. Ambiguous tombstone PUTs do not retire `previous`; the next
full reconciliation decides the result. Remote logical deletion notifies the Gateway best-effort.
Local trashing, baseline GC, and local restores do not notify it.

## Conflicts

`local-modified-remote-deleted` offers **Keep Local / Restore** or **Accept Remote Delete**.
`local-deleted-remote-modified` offers **Restore Remote** or **Accept Local Delete**. Each button
persists a version-bound `ResolutionIntent`; only the planner and SafeExecutor can apply it. Text
conflicts remain separate. Automatic three-way text merge, rename inference, physical R2 GC, queues,
and remote polling are outside this phase.

# Vendored dependency: @mineral/sync-core

This directory holds a build artifact of the backend's shared sync domain package, so the plugin
repo can be installed and built on its own. It deliberately does **not** reference the backend
checkout by path: a sibling-directory dependency (`file:../bedrock-mcp/...`) or an absolute path
would make a fresh clone unbuildable on any other machine.

| Field | Value |
| --- | --- |
| Package | `@mineral/sync-core` |
| Version | `0.2.0` |
| Source repository | `bedrock-mcp` (`packages/sync-core`) |
| Source commit | working tree — repacked for the hot conflict-resolution protocol and the coordinator's bounded resume |
| Artifact | `vendor/mineral-sync-core-0.2.0.tgz` |
| SHA-256 (tarball) | `E78AE67ED14F66F7418CF89293175FBA0FA8BDC8A53485986BFEB0A5FD78FE85` |
| npm shasum | `bcec7811e4576746fb2d98392a47f7b4ee8788c2` |
| npm integrity | `sha512-rZqXWgAY8Ie9LmF+a4KCuyB+bzXnLU40NJ7twDIFphrLGs93qnUYyb1UR+v3b41f+H1A5972z3R64d3k2FniRw==` |
| Consumption | `"@mineral/sync-core": "file:vendor/mineral-sync-core-0.2.0.tgz"` |

This revision carries the mutation contract the plugin reports against (`RemoteChangeHint.mutationId`
and the `RemoteChange[]` hint `/dirty` accepts) **and** the hot-sync protocol: `hot-protocol`
(document identity, path binding, operation envelopes, acknowledgements, checkpoint receipts,
acquisition, cold-mutation authority, session tickets), `namespace-protocol` (create/delete/rename),
`tombstones` and `paths`. The tombstone derivation moved here so the plugin and the Vault compute the
same key for the same deletion — a second implementation would be a silent correctness bug.

## Rebuilding this artifact

```powershell
cd <backend>
npm run build -w @mineral/sync-core   # tsc -> packages/sync-core/dist (js + d.ts)
npm pack --silent -w @mineral/sync-core   # -> ./mineral-sync-core-0.1.0.tgz at the repo root
Copy-Item -Force .\mineral-sync-core-0.1.0.tgz <plugin>\vendor\
```

Then update the source commit and hash in this table. Npm verifies the tarball contents against the
integrity hash recorded in the plugin's `package-lock.json`, so replacing the file without
reinstalling fails the install instead of silently mixing versions. The lockfile is regenerated
alongside it:

```powershell
Remove-Item -Force package-lock.json
Remove-Item -Recurse -Force node_modules
npm install
```

## What is vendored, and what is not

Only compiled output (`dist/*.js`, `dist/*.d.ts`) is vendored. The package source is **not** copied
into this repository — there is exactly one source of truth, in the backend repo. This is a
transitional distribution mechanism: once a package registry is available, the dependency should
become a fixed semver version and this directory should be deleted.


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
| Source commit | working tree — repacked for deletion-index paging and version-bound delete events |
| Artifact | `vendor/mineral-sync-core-0.2.0.tgz` |
| SHA-256 (tarball) | `F9A2D779E86530F0C7FF10963555BAD263BE36B96DD77A3B0D7F481F6BF16DC2` |
| npm shasum | `c7e43e9a8f1cf528181493d8cded9a359e07fd75` |
| npm integrity | `sha512-XcjsfwtDV/4/y25lipsJamKyfRpgSf5px9KopA9sltbmwulJc1Iiy6PGVQlnGuzdedPQkQ6OWSIW8ePMeU2loA==` |
| Consumption | `"@mineral/sync-core": "file:vendor/mineral-sync-core-0.2.0.tgz"` |

This revision carries the mutation contract the plugin reports against (`RemoteChangeHint.mutationId`
and the `RemoteChange[]` hint `/dirty` accepts) **and** the hot-sync protocol: `hot-protocol`
(document identity, path binding, operation envelopes, acknowledgements, checkpoint receipts,
acquisition, cold-mutation authority, session tickets), `namespace-protocol` (create/delete/rename),
`tombstones` and `paths`. The tombstone derivation moved here so the plugin and the Vault compute the
same key for the same deletion — a second implementation would be a silent correctness bug.
It also carries the stable deletion-index page contract and the optional deleted-version ETag on
Gateway delete events, so clients can verify one immutable tombstone without listing the namespace.

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


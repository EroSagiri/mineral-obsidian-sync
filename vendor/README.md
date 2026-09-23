# Vendored dependency: @mineral/sync-core

This directory holds a build artifact of the backend's shared sync domain package, so the plugin
repo can be installed and built on its own. It deliberately does **not** reference the backend
checkout by path: a sibling-directory dependency (`file:../bedrock-mcp/...`) or an absolute path
would make a fresh clone unbuildable on any other machine.

| Field | Value |
| --- | --- |
| Package | `@mineral/sync-core` |
| Version | `0.1.0` |
| Source repository | `bedrock-mcp` (`packages/sync-core`) |
| Source commit | `adc924e` — the commit the artifact was packed from (`git log -1 -- packages/sync-core`) |
| Artifact | `vendor/mineral-sync-core-0.1.0.tgz` |
| SHA-256 (tarball) | `5BCBDF9D625A5E6393844AA9734CCE77706630079D51682E38DEB489FF2DF685` |
| npm shasum | `1f5f4f94127e9e6b5f519ce5a303d3865baae6fe` |
| npm integrity | `sha512-RlbQeOwqhzQCCfek5ROIZpCZzEblrGYMJDZBXTf2+3nGUqR5kik6bBKTWHl8FfmCalNtEgfOpY4T9RO2o+IQMA==` |
| Consumption | `"@mineral/sync-core": "file:vendor/mineral-sync-core-0.1.0.tgz"` |

This revision carries the mutation contract the plugin reports against: `RemoteChangeHint.mutationId`
(the gateway's writer idempotency key) and the `RemoteChange[]` hint the `/dirty` route accepts. It is
the same source the Vault's `packages/sync-core` publishes, so the plugin and the backend cannot drift
apart on the wire.

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

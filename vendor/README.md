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
| Source commit | `4775c23` — the commit that last touched `packages/sync-core` |
| Artifact | `vendor/mineral-sync-core-0.1.0.tgz` |
| SHA-256 (tarball) | `186BC5910BCE74144906AC88AE39D832A22F2E3B5C5521F32DE29B72F05790EB` |
| npm shasum | `6d9f5918646f2b9de9b749c2b2ed1dbeae03941d` |
| npm integrity | `sha512-Rv/PRON0k9Zd+QAdBltteTcDfk0tmqkmdeTd6FmvGGA8rbZoFWFq75D3C+rFtlEkME5Yok9xwEFjFcJkjWWxiw==` |
| Consumption | `"@mineral/sync-core": "file:vendor/mineral-sync-core-0.1.0.tgz"` |

## Rebuilding this artifact

```powershell
cd <backend>/packages/sync-core
npm run build          # tsc -> dist/ (js + d.ts); `prepack` runs this automatically
npm pack               # -> mineral-sync-core-0.1.0.tgz
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

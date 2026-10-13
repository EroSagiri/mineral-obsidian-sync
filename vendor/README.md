# Vendored dependency: @mineral/sync-core

This directory holds a build artifact of the backend's shared sync domain package, so the plugin
repo can be installed and built on its own. It deliberately does **not** reference the backend
checkout by path: a sibling-directory dependency (`file:../bedrock-mcp/...`) or an absolute path
would make a fresh clone unbuildable on any other machine.

| Field | Value |
| --- | --- |
| Package | `@mineral/sync-core` |
| Version | `0.0.3` |
| Source repository | `bedrock-mcp` (`packages/sync-core`) |
| Source commit | `912b234` — backend recovery implementation |
| Artifact | `vendor/mineral-sync-core-0.0.3.tgz` |
| SHA-256 (tarball) | `56A1942D3A7C69E24ABB3C2D90792A5FF42202092490360C09888D361A224549` |
| npm shasum | `3551d060ecc17a095e0147d73deacfd789501e2c` |
| npm integrity | `sha512-Sn5jgygTI1Mc9bDR1RHMHnJ2a4Bq29IqhpSUbo9FLKwk3qNLMfN5W0weTSNZQpfe39K6SjlX2Gz2mhCHpx096Q==` |
| Consumption | `"@mineral/sync-core": "file:vendor/mineral-sync-core-0.0.3.tgz"` |

This revision includes the portable R2 recovery store, TOML manifests, safe recovery selections,
and mutation notification contracts used by both the plugin and backend.

## Rebuilding this artifact

Run from the plugin repository:

```powershell
node scripts/vendor-sync-core.mjs --from C:/path/to/bedrock-mcp
```

The script builds and packs the shared package, refreshes the dependency and lockfile, and updates
artifact hashes. Update the source commit above to the backend commit containing the packed source.
For a same-version rebuild, explicitly reinstall the tarball to refresh npm's cached dependency.
## What is vendored, and what is not

Only compiled output (`dist/*.js`, `dist/*.d.ts`) is vendored. The package source is **not** copied
into this repository — there is exactly one source of truth, in the backend repo. This is a
transitional distribution mechanism: once a package registry is available, the dependency should
become a fixed semver version and this directory should be deleted.

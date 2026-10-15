# Vendored dependency: @mineral/sync-core

This directory holds a build artifact of the backend's shared sync domain package, so the plugin
repo can be installed and built on its own. It deliberately does **not** reference the backend
checkout by path: a sibling-directory dependency (`file:../bedrock-mcp/...`) or an absolute path
would make a fresh clone unbuildable on any other machine.

| Field | Value |
| --- | --- |
| Package | `@mineral/sync-core` |
| Version | `0.0.4` |
| Source repository | `bedrock-mcp` (`packages/sync-core`) |
| Source commit | `cbaa47616c9ebeb7e71e265082ce6ca3170a88e7` — bounded recovery discovery and redundant-read removal |
| Artifact | `vendor/mineral-sync-core-0.0.4.tgz` |
| SHA-256 (tarball) | `822244BFCA6816ED5C0FCA0A2D5792D8470BEBE011B087C0BBD278F67EEC1B2F` |
| npm shasum | `f54d4c9c8574c91deaf381b35c55f2aa028e4224` |
| npm integrity | `sha512-GGsV92mFH+Heg/CxBe17V4m6lrivIC977E/Ozf8lCmPbySTXx2PPk+ZPr/YOaQ1qnWxBFtsl6Ee9WaQYi85Cjg==` |
| Consumption | `"@mineral/sync-core": "file:vendor/mineral-sync-core-0.0.4.tgz"` |

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

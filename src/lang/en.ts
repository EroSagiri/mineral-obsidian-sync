import type { LocaleStrings } from "./types";

/**
 * English copy — the canonical reference. Every key in `types.ts` is written here first, then
 * mirrored into other locales. The runtime falls back to this bundle when a translation is
 * missing.
 */
export const en: LocaleStrings = {
  brand: {
    prefix: "Mineral Sync",
  },

  command: {
    inspect: "Mineral Sync: Inspect Sync State",
    syncNow: "Mineral Sync: Sync Now",
    gatewayStatus: "Mineral Sync: Gateway Status",
    resolveConflicts: "Mineral Sync: Resolve Conflicts",
    resolveHotConflicts: "Mineral Sync: Resolve Hot Sync Conflicts",
    openHistory: "Mineral Sync: Open Sync History",
    showDebugLog: "Mineral Sync: Show Debug Log",
    captureDebugSlice: "Mineral Sync: Capture Debug Slice",
    testConnection: "R2 Sync: Test Connection",
  },

  statusMenu: {
    history: "Sync history",
    details: "Status details",
  },

  notice: {
    hotConflict: "Mineral Sync: {path} entered a hot-sync conflict ({reason}); cold sync is paused for this path and nothing was overwritten. Click the status bar to choose which version to keep.",
    hotRestoredHandoffs: "Mineral Sync: {count} file(s) have a handoff that did not finish — it will continue the next time the file is opened.",
    openConflictWithRemote: "Mineral Sync: {path} differs from the server version. Cold sync is unchanged; nothing was overwritten.",
    openUnavailable: "Mineral Sync: the server cannot serve {path} ({reason}); hot sync was not started and cold sync is unaffected. Reopen the file later to retry.",
    handoffPending: "Mineral Sync: the hot handoff for {path} has not finished; the file will not be overwritten by cold sync during the handoff.",
    renameTargetTaken: "Mineral Sync: the server renamed {fromPath} to {toPath}, but the local target is occupied. Sync for this path is paused — resolve the local file first.",
    renameParentMissing: "Mineral Sync: cannot create the parent directory of {toPath} locally; hot sync is paused for this path.",
    renameMoveFailed: "Mineral Sync: the server rename finished, but the local file could not be moved to {toPath}; this path is paused.",
    renameRefused: "Mineral Sync: the rename of {fromPath} was not synced to the hot session ({reason}). The file entered cold sync as a normal local change, and the hot session still holds the original path.",
    gatewayDisabled: "Mineral Sync: Sync Gateway is disabled. Cold sync is unaffected.",
    gatewayMisconfigured: "Mineral Sync: Sync Gateway is misconfigured ({reason}). Cold sync is unaffected.",
    gatewayNotStarted: "Mineral Sync: Sync Gateway has not started yet.",
    gatewayReport: "Mineral Sync Gateway — {lines}",
    noHotRunning: "Mineral Sync: hot sync is not running.",
    noHotConflicts: "Mineral Sync: there are no hot sync conflicts to resolve.",
    historyNeedsConfig: "Mineral Sync: sync history needs a configured endpoint and bucket.",
    statusDetails: "Mineral Sync — {lines}",
    deleteNotConfirmed: "Mineral Sync: the deletion of {path} is not yet confirmed by the server ({reason}). The path stays fenced and recovery will continue; the previous content will not be silently resurrected.",
    deleteRetry: "Mineral Sync: the delete request for {path} failed temporarily. The path remains under the hot-sync fence and waits for recovery.",
    externalEditWhileHot: "Mineral Sync: {path} was edited externally during the hot session; cold sync is paused for this file to avoid overwriting. Confirm the disk content and choose which version to keep.",
    r2ConnectionOk: "R2 connection succeeded: {count} sync-eligible object(s) visible.",
    r2ConnectionFailed: "R2 connection failed: {diagnostic}",
    inspectFailed: "Sync inspection failed. Check settings, network, and R2 access.",
    debugLogEmpty: "Mineral Sync debug log is empty. Run a sync cycle first, or turn on Debug Logging in settings.",
    debugLogChunk: "Mineral Sync debug log: {count} in ring. Persist at: {path}",
    debugSliceFailed: "Mineral Sync: debug slice capture failed (adapter error).",
    debugSliceWritten: "Mineral Sync: debug slice written to {path}",
  },

  settings: {
    headerVersion: "Mineral Sync v{version}",
    credentialsNotice: "Credentials use Obsidian's normal local plugin settings storage; this plugin does not encrypt them.",
    sectionCredentials: "R2 storage",
    sectionGateway: "Sync Gateway (low-latency wake-up)",
    sectionGatewayDesc: "Optional control plane. It only tells other devices that the remote may have changed; it never carries file content, and R2 sync keeps working when it is off or unreachable. The channel is derived from the R2 endpoint, bucket, and prefix, so every device sharing one namespace agrees automatically — there is nothing to type here.",
    sectionHot: "Hot sync (real-time collaboration)",
    sectionHotDesc: "When a Markdown file is opened, this device opens and starts a CRDT session with the server: changes are mirrored in real time, and the server saves to R2 on a 2-second quiet / 10-second hard cap. While the session is open, the cold path stands down for it; the cold path resumes after the file is closed and the handoff completes. With hot sync off, the plugin behaves exactly as it does with only the Gateway configured.",
    sectionIngress: "Mutation journal (remote writes this device made)",
    sectionIngressDesc: "Optional. After an R2 write lands, this device reports the fact — the exact path and revision — to the Sync Gateway, which relays it to the Vault for verification against R2 and journals it. Nothing else is configured here: the report goes to the Gateway endpoint above, over the channel derived from the R2 identity. It never changes a sync outcome — the write is already durable, so a failure only defers the report.",
    sectionDebug: "Debug logging",
    sectionDebugDesc: "Output lands in three places at once: the WebView console (when Debug Logging is on); an in-memory ring of the last 200 lines (always on, used by the resolve-failure report); and the on-disk log at <pluginDir>/debug.log (when Persist Debug Log is on). Use the command palette's `Mineral Sync: Capture Debug Slice` to dump everything since a `mark()` to a separate file.",
    sectionTags: "Module tags",
    sectionTagsDesc: "Each log line is tagged with the module that produced it. Leave on `All tags` to keep everything; switch to `Only these tags` and list one or more to narrow what is recorded. The legacy `main` tag is always on so its own output is never silenced by accident.",

    r2Endpoint: "R2 endpoint",
    r2EndpointDesc: "Example: https://<account-id>.r2.cloudflarestorage.com",
    bucket: "Bucket",
    bucketDesc: "The R2 bucket name.",
    accessKeyId: "Access key ID",
    accessKeyIdDesc: "R2 S3-compatible API access key ID.",
    secretAccessKey: "Secret access key",
    secretAccessKeyDesc: "Stored locally by Obsidian; never logged by this plugin.",
    remotePrefix: "Remote prefix",
    remotePrefixDesc: "Optional object-key prefix, with no leading slash.",

    ignoredPaths: "Ignored paths",
    ignoredPathsDesc: "One vault-relative path per line. The path itself and its complete contents are excluded from local and R2 planning.",
    ignoredPathsPlaceholder: ".history\n.trash\ndaily/private.md",

    gatewayEnabled: "Gateway enabled",
    gatewayEnabledDesc: "When off, syncing is driven only by local events, startup, focus, and the manual command.",
    gatewayEndpoint: "Gateway endpoint",
    gatewayEndpointDesc: "Example: https://mineral-sync-gateway.<subdomain>.workers.dev",
    gatewayToken: "Gateway token",
    gatewayTokenDesc: "The Gateway bearer secret. Stored locally; never logged and never placed in a URL.",
    gatewayStatus: "Gateway status",

    hotSyncEnabled: "Enable hot sync",
    hotSyncEnabledDesc: "When off, no hot session is established and cold sync behaviour is unchanged. The Gateway must be enabled and reachable.",
    hotSyncStatus: "Hot sync status",

    mutationIngressEnabled: "Report landed writes",
    mutationIngressEnabledDesc: "When off, nothing is reported and the Gateway wake-up is the only notification. When on, this device stops sending its own wake-up: the journal's publisher becomes the only announcer for its writes.",
    mutationIngressStatus: "Ingress status",

    integrityReconcileInterval: "Integrity reconcile interval",
    integrityReconcileIntervalDesc: "While the app is in the foreground, run a full R2 and tombstone verification at this interval (10–30 minutes). Foreground resume always verifies immediately.",
    integrityReconcileIntervalPlaceholder: "20",

    testConnection: "Test Connection",
    testConnectionDesc: "Runs a read-only R2 ListObjectsV2 request.",

    inspect: "Inspect Sync State",
    inspectDesc: "Scans metadata, safely verifies ambiguous equal-size pairs, and records only verified-identical initial baselines. It never writes local files or R2 objects.",
    inspectButton: "Inspect",

    debugConsole: "Debug logging (console)",
    debugConsoleDesc: "Echo every log line to the WebView developer tools. Off by default; turning it on does not change what's recorded.",
    persistDebugLog: "Persist debug log (debug.log)",
    persistDebugLogDesc: "Append every log line to <pluginDir>/debug.log, rotated to the last N lines. This is the sink a phone user can pull with `adb`, and the only one that survives an Obsidian restart.",
    diskLogLineCap: "Disk log line cap",
    diskLogLineCapDesc: "How many lines the on-disk log keeps before rotation drops the oldest. Larger values mean a longer history on device, at the cost of disk and re-read time.",
    diskLogLineCapPlaceholder: "2000",

    tagFilter: "Tag filter",
    tagFilterAll: "All tags",
    tagFilterList: "Only these tags",

    showDebugLog: "Show debug log",
    showDebugLogDesc: "Open the last 60 in-memory log lines in a modal. For the on-disk log, use the file at <pluginDir>/debug.log directly.",
    showDebugLogButton: "Show log",
    captureDebugSlice: "Capture debug slice",
    captureDebugSliceDesc: "Write everything since the most recent `mark()` (or the whole ring if none) to <pluginDir>/debug-slices/<iso>-<label>.log. Add a label like `investigation-20260524`.",
    captureDebugSliceButton: "Capture…",
  },
};
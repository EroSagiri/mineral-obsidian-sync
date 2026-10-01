/**
 * The locale strings interface — every user-visible string is keyed here.
 *
 * Each locale file (`en.ts`, `zh-CN.ts`) exports an object that satisfies `LocaleStrings`.
 * TypeScript catches missing keys and typos at compile time; the runtime falls back to the
 * English copy when a translation is incomplete, and to the key itself when both are missing.
 *
 * Convention:
 * - Strings use `{placeholder}` syntax. `t("...", { name: "X" })` substitutes `{name}`.
 * - Keys are dotted: `command.inspect`, `notice.hotConflict`, etc.
 * - The English copy is the canonical reference: a new string is written there first and
 *   then translated.
 */
export interface LocaleStrings {
  brand: {
    /** Prefix used in command palette names and Notices. */
    prefix: string;
  };

  command: {
    inspect: string;
    syncNow: string;
    gatewayStatus: string;
    resolveConflicts: string;
    resolveHotConflicts: string;
    openHistory: string;
    showDebugLog: string;
    captureDebugSlice: string;
    testConnection: string;
  };

  statusMenu: {
    history: string;
    details: string;
  };

  notice: {
    hotConflict: string;
    hotRestoredHandoffs: string;
    openConflictWithRemote: string;
    openUnavailable: string;
    handoffPending: string;
    renameTargetTaken: string;
    renameParentMissing: string;
    renameMoveFailed: string;
    renameRefused: string;
    gatewayDisabled: string;
    gatewayMisconfigured: string;
    gatewayNotStarted: string;
    gatewayReport: string;
    noHotRunning: string;
    noHotConflicts: string;
    historyNeedsConfig: string;
    statusDetails: string;
    deleteNotConfirmed: string;
    deleteRetry: string;
    externalEditWhileHot: string;
    r2ConnectionOk: string;
    r2ConnectionFailed: string;
    inspectFailed: string;
    debugLogEmpty: string;
    debugLogChunk: string;
    debugSliceFailed: string;
    debugSliceWritten: string;
  };

  settings: {
    headerVersion: string;
    credentialsNotice: string;
    sectionCredentials: string;
    sectionGateway: string;
    sectionGatewayDesc: string;
    sectionHot: string;
    sectionHotDesc: string;
    sectionIngress: string;
    sectionIngressDesc: string;
    sectionDebug: string;
    sectionDebugDesc: string;
    sectionTags: string;
    sectionTagsDesc: string;

    r2Endpoint: string;
    r2EndpointDesc: string;
    bucket: string;
    bucketDesc: string;
    accessKeyId: string;
    accessKeyIdDesc: string;
    secretAccessKey: string;
    secretAccessKeyDesc: string;
    remotePrefix: string;
    remotePrefixDesc: string;

    ignoredPaths: string;
    ignoredPathsDesc: string;
    ignoredPathsPlaceholder: string;

    gatewayEnabled: string;
    gatewayEnabledDesc: string;
    gatewayEndpoint: string;
    gatewayEndpointDesc: string;
    gatewayToken: string;
    gatewayTokenDesc: string;
    gatewayStatus: string;

    hotSyncEnabled: string;
    hotSyncEnabledDesc: string;
    hotSyncStatus: string;

    mutationIngressEnabled: string;
    mutationIngressEnabledDesc: string;
    mutationIngressStatus: string;

    integrityReconcileInterval: string;
    integrityReconcileIntervalDesc: string;
    integrityReconcileIntervalPlaceholder: string;

    testConnection: string;
    testConnectionDesc: string;

    inspect: string;
    inspectDesc: string;
    inspectButton: string;

    debugConsole: string;
    debugConsoleDesc: string;
    persistDebugLog: string;
    persistDebugLogDesc: string;
    diskLogLineCap: string;
    diskLogLineCapDesc: string;
    diskLogLineCapPlaceholder: string;

    tagFilter: string;
    tagFilterAll: string;
    tagFilterList: string;

    showDebugLog: string;
    showDebugLogDesc: string;
    showDebugLogButton: string;
    captureDebugSlice: string;
    captureDebugSliceDesc: string;
    captureDebugSliceButton: string;
  };
}
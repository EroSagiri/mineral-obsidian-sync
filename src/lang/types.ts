export interface LocaleStrings {
  command: { inspect: string; testConnection: string; syncNow: string; gatewayStatus: string; resolveConflicts: string; openHistory: string; };
  statusMenu: { history: string; details: string; };
  status: { conflicts: string; clickToResolve: string; syncError: string; authRejected: string; checkSettings: string; offline: string; resumesWhenOnline: string; someFilesFailed: string; clickToRetry: string; syncing: string; waiting: string; upToDate: string; };
  notice: { gatewayDisabled: string; gatewayMisconfigured: string; gatewayNotStarted: string; gatewayReport: string; historyNeedsConfig: string; statusDetails: string; r2ConnectionOk: string; r2ConnectionFailed: string; inspectFailed: string; };
  settings: {
    headerVersion: string; credentialsNotice: string; r2Endpoint: string; r2EndpointDesc: string; bucket: string; bucketDesc: string; accessKeyId: string; accessKeyIdDesc: string; secretAccessKey: string; secretAccessKeyDesc: string; remotePrefix: string; remotePrefixDesc: string; ignoredPaths: string; ignoredPathsDesc: string; ignoredPathsPlaceholder: string;
    sectionGateway: string; sectionGatewayDesc: string; gatewayEnabled: string; gatewayEnabledDesc: string; gatewayEndpoint: string; gatewayEndpointDesc: string; gatewayToken: string; gatewayTokenDesc: string; gatewayStatus: string;
    sectionIngress: string; sectionIngressDesc: string; mutationIngressEnabled: string; mutationIngressEnabledDesc: string; mutationIngressStatus: string; integrityReconcileInterval: string; integrityReconcileIntervalDesc: string; integrityReconcileIntervalPlaceholder: string; testConnection: string; testConnectionDesc: string; inspect: string; inspectDesc: string; inspectButton: string;
  };
}

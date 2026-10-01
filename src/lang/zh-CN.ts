import type { LocaleStrings } from "./types";

/**
 * 简体中文 — 默认语言。
 *
 * `Mineral Sync` 作为命令与 Notice 的前缀保持英文不翻译；正文与按钮用中文。
 */
export const zhCN: LocaleStrings = {
  brand: {
    prefix: "Mineral Sync",
  },

  command: {
    inspect: "Mineral Sync: 检查同步状态",
    syncNow: "Mineral Sync: 立即同步",
    gatewayStatus: "Mineral Sync: Gateway 状态",
    resolveConflicts: "Mineral Sync: 解决冲突",
    resolveHotConflicts: "Mineral Sync: 解决热同步冲突",
    openHistory: "Mineral Sync: 打开同步历史",
    showDebugLog: "Mineral Sync: 显示调试日志",
    captureDebugSlice: "Mineral Sync: 捕获调试切片",
    testConnection: "R2 Sync: 测试连接",
  },

  statusMenu: {
    history: "同步历史",
    details: "状态详情",
  },

  notice: {
    hotConflict: "Mineral Sync: {path} 的热同步进入冲突状态（{reason}），该路径的冷同步已暂停，没有任何内容被覆盖。点击状态栏决定保留哪一份。",
    hotRestoredHandoffs: "Mineral Sync: 有 {count} 个文件的交接尚未完成，将在下次打开时继续。",
    openConflictWithRemote: "Mineral Sync: {path} 与服务器版本不一致。冷同步未变，没有内容被覆盖。",
    openUnavailable: "Mineral Sync: 服务器暂时无法提供 {path}（{reason}），热同步未启动，冷同步不受影响。稍后重新打开该文件即可重试。",
    handoffPending: "Mineral Sync: {path} 的热会话交接尚未完成，交接期间该文件不会被冷同步覆盖。",
    renameTargetTaken: "Mineral Sync: 服务器已将 {fromPath} 重命名为 {toPath}，但本地目标路径被占用。该路径已暂停同步，请先处理本地文件。",
    renameParentMissing: "Mineral Sync: 无法在本地创建 {toPath} 的父目录，热同步已暂停该路径。",
    renameMoveFailed: "Mineral Sync: 服务器重命名已完成，但本地文件无法移动到 {toPath}，该路径已暂停同步。",
    renameRefused: "Mineral Sync: {fromPath} 的重命名未同步到热会话（{reason}）。该文件已作为普通本地变更进入冷同步，热会话仍持有原路径。",
    gatewayDisabled: "Mineral Sync: Sync Gateway 已禁用，冷同步不受影响。",
    gatewayMisconfigured: "Mineral Sync: Sync Gateway 配置错误（{reason}），冷同步不受影响。",
    gatewayNotStarted: "Mineral Sync: Sync Gateway 尚未启动。",
    gatewayReport: "Mineral Sync Gateway — {lines}",
    noHotRunning: "Mineral Sync: 热同步当前没有运行。",
    noHotConflicts: "Mineral Sync: 没有需要处理的热同步冲突。",
    historyNeedsConfig: "Mineral Sync: 同步历史需要先配置 endpoint 与 bucket。",
    statusDetails: "Mineral Sync — {lines}",
    deleteNotConfirmed: "Mineral Sync: {path} 的删除尚未由服务器确认（{reason}）。该路径仍保持围栏，恢复会继续，旧正文不会被静默复活。",
    deleteRetry: "Mineral Sync: {path} 的删除请求暂时失败。该路径仍保持热同步围栏，等待恢复。",
    externalEditWhileHot: "Mineral Sync: {path} 在热会话期间被外部修改，该文件的冷同步已暂停以避免覆盖。请确认磁盘内容后再决定保留哪一份。",
    r2ConnectionOk: "R2 连接成功：可见 {count} 个同步候选对象。",
    r2ConnectionFailed: "R2 连接失败：{diagnostic}",
    inspectFailed: "同步检查失败。请检查设置、网络和 R2 访问权限。",
    debugLogEmpty: "Mineral Sync 调试日志为空。先跑一轮同步，或者在设置里打开 Debug Logging。",
    debugLogChunk: "Mineral Sync 调试日志：ring 内 {count} 行。落盘位置：{path}",
    debugSliceFailed: "Mineral Sync: 调试切片写入失败（适配器错误）。",
    debugSliceWritten: "Mineral Sync: 调试切片已写入 {path}",
  },

  settings: {
    headerVersion: "Mineral Sync v{version}",
    credentialsNotice: "凭据按 Obsidian 本地插件设置的常规方式存储；本插件不加密。",
    sectionCredentials: "R2 存储",
    sectionGateway: "Sync Gateway（低延迟唤醒）",
    sectionGatewayDesc: "可选的控制平面。它只告诉其他设备「远端可能变了」，不携带文件正文；关闭或不可达时 R2 同步照常运行。通道由 R2 endpoint、bucket 和前缀派生，所以共用一个命名空间的所有设备天然对齐——这里没有需要手动填的内容。",
    sectionHot: "热同步（实时协作）",
    sectionHotDesc: "打开一个 Markdown 文件时，本机与服务器建立 CRDT 会话：编辑实时互相可见，R2 由服务器按 2 秒静默 / 10 秒上限的节奏保存。会话期间该路径的冷同步会让路；关闭文件并完成交接后才恢复。未开启时行为与只配置 Gateway 时完全相同。",
    sectionIngress: "Mutation journal（本机的远端写入）",
    sectionIngressDesc: "可选。R2 写入落地后，本机把事实（路径和 revision）报告给 Sync Gateway，由 Gateway 中继到 Vault 对着 R2 验真并落档。不用在这里配置任何东西：报告发送到上方的 Gateway endpoint，走 R2 身份派生的通道。它不会改变同步结果——写入已经持久化，失败只会推迟报告。",
    sectionDebug: "调试日志",
    sectionDebugDesc: "输出同时落到三处：WebView 控制台（打开 Debug Logging 时）；200 行内存 ring（始终开着，被解算失败报告使用）；<pluginDir>/debug.log（打开 Persist Debug Log 时）。用命令面板的 `Mineral Sync: Capture Debug Slice` 把自上次 `mark()` 起的内容单独落盘。",
    sectionTags: "模块 tag",
    sectionTagsDesc: "每行都带发出模块的 tag。默认 `All tags` 全保留；切换到 `Only these tags` 列出想保留的 tag。`main` tag 始终开启，避免被过滤掉。",

    r2Endpoint: "R2 endpoint",
    r2EndpointDesc: "示例：https://<account-id>.r2.cloudflarestorage.com",
    bucket: "Bucket",
    bucketDesc: "R2 bucket 名。",
    accessKeyId: "Access key ID",
    accessKeyIdDesc: "R2 S3 兼容 API 的 access key ID。",
    secretAccessKey: "Secret access key",
    secretAccessKeyDesc: "由 Obsidian 本地存储；本插件不写入日志。",
    remotePrefix: "远端前缀",
    remotePrefixDesc: "可选的 object-key 前缀，不带前导斜杠。",

    ignoredPaths: "忽略路径",
    ignoredPathsDesc: "每行一个 vault 相对路径。该路径及其全部内容不参与本地和 R2 计划。",
    ignoredPathsPlaceholder: ".history\n.trash\ndaily/private.md",

    gatewayEnabled: "启用 Gateway",
    gatewayEnabledDesc: "关闭时同步只由本地事件、启动、focus 和手动命令触发。",
    gatewayEndpoint: "Gateway endpoint",
    gatewayEndpointDesc: "示例：https://mineral-sync-gateway.<subdomain>.workers.dev",
    gatewayToken: "Gateway token",
    gatewayTokenDesc: "Gateway 的 bearer 密钥。本地保存；不写入日志，不出现在 URL。",
    gatewayStatus: "Gateway 状态",

    hotSyncEnabled: "启用热同步",
    hotSyncEnabledDesc: "关闭时不建立任何热会话，冷同步行为不变。需要 Gateway 已启用且配置正确。",
    hotSyncStatus: "热同步状态",

    mutationIngressEnabled: "上报已落地的写入",
    mutationIngressEnabledDesc: "关闭时不报告，Gateway 唤醒是唯一的通知。开启后本机停止自己的 /dirty：journal publisher 成为该设备写入的唯一通知者。",
    mutationIngressStatus: "Ingress 状态",

    integrityReconcileInterval: "完整性校验间隔",
    integrityReconcileIntervalDesc: "前台运行时按这个间隔做一次完整 R2 + tombstone 校验（10–30 分钟）。前台恢复时立即校验一次。",
    integrityReconcileIntervalPlaceholder: "20",

    testConnection: "测试连接",
    testConnectionDesc: "执行一次只读的 R2 ListObjectsV2 请求。",

    inspect: "检查同步状态",
    inspectDesc: "扫描元数据，安全校验等大的可疑对，只把验证为逐字节相同的初始基线登记下来。不会写本地文件，也不会写 R2 对象。",
    inspectButton: "检查",

    debugConsole: "调试日志（控制台）",
    debugConsoleDesc: "把每行日志回显到 WebView 开发者工具。默认关闭；打开不会改变被记录的内容。",
    persistDebugLog: "持久化调试日志（debug.log）",
    persistDebugLogDesc: "把每行日志追加到 <pluginDir>/debug.log，按行数截断。这是手机端可以用 `adb` 拉走的，也是 Obsidian 重启后唯一能留下来的 sink。",
    diskLogLineCap: "磁盘日志行数上限",
    diskLogLineCapDesc: "磁盘日志保留的最大行数；超出后丢最老的。值越大，设备上能留下的历史越多，但占空间也越大。",
    diskLogLineCapPlaceholder: "2000",

    tagFilter: "Tag 过滤",
    tagFilterAll: "全部 tag",
    tagFilterList: "只保留列出的 tag",

    showDebugLog: "显示调试日志",
    showDebugLogDesc: "把内存 ring 最近 60 行打到模态框。要看磁盘日志直接打开 <pluginDir>/debug.log。",
    showDebugLogButton: "显示日志",
    captureDebugSlice: "捕获调试切片",
    captureDebugSliceDesc: "把自上次 `mark()` 起的内容（没有就全 ring）写到 <pluginDir>/debug-slices/<iso>-<label>.log。label 可以像 `investigation-20260524`。",
    captureDebugSliceButton: "捕获…",
  },
};
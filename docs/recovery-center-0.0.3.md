# Mineral 0.0.3 全局恢复中心

恢复中心直接读取 R2 的 `.mineral/versions/` 和 `.mineral/tombstones/`，不读取 Vault 中的遗留镜像。Windows 与 Android 使用同一个 Obsidian Modal 和同一个共享恢复状态机。网关只加速通知，连接失败不会回滚或阻止 R2 操作。

## 入口与操作

插件设置的“打开恢复中心”、命令面板的“全局恢复中心（R2）”以及同步状态菜单都可进入。列表显示原路径、时间、大小、原因与状态。Markdown 可预览，二进制恢复保留原始字节、HTTP 元数据与自定义元数据。原大小无法验证时显示“原大小未知”。

恢复默认使用条件创建，同名文件提供新名称、取消与明确覆盖。覆盖先备份当前 R2 版本，再以观察到的目标 ETag 条件写入。恢复相同字节时 R2 可能返回相同内容 ETag；恢复后清理当前命名空间的相应墓碑，避免同秒恢复仍被旧墓碑隐藏。

支持单版本清理、按路径清理历史版本、按年龄批量清理和清空。所有物理清理都要求明确确认。损坏或不完整记录保留并报告；清空不会宣称已清除这些无法验证的记录，也不会删除普通路径的当前文件。旧 `.mineral-sync/tombstones/` 只读兼容。

旧无 manifest 的版本可在验证来源元数据后迁移。先写新 content 与 TOML，逐字节验证后才能删除旧内部副本。旧逻辑删除仍留在普通 R2 路径的正文可按墓碑 ETag 预览并保存为版本副本；此操作不删除原正文或旧墓碑。

## 存储与状态

```
<remotePrefix>/.mineral/
  tombstones/<path-etag-digest>.json
  versions/<version-id>/
    manifest.toml
    content/<原始相对路径>
```

Manifest 使用受限 TOML 标量 schema，包含 version_id、path、deleted_etag、created_at、size、content_type、reason、state、content_etag、original_modified、原始 HTTP/自定义元数据 JSON 字符串和 anomaly 风险记录。状态包括 backup、migration、delete-pending、deleted、anomaly、cleanup-pending。

普通文件真实删除先条件 HEAD 与条件读取，再保存正文、manifest 和当前协议 JSON 墓碑。任一准备步骤失败都不删除原文件。DELETE 成功后验证普通路径不存在；网络失败或结果未知保留备份及墓碑，下一次完整扫描通过 SafeExecutor 重试。已重建的不同 ETag 停止删除并记为异常。Worker 毫秒时间戳与 S3 秒精度 Last-Modified 统一按秒比较。

清理前验证版本 ID、路径、manifest ETag、正文 ETag、大小和完整组。清理许可先持久化为 cleanup-pending，正文先删，再删 manifest，分别验证不存在。仅该状态可继续处理自身操作造成的部分组；原本损坏或缺失的组不能据此清理。未完成删除对应的墓碑不能先清理，防止旧正文重新变为普通文件。

## 已接受风险

R2 DELETE 不具有可依赖的 If-Match 条件。HEAD/条件读取与 DELETE 之间的并发重建仍可能被删除。确认界面明确说明此风险，manifest 在 DELETE 前持久化不可观测窗口记录。删除前内容可恢复，但窗口内产生的新内容可能无法找回；记录窗口风险不等于能够确认每次竞态是否实际发生。不引入唯一写入网关或分布式锁。

## 边界与验证

Planner 不执行 I/O；SafeExecutor 是插件同步、恢复和清理的数据变更入口，UI 只提交身份、路径、版本 ID 与 ETag 绑定的 intent。普通同步完整排除 `.mineral/`；墓碑独立读取；不下载版本镜像，不恢复热同步。

HEAD 缺少完整元数据或 Android 原生桥丢弃非成功 HEAD 时，回退到受同一 ETag 保护的范围 GET。不能确认不存在、身份或条件的网络失败仍保持待确认。

自动化测试覆盖 TOML、版本备份、真实删除顺序、准备失败、DELETE 失败与未知结果、404、并发重建风险、旧墓碑、旧版本迁移、同名恢复、成组及批量清理、损坏保护、通知、网关不可用和两平台 UI。验证脚本 `scripts/verify-recovery-live.mjs`（插件仓库）只使用独立 UUID 测试前缀，清理也走同一 SafeExecutor 流程。

本次真实 R2 与 Windows 界面恢复、真实物理清理、通知端点不可达时的直接恢复已验证。Android 已部署并加载 0.0.3 和恢复中心入口，但当前设备 DNS 无法解析 R2，手机同步/恢复中心读取的端到端验证未通过，不能声称两客户端数据一致。

本地 `.mineral/versions` 遗留镜像不会自动删除。先确认所需副本在 R2 完整、可预览与恢复，再由用户自行备份并手动清理本地目录。

# Mineral Obsidian Sync

一个把 Obsidian Vault 与 Cloudflare R2 对齐的插件。

它的做法是先把差异**看清楚**，再动手：本地与远端各自只读元数据，由一个纯函数 planner 算出差异，需要动内容时再通过一个带条件、可中断、fail-safe 的执行器逐条执行，并且每成功一条，只提交这一条 key 的状态。

## 现在能做什么

- 扫描本地 Vault 元数据（size + `mtime`）。
- 分页扫描 R2 对象元数据（`ListObjectsV2`）。
- 用纯函数 planner 算出差异，这一步不联网、不写盘。
- 对"本地与远端都存在、且已证明逐字节相同"的文件建立本设备基线（惰性哈希，只在大小相同时才读内容）。
- 自动同步：本地事件、启动、focus/resume、以及 `Mineral Sync: Sync Now` 都会触发一轮完整 reconciliation。
- 可选的 **Sync Gateway**：让两台都在前台打开的 Obsidian 互相发现对方的远端变化，而不需要 focus/resume，也不做远端轮询。见 [`docs/gateway-integration.md`](docs/gateway-integration.md)。
- **远端删除会传播到本地**：远端对象消失且本地文件相对基线未改动时，本地文件会被移到回收站（尊重你的"删除文件"偏好），随后退休它的基线。见 [`docs/deletion-safety.md`](docs/deletion-safety.md)。
- **自动清理过期基线**：本地与远端都已不存在的 key，其设备本地 baseline 会被自动忘掉，不再永久占据差异报告。
- **文本冲突自动三方合并**：有 merge base 快照时，双方改到不同区域的 markdown / 纯文本会被自动合并。无法干净合并时保留冲突，可用 `Mineral Sync: Resolve Conflicts` 手动解决。见 [docs/conflict-resolution.md](docs/conflict-resolution.md)。
- 弹出只读的检查报告：`Mineral Sync: Inspect Sync State`。
- 验证 R2 连通性：`R2 Sync: Test Connection`。
- 查看 Gateway 诊断：`Mineral Sync: Gateway Status`。

## 现在还不能做什么

- 没有 push / pull 按钮；`Sync Now` 只是"立刻唤醒一轮完整 reconciliation"，不是强制推送或拉取。
- **本地删除还不会传播到 R2**：`delete-remote` 仍然被阻断。原因是 R2 的 `DeleteObject` 没有条件形式，无法指名"我要删的是哪个版本"，无条件 DELETE 可能删掉另一台设备刚写的新版本。计划中的做法是带版本身份的 tombstone 协议（Phase 4C.5 Stage D3），目前只有设计没有实现。
- 本地删除**不会删除任何远端对象**；被移入回收站的文件也不会被同步（`.trash` 是内置忽略项）。
- 自动同步不轮询 R2，也不会按事件直接上传或下载；事件只表示状态可能已变化，真正的决策永远来自 `scan + previous + planner`。重命名会上传新路径，但旧远端对象会保留（本地删除还没有 D3 的传播能力）。真实环境验证状态见 [`docs/development.md`](docs/development.md)。

## 安装

本插件未发布到社区插件市场，需要手动安装：

```powershell
npm install
npm run build          # 产出 main.js
```

然后把 `main.js` 和 `manifest.json` 复制到你的 Vault：

```text
<你的 Vault>/.obsidian/plugins/mineral-obsidian-sync/
```

最后在 Obsidian 里：**设置 → 第三方插件 → 启用 “Mineral Obsidian Sync”**。

最低 Obsidian 版本 1.5.0。桌面端与移动端共用同一套传输实现；自动调度仍需分别进行真实设备验证。

## 设置

| 设置项 | 说明 |
| --- | --- |
| **R2 endpoint** | 形如 `https://<account-id>.r2.cloudflarestorage.com`，必须使用 HTTPS。 |
| **Bucket** | R2 bucket 名称。 |
| **Access key ID** | R2 的 S3 兼容 API Access Key ID。 |
| **Secret access key** | 对应的 Secret。以 Obsidian 常规设置机制保存在本地，**本插件不做加密**。 |
| **Remote prefix** | 可选的对象 key 前缀，不要以 `/` 开头。留空表示直接用 bucket 根目录。 |
| **Ignored paths** | 每行一个 Vault 相对路径。该路径**及其全部子内容**都会从本地与 R2 的规划中排除。 |
| **Gateway enabled** | 是否启用可选的同步控制平面。关闭时行为与没有 Gateway 时完全一致。 |
| **Gateway endpoint** | `mineral-sync-gateway` 的地址，例如 `https://mineral-sync-gateway.<subdomain>.workers.dev`。 |
| **Gateway token** | Gateway 的 bearer secret（密码框）。与 R2 凭据完全分离，日志中永不输出。 |

Gateway 的 **channel 不需要填写**：它由 R2 的 endpoint / bucket / prefix 确定性派生。两端只要这三个值相同，就会自动落在同一个 channel 上。

内置排除项（无需手写）：`.obsidian/plugins/mineral-obsidian-sync/`、名为 `.ds_store` / `thumbs.db` 的文件、以 `~` 结尾的文件、以 `.tmp` 结尾的文件。

关于 R2 token 权限：自动同步需要该 bucket 的 Object 读写权限（List + Get + 条件 Put）；插件仍不会请求或执行删除权限。建议使用权限范围尽量窄的 token。

> 调试日志开关（`debugLogging`）目前没有在设置界面提供，需要手动在插件的 `data.json` 里加 `"debugLogging": true`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `Mineral Sync: Inspect Sync State` | 扫描本地与远端元数据，必要时读取并哈希内容，弹出只读的差异报告。它不会修改任何 Vault 文件或 R2 对象。 |
| `R2 Sync: Test Connection` | 只做一次 `ListObjectsV2`，确认 endpoint、bucket、凭据可用。 |
| `Mineral Sync: Sync Now` | 立即唤醒一轮完整 reconciliation（不是强制推送或拉取，也不绕过 planner）。 |
| `Mineral Sync: Gateway Status` | 只读诊断：channel 指纹、连接状态、两个 generation 游标、pending 与否、最近错误分类。它不会触发同步或重连。 |
| `Mineral Sync: Resolve Conflicts` | 查看并手动解决文本冲突（Keep Local / Keep Remote / Edit Merged）。它只记录一个 resolution intent，实际写入仍由 planner + SafeExecutor 完成。 |

## 安全边界

- R2 侧只使用：`ListObjectsV2`、`GetObject`、`HeadObject`、带条件的 `PutObject`。
- 完全不使用：`DELETE`、`COPY`、multipart upload。
- Vault 侧不删除文件。写入只会发生在被证明可行的下载路径上，并且会先创建缺失的父目录。
- IndexedDB 只写入"已证明一致"或"已证明完成传输"的 key，不会写入推测性的状态。
- 状态栏只做被动显示，永远不会触发同步。
- 自动调度在后台时不会发起新周期；恢复可见后会执行一次完整 reconciliation。认证失败（401/403）会暂停自动网络请求，直到配置变更或插件重新加载。
- Gateway 是附加的低延迟通道：它只传递"远端可能已变化"，不传文件内容。Gateway 关闭、配置错误或不可达时，R2 同步照常工作，一次成功的 R2 写入绝不会因为通知失败而被改判为失败。
- Gateway 的 WebSocket 使用短期、channel 绑定的 ticket；长期 token 只出现在 HTTP header 里，绝不进入 URL。

## 数据落在哪里

| 数据 | 位置 |
| --- | --- |
| 凭据与设置 | Obsidian 插件设置（`.obsidian/plugins/mineral-obsidian-sync/data.json`），明文 |
| 本设备基线 | IndexedDB 数据库 `r2-personal-sync-state-v1`，对象存储 `previous-sync-state` |
| Gateway 游标 | IndexedDB 数据库 `r2-personal-sync-gateway-v1`，对象存储 `channel-cursors`（按 channel 隔离） |
| 远端内容 | 你的 R2 bucket，key 为 `<remote prefix>/<Vault 相对路径>` |

基线只对本设备生效，并且与 endpoint / bucket / prefix 绑定；换了 namespace 或改了忽略策略，旧基线不会被复用。

## 常见问题

**`R2 connection failed: …`**
Notice 里的错误信息已经过脱敏（不会包含密钥或签名 URL）。优先检查 endpoint 是否拼错、bucket 名是否正确、token 是否还有效。

**返回 403 / AccessDenied**
token 权限不足，或只给了错误 bucket 的权限。

**`R2 ListObjectsV2 failed with HTTP 403` 但 Test Connection 以前是好的**
确认该 token 是否仍然绑定了这个 bucket。

**检查过程中出现 412**
这是正常的 stale 判定，不是故障：说明内容在你扫描之后被人改动过。重跑一次检查即可，插件不会用旧数据覆盖新内容。

**bucket 里存在以 `/` 结尾的"目录占位对象"，或含 `//` 的 key**
列取会整体失败。这是刻意的 fail-closed 行为：无法映射成合法 Vault 路径的 key 会被拒绝，而不是被静默跳过。需要先在 bucket 里清理掉这类对象。

**Gateway 显示 misconfigured / backoff / 收不到对方变化**
先用两端的 `Mineral Sync: Gateway Status` 比较 **channel 指纹**：不一致说明 R2 的 endpoint / bucket / prefix 不是同一套。指纹一致但状态是 `backoff`，检查 endpoint 与 token，以及 Worker secret 是否已设置。

**移动端**
传输层与桌面端是同一份实现，Android 的传输与执行器路径已在真机验证；自动调度仍需真机验证。具体验证范围见 [`docs/development.md`](docs/development.md)。

## 更多文档

- [`docs/development.md`](docs/development.md) —— 阶段状态、代码结构、开发命令、集成自检脚手架、真实验证记录、Android 待办清单。
- [`docs/scheduler-semantics.md`](docs/scheduler-semantics.md) —— Phase 3A 自动调度器的语义规格（触发时机、single-flight、dirty 模型、rerun 规则、MUST / MUST NOT）。
- [`docs/gateway-integration.md`](docs/gateway-integration.md) —— Phase 4C Sync Gateway 接入：channel 派生、generation 游标与握手、写者通知合并、WS 生命周期与鉴权。
- [docs/deletion-safety.md](docs/deletion-safety.md) —— Phase 4C.5 删除安全与状态 GC：baseline GC、安全 delete-local、tombstone 设计（D3）。
- [docs/conflict-resolution.md](docs/conflict-resolution.md) —— Phase 4C.6 冲突解决：merge base、三方合并语义、冲突身份、resolution intent 与手动解决 UI。

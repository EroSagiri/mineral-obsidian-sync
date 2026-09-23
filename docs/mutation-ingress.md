# Mutation Ingress：插件侧接入与网关侧需求

服务端的 Mutation Ingress（`POST /internal/mutations`）已实现并通过测试，本文记录插件侧接入了什么、
以及**只能在 Vault / Sync Gateway 侧解决的需求**。插件侧改动见 `src/sync/executor.ts`（落地 revision）、
`src/scheduler/scheduler.ts`（change 列表）、`src/gateway/mutation-ingress.ts`（上报器）。

## 1. 为什么需要把 ETag 传出来

Ingress 是**报告**，不是写入代理：它拿 `head(path)` 与上报的 revision 比对，不一致就是 409。
所以上报的 `etag` 必须来自 PUT 自己的响应——重新 HEAD 会与后续写者竞态，猜一个值则必然被拒。

`etag` 因此从 `SafeExecutor` 的**结果**传出，而不是从任何决策传入：

```text
putObject() 响应 ──► OperationResult.remote = { size, etag }
                       ├─ applied     （含 baseline 提交失败时的 unresolved）
                       └─ partial     （远端已落地、本地一半未完成）
                     ──► scheduler: remoteChangeForOperation(operation, result)
                     ──► change = { op:"put", path, etag, size }
                     ──► (a) Gateway /dirty 通知   (b) Mutation Ingress 上报
```

这一层**没有触碰同步引擎**：planner 不读 `remote`，precondition 不由它推导，baseline 不依赖它。
它只是"已经发生的事实"的补全——`upload` / `resolve-keep-local` / `resolve-merged` 以及 catch-up 的第二次
PUT 都从响应里拿到它。反过来说，**没有 revision 就不上报**：ambiguous PUT 没有任何 revision，
所以它只出现在 Gateway 通知里（那是 hint），不会出现在 mutation 上报里（那需要 fact）。

## 2. 插件侧现在的行为

| 项 | 值 |
| --- | --- |
| 端点 | `POST {endpoint}/internal/mutations`，`Authorization: Bearer <token>` |
| 报文体 | `{ id, source:"obsidian", committedAt, op:"put", path, etag, size }` |
| `id` | 每次落地写一个新 id（时间 + 随机，≤128）。**不**由 path/etag 派生：ETag 是内容摘要，删除后用完全相同的文本重建会得到同一个 ETag，内容派生的 key 会把一次真实的新写入误判为 duplicate |
| 重试 | 202 → 完成；204 → 非 mutation；409 → 永久放弃（重发无用）；401/403/413/400 → 永久放弃；429/5xx/超时 → 保留，下一轮**用同一个 id**重发（ingress 按 id 幂等，所以丢响应重发是安全的） |
| 队列 | 仅内存，上限 64 条，超出丢最旧并记日志。**不是**跨重启的 outbox |
| 失败影响 | 无。R2 写在之前已经落地，上报失败只是"延迟"，不改变任何 cycle 结果、不回滚、不重分类 |
| 关闭时 | 完全不发请求，行为与本轮之前逐字节相同（默认关闭） |
| 删除 | **不上报**，见 R1 |
| 下载 / keep-remote | 不涉及 R2 写，不上报（它们是 remote apply） |

设置项：`Report landed writes` / `Ingress endpoint` / `Ingress token`（默认全关）。

## 3. 需要在 Vault / Sync Gateway 侧处理的需求

### R1（阻塞性）删除目前无法上报

Ingress 校验 `delete` 的方式是 `observe(path) === null`，即**对象必须已经不在 R2**。
本插件的删除是**逻辑删除**：写不可变 tombstone、对象原地保留（这正是删除可恢复的前提）。
于是 `{op:"delete", path}` 对这条链路是**必然 409**，插件只能选择不上报。

**后果**：删除事实进不了 journal → Sync Publisher 不广播该删除 → 基于该 journal 的索引会一直保留已删除的笔记。

**建议改法（向后兼容）**：允许 `delete` 携带被删除的 revision，并按 `put` 的同一规则校验它：

```text
delete 且带 etag  → normalizeEtag(observe(path).etag) === normalizeEtag(etag)   # 该 revision 已被逻辑删除
delete 且不带 etag → observe(path) === null                                      # 现有语义，保持不变
```

这样 MCP/web 的硬删除继续工作，Obsidian 的逻辑删除也能被记录。注意 Gateway 的 `validChange` 目前禁止
delete change 带 `etag`，但 `gatewayChangesFor()` 本来就把 delete 归一成 `{op:"delete", path}`，
所以**无需改动 wire 上的 change 形状**，etag 只用于 Ingress 校验。

### R2 上报端点与凭据的拓扑

插件现在直连 **Vault worker**（新增 endpoint + token 两个设置）。若希望"一个控制平面端点"，
可以让 Sync Gateway 代理 `/internal/mutations` 转给 Vault——但 Gateway 按设计没有 R2 binding，
它只能转发、不能校验。两种拓扑都可行，需要你定：

- 直连 Vault（当前实现，零网关改动）；或
- 经 Gateway 代理（插件只配一个 endpoint，网关侧需要新路由）。

### R3 一次写入可能产生两个 generation（可选优化）

Ingress 收到事实后，Vault publisher 会以 `mutationId = mutation.id` 调 Gateway
`POST /v1/channels/{c}/dirty`；与此同时**插件自己仍然发**原来的 cycle 级 `/dirty`（无 `mutationId`）。
Hub 的幂等按 `mutationId` 去重，两者 key 不同 → 同一次写入可能 bump 两次 generation，所有设备多跑一轮
reconcile。三个选项：

1. 接受这一轮额外 generation（当前默认，无额外改动）；
2. 配置了 Ingress 时，插件不再自己发 `/dirty`（Vault publish 成为唯一唤醒源）；
3. 插件改为**逐 mutation** 发 `/dirty` 并复用同一个 `mutationId`（需要 R4）。

### R4 vendored sync-core 落后于 Gateway

Gateway 仓库的 `packages/sync-core/src/sync-change.ts` 已有 `RemoteChangeHint.mutationId`，
但插件 vendor 的 `mineral-sync-core-0.1.0.tgz` 还是旧的（没有该字段）。选项 3 需要重新 vendor
（在 Gateway 仓库 `packages/sync-core` 构建并出包，属于跨仓库动作）。请确认由谁执行，或告知可以直接
重新生成 tarball。

### R5 批量上报（可选）

一次 cycle 可能落地多个 path。当前上报器是**逐条 POST**（与 journal 的一条 mutation 一条事实一致）。
如果希望减少请求，可以增加 `POST /internal/mutations` 的批量形式（数组或 `{mutations: [...]}`）；插件侧改动很小。

### R6 确认语义细节

- `source: "obsidian"` 是 `INGRESS_SOURCES` 允许的写入方（已确认）。
- `committedAt` 用本机 `Date.now()`，符合"vault-record time，不是分布式时钟断言"。
- 上报器**不**发 `X-Mineral-Mutation-Origin: remote-apply`（插件只上报自己写 R2 的操作；下载不上报）。

## 4. 顺带发现的一个既有缺口（不在本轮范围）

`finishGenerationHandshake` 只在**非增量**分支里调 `notifyRemoteDirty`。因此一个
`remote-change`（增量）cycle 里如果写回了 R2（例如自动合并、或用户决议中的 keep-local），
**不会**给 Gateway 发通知，其他设备要等下一次 full reconcile 才看到。

本轮新增的 mutation 上报**没有**继承这个缺口：它在 cycle 退出路径上无条件执行，所以配置了 Ingress 后，
增量 cycle 里的写入会经由 Vault publisher 到达其他设备。是否要把 Gateway 通知也移到同一位置，属于另一个问题。

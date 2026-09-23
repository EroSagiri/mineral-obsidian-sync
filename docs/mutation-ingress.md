# Mutation Ingress：插件侧接入与网关侧需求

服务端的 Mutation Ingress（`POST /internal/mutations`）已实现并通过测试，本文记录插件侧接入了什么、
以及**只能在 Vault / Sync Gateway 侧解决的需求**。插件侧改动见 `src/sync/executor.ts`（落地 revision）、
`src/scheduler/scheduler.ts`（change 列表）、`src/gateway/mutation-ingress.ts`（上报器）。

**状态**：R1（逻辑删除可上报）服务端已实现，插件侧已同步接上（`delete` 携带被删除的 revision）。
其余需求见第 3 节。

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
| 报文体（put） | `{ id, source:"obsidian", committedAt, op:"put", path, etag, size }` |
| 报文体（delete） | `{ id, source:"obsidian", committedAt, op:"delete", path, etag }`，`etag` = 被该次删除淘汰的 revision（条件 HEAD 刚证明过、tombstone 也正是写它）；服务端按 put 的同一规则校验 |
| `id` | 每次落地写一个新 id（时间 + 随机，≤128）。**不**由 path/etag 派生：ETag 是内容摘要，删除后用完全相同的文本重建会得到同一个 ETag，内容派生的 key 会把一次真实的新写入误判为 duplicate |
| 重试 | 202 → 完成；204 → 非 mutation；409 → 永久放弃（重发无用）；401/403/413/400 → 永久放弃；429/5xx/超时 → 保留，下一轮**用同一个 id**重发（ingress 按 id 幂等，所以丢响应重发是安全的） |
| 队列 | 仅内存，上限 64 条，超出丢最旧并记日志。**不是**跨重启的 outbox |
| 失败影响 | 无。R2 写在之前已经落地，上报失败只是"延迟"，不改变任何 cycle 结果、不回滚、不重分类 |
| 关闭时 | 完全不发请求，行为与本轮之前逐字节相同（默认关闭） |
| 删除 | 上报，且**必须**带被淘汰的 revision。没有 revision 的 delete 意为"对象已不存在"，本插件对逻辑删除永远不能这么声明，所以宁可不上报也不发一条无法校验的事实 |
| 下载 / keep-remote | 不涉及 R2 写，不上报（它们是 remote apply） |
| ambiguous PUT | 不上报：没有 revision 可命名。它只作为 hint 进 Gateway 通知 |

注意 put 与 delete 使用**两套形状**：Gateway 的 change 词汇禁止 delete 带 `etag`
（`validChange` 只允许 `op`/`path`），而 journal 需要它。二者由同一个 `OperationResult` 派生，
在 `src/scheduler/scheduler.ts` 里分成 `remoteChangeForOperation`（hint）与
`landedWriteForOperation`（fact）。

设置项：`Report landed writes` / `Ingress endpoint` / `Ingress token`（默认全关）。

## 3. 需要在 Vault / Sync Gateway 侧处理的需求

### R1（已解决）逻辑删除可上报

服务端已实现：`delete` 可以携带被删除的 revision，并按 `put` 的同一规则校验
（`normalizeEtag(observe(path).etag) === normalizeEtag(etag)`）；不带 `etag` 的 delete 仍要求对象已不存在。
插件侧已接上，wire 上的 change 形状未变。

### R2 上报端点与凭据（需要确认）

插件直连 **Vault worker**（`Ingress endpoint` + `Ingress token` 两个设置）。**部署时请提供**：

```text
Vault worker 的公开基址（例如 https://mineral-vault.<subdomain>.workers.dev）
MUTATION_INGRESS_TOKEN 的值
```

`MINERAL_R2_ENDPOINT` 必须是**带协议的完整 URL**（例如
`https://<account-id>.r2.cloudflarestorage.com`，无尾斜杠）：两侧都走 `canonicalEndpoint()`
重新解析 URL，只有解析结果一致，派生出的 channel 才一致。少了 `https://` 会得到另一个 channel。

另外请确认部署环境的 `MINERAL_R2_ENDPOINT` / `MINERAL_BUCKET` / `MINERAL_REMOTE_PREFIX`
与插件使用的 R2 identity 一致：Vault 的 publisher 由这三个值派生 channel
（`entrypoint.gatewayChannel()`），派生结果必须等于插件/Gateway 的 channel，否则 mutation 会被记录到
另一个 channel，设备永远不会被唤醒。

`apps/vault/wrangler.jsonc` 目前写的是占位值 `https://example.r2.cloudflarestorage.com`；
服务端现在把 `example.r2.cloudflarestorage.com` 当作**未配置**（publisher 记录
`mutation broadcast disabled` 而不是算出一个错误的 channel），部署时必须替换。

若你更希望"一个控制平面端点"，可让 Sync Gateway 代理 `/internal/mutations`（它没有 R2 binding，
只能转发不能校验）；那是网关侧改动，需要你确认。**当前按直连 Vault 落地。**

### R3（已实现）模式级互斥，不是 fallback

**配置了 Ingress 之后，插件不再对同一次文件 mutation 自发调用 `/dirty`。** 唯一链路是：

```text
Obsidian → Mutation Ingress → Journal → Sync Publisher → Gateway
```

实现方式是模式级选择：

```text
MutationIngressReporter.announcesLandedWrites()
  = enabled && endpoint 非空 && token 非空
    → true：journal（及其背后的 Vault Sync Publisher）是本设备写入的唯一 generation 来源，
            scheduler 跳过本轮的 notifyRemoteDirty
    → false：legacy 模式，行为与本轮之前完全一致
```

为什么不做"POST 失败就 fallback `/dirty`"：POST 可能**实际已经成功、只是响应丢了**，此时再发
`/dirty` 会让同一次写入 bump 第二个 generation。Ingress 模式的失败语义是**用同一个 mutationId
重试报告**（内存队列，上限 64），永远不等于"改走 `/dirty`"。

这只互斥**写入方向的唤醒**：Gateway 连接（`current-generation`、订阅、待协调握手）照常工作，
因为其他设备仍可能通过 Gateway 唤醒我们。被跳过的只有"我自己这次写入"的通知。

### R4（已同步）重新 vendor `@mineral/sync-core`

已从 backend 的 `packages/sync-core` 重新构建、出包并重装（含 `RemoteChangeHint.mutationId` 与
`/dirty` 接受的 `RemoteChange[]`）；`package-lock.json` 与 `node_modules` 一起重建，插件不再手抄任何
临时类型。来源 commit、tarball 哈希与 integrity 见 `vendor/README.md`。

### R5（结论：不做）

一 mutation 一事实保持清晰。个人知识库的 POST 数量不值得为 batch 引入部分成功、批次幂等、单项
retry 这些额外状态。

### R6 已确认的语义

- `source: "obsidian"` 在 `INGRESS_SOURCES` 内。
- `committedAt` 用本机 `Date.now()`，符合"vault-record time，不是分布式时钟断言"。
- 插件**不**发 `X-Mineral-Mutation-Origin: remote-apply`（只上报自己写 R2 的操作；下载不上报）。

## 4. 顺带发现的一个既有缺口（不在本轮范围）

`finishGenerationHandshake` 只在**非增量**分支里调 `notifyRemoteDirty`。因此一个
`remote-change`（增量）cycle 里如果写回了 R2（例如自动合并、或用户决议中的 keep-local），
**不会**给 Gateway 发通知，其他设备要等下一次 full reconcile 才看到。

本轮新增的 mutation 上报**没有**继承这个缺口：它在 cycle 退出路径上无条件执行，所以配置了 Ingress 后，
增量 cycle 里的写入会经由 Vault publisher 到达其他设备。是否要把 Gateway 通知也移到同一位置，属于另一个问题。

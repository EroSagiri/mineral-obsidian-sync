# Sync Gateway 集成（Phase 4C）

本文档描述 **插件侧** 的 Sync Gateway 接入。Gateway 自身的协议规格在 backend 仓库的
`docs/sync-gateway.md`（Phase 4A）与 `docs/sync-gateway-implementation.md`（Phase 4B）。

`mineral-sync-gateway` 是一个 **控制平面**：它只回答"远端可能已经变化了"。
它不读文件、不代理内容、不做 planner、不保存 previous state，也**没有** R2 或 Vault binding。

## 1. 为什么需要它

Phase 3A 的调度器已经能在这些时机自动同步：

```text
本地 Vault 事件 / startup / focus-resume / Sync Now
```

但它有一个结构性盲区：**另一台设备写了 R2 这件事，本机完全看不见**。
没有 remote push、没有轮询，所以只能等到下一次 focus/resume 或重启才发现。

Gateway 补上的就是这一个洞：

```text
Windows 编辑
  → Phase 3A scheduler
  → R2 条件 PUT 成功
  → Gateway markRemoteDirty
  → RemoteChangeHub generation++
  → WebSocket
  → Android remote-change
  → 既有 scheduler
  → full local scan + remote scan + previous + planner
  → download
```

反方向同样成立。两端都前台打开时，**不需要 focus/resume，也不需要桌面端定期 LIST R2**。

## 2. 最重要的不变式

```text
Gateway event ≠ Sync operation
```

一条消息只能长这样：

```json
{ "type": "remote-dirty", "generation": "1843" }
```

它**只**表示 `remote state may have changed`。收到之后插件只做一件事：

```text
highestAnnouncedGeneration = max(…, G)
requestReconcile("remote-change")
```

决定 upload / download / conflict / noop / blocked delete 的**永远只能是**
`scan + previous + planner`。协议里没有 path、没有 delete、没有 patch、没有正文，
所以"由事件直接触发下载/删除"在这条链路上**没有可用的输入**。

## 3. 通道（channel）从哪里来

用户**不需要**输入 channel。它由 R2 的 `RemoteIdentity` 确定性派生：

```text
canonical RemoteIdentity { endpoint, bucket, remotePrefix }
  → sync-core canonicalChannelInput()     长度前缀 + v1 版本域分隔
  → SHA-256
  → base64url（无填充，32 字节 → 恒为 43 字符）
```

派生实现在 `@mineral/sync-core/channel`，插件与 Gateway 共用同一份代码，因此：

```text
同一 endpoint/bucket/prefix → Windows == Android == Gateway == 未来 Vault 写入方
```

规范化规则与插件已有的 `remoteIdentity()` **逐字一致**（endpoint 解析后去掉一个尾斜杠；
prefix 去掉首尾斜杠后保留一个尾斜杠）。`accessKeyId`、`secretAccessKey`、签名头、
Gateway token **都不参与**——channel 不是秘密，也不能由秘密派生。

不同 bucket、不同 prefix 是不同的 channel；换了 prefix 就是换了 channel，
**不会**继承旧 channel 的游标。

## 4. 设置项

| 设置 | 说明 |
| --- | --- |
| **Gateway enabled** | 关掉时行为与 Phase 3A 完全相同。 |
| **Gateway endpoint** | 例如 `https://mineral-sync-gateway.<subdomain>.workers.dev`。支持 `http://`（本地 `wrangler dev`）。 |
| **Gateway token** | Gateway bearer secret，密码框输入。 |
| **Gateway status** | 只读诊断行，见下。 |

channel 不在此列，因为它由 R2 identity 派生。

设置页的 **Gateway status** 与命令 **`Mineral Sync: Gateway Status`** 显示：

```text
channel 指纹（前 6 字符 + 长度，无法反推）
连接状态 disabled / misconfigured / connecting / connected / backoff / stopped
announced / reconciled 两个游标
pending yes/no
最近一次错误分类（auth / server / client / malformed / transport / timeout）与 HTTP 状态码
```

两端配置相同 namespace 时，channel 指纹必然相同——这是排查"为什么收不到对方变化"的第一站。

### 日志与诊断从不包含

```text
Gateway token / Authorization 头 / WS ticket / R2 access key / R2 secret / 文件正文 / 完整 endpoint
```

## 5. Gateway 关闭或配置错误时

Gateway 是**附加**的低延迟通道，不是 R2 同步的强依赖：

```text
Gateway enabled = false            → 与 Phase 3A 完全一致
endpoint 缺失 / 非法 / token 缺失    → 干净地不连接，状态显示 misconfigured，旧 sync 继续
Gateway 不可达                      → R2 读写在照常进行，只是失去低延迟发现
```

一条必须成立的性质：

> **Gateway 故障绝不能让一次成功的 R2 写入变成失败。**

写者通知发生在 R2 mutation 结论**之后**，且完全 best-effort：通知失败只记一行诊断，
不回滚、不重分类、不重试风暴。Phase 4C 不实现持久化 outbox（那是未来 Queue 的职责）。

## 6. 写者通知（writer notification）

`RemoteChangeHub` 是 **level-triggered** 的 dirty signal，不是 mutation log。
所以一轮 cycle 里改了多少个对象都一样：

```text
upload a → applied
upload b → applied
download c
↓
1 × markRemoteDirty()   ← cycle 级合并，不是每个操作一次
```

哪些操作会通知：

| 操作结果 | 通知 | 理由 |
| --- | --- | --- |
| upload → `applied` | ✅ confirmed | R2 确实被改变 |
| upload → `unresolved/ambiguous-put` | ✅ possible | PUT 可能已经落盘；不通知会让一次已落盘的写对别人不可见 |
| upload → `stale` | ❌ | 条件请求之前就判定过期，远端没有被写 |
| upload → `failed`（4xx / Vault 落盘失败） | ❌ | 明确没有改变远端 |
| upload → `blocked`（缺 remote ETag） | ❌ | 同上 |
| download | ❌ | 只改本地 |
| noop / conflict / blocked delete | ❌ | 完全没有网络写 |

**cycle 提前结束也会通知。** 例如 `a.md` 上传成功后配置变化导致本轮中止——
`a.md` 已经改变了 R2，所以退出路径必须仍然发出这一次通知。实现上通知发生在 cycle
的统一退出路径，而不是"正常跑完"的分支里。

## 7. Generation 游标

两个游标，含义严格区分：

| 游标 | 含义 | 何时推进 |
| --- | --- | --- |
| `highestAnnouncedGeneration` | 已经从 GET / WS / 自己 mark 的结果里知道的最大 generation | 任何一次合法 generation 被解析后即可推进 |
| `lastReconciledGeneration` | 最后一个被**完整观察窗口证明覆盖**的 generation | 只在该 cycle 的结束握手成功后推进 |

```text
收到 WS G  →  只推进 highestAnnounced，然后 requestReconcile("remote-change")
绝不直接 lastReconciled = G
```

游标是**同步运行状态**，不是用户设置：它存在独立的 IndexedDB 数据库
`r2-personal-sync-gateway-v1`（对象存储 `channel-cursors`），**按 channel 隔离**。

之所以不扩展现有的 previous-state 数据库：那个库的内容直接决定删除推断，
为其加 schema migration 的风险远大于"游标丢了就多跑一轮完整 reconciliation"。

## 8. Generation handshake

只有"这一轮真的完整看过远端"才能确认一个 generation。所以：

```text
cycle 即将开始
  ↓
需要握手吗？（reason == remote-change  或  已有 pending）
  ├ 否 → 普通 cycle，不付任何额外往返
  └ 是 ↓
start = GET generation
  ↓
既有完整 reconciliation（scan local + scan remote + previous + planner + SafeExecutor）
  ↓
end = GET generation
  ↓
remoteObservationComplete？
  ├ 否 → 不推进游标
  └ 是 →
       end == start ？
         ├ 是 → lastReconciled = start
         └ 否 → 不推进游标，安排后续 cycle
```

### 什么算 `remoteObservationComplete`

**不是** `applied === total`，也**不是**"全部成功"。三种确定性结论本身就已经证明
"这一轮的远端观察已经覆盖了这个 generation"：

```text
conflict         远端两侧状态已被完整 LIST 观察到，结论是确定性的
blocked delete   planner 的确定性结论，不是因为没看到远端
failed           确定性的 per-key 失败（4xx / Vault 路径被占用），远端没有被写
```

把它们当作"未完成"会导致**同一个 generation 永久重跑**且没有任何外部变化——
正是这个契约要防的忙循环。

真正可能"没看到真相"的只有：

```text
stale          执行期间观测被证伪，写操作没有尝试 → 远端可能与本轮 LIST 不同
unresolved     PUT 结果未知（ambiguous-put / state 提交失败）
halted         config / visibility / unload 在操作循环走到终点之前中止了本轮
```

另外，握手的开始或结束读取失败一律**不推进游标**。

### G10 → G11 不被吞掉

```text
lastReconciled = 10
cycle: start = 10
       LIST R2
       期间其他写入方改了 R2，Hub 10 → 11（WS 可能到达）
cycle: end = 11
       → end != start → 不推进游标（仍是 10）
       → 11 保持 pending，安排下一轮
下一轮：start = 11，完整 reconciliation，end = 11 → lastReconciled = 11
```

无论 WS 在不在，结束读取都能保住正确性；结束读取失败也只是不前进，
靠重连、启动、focus、Sync Now 修复。

### 不要为纯本地 cycle 强制两次往返

只有当 **reason 是 `remote-change`** 或 **已经有 pending remote generation** 时才握手。
一个普通的 local-event cycle 在没有 pending 时不付任何 Gateway 往返。

反过来说：如果 cycle 准备开始时已经有 pending（即使触发原因是 local-event），
这一轮**就顺手承担握手**——它本来就是 full reconciliation，没必要再多跑一轮。

## 9. WebSocket 生命周期

```text
连接条件     插件已加载 + layout ready + Gateway enabled + 配置有效 + document 可见
启动         onLayoutReady 之后解析配置 → 派生 channel → 载入该 channel 的游标 → 连接
可见         visibilitychange → visible：重连；服务端先发 current-generation 快照
隐藏         visibilitychange → hidden：关闭 socket、取消重连计时器（后台不做重连风暴）
断开         有上限退避重连：1s → 2s → 5s → 10s → 30s（上限）
重连成功     退避归零；比较快照 generation 与游标，不一致则跑一轮完整 reconciliation
配置变化     关闭旧 socket、使旧连接代际失效、重新派生 channel、载入新 channel 游标、重连
卸载        关闭 socket、取消计时器、禁止重连、移除监听器（late 消息被代际栅栏丢弃）
```

**断线不降级为轮询。** 这是硬约束，有源码审计测试锁住：整个插件里唯一的周期性计时器
是 Android 的 15 秒 **本地** adapter 元数据探测，它读本地、不发网络请求。

重连**不回放**漏掉的 generation：读到当前 `N`，若与 `lastReconciled` 不同就请求一次完整
reconciliation。

## 10. WebSocket 鉴权（跨平台兼容）

Gateway Phase 4B 原本要求 `Authorization: Bearer` header，且在**路由到 DO 之前**认证。
但浏览器与 Obsidian WebView 的 `new WebSocket(url)` **无法附带 header**，
所以长期 bearer token 不能直接进 URL。

因此 Gateway 增加了一个最小兼容层：

```text
插件  POST /v1/channels/{channel}/ticket      ← Authorization: Bearer <长期 token>
Gateway 返回 { protocol, ticket, expiresAt }   ← 60 秒 TTL
插件  new WebSocket(.../subscribe?ticket=…)    ← URL 里只有短期 ticket
Gateway 在 DO 路由之前验证 ticket（channel 绑定 + 过期 + HMAC 签名）
```

性质：

```text
stateless（用现有 SYNC_GATEWAY_TOKEN 作为 HMAC 密钥，不新增 KV / D1 / Queue / ticket 数据库）
channel 绑定（换 channel 直接失效）
60 秒 TTL
签名覆盖 protocol version + channel + expiry
不含 R2 凭据、不含文件数据、不含长期 bearer
未认证请求绝不进入 DO（与原来一致）
ticket 本身也需要 bearer 才能签发，所以 ticket 不能换 ticket
bearer header 仍然被接受，非浏览器调用方不受影响
```

## 11. 真机验证流程

```text
1. 部署 Gateway（只部署 mineral-sync-gateway，不部署 mcp / vault）
2. 设置 SYNC_GATEWAY_TOKEN secret
3. 两端 Obsidian 填相同的 Gateway endpoint 与 token，且 R2 endpoint/bucket/prefix 相同
4. 两端各执行一次 "Mineral Sync: Gateway Status"，确认 channel 指纹一致
5. 两端都保持前台，改一个文件 → 另一端自动收敛
6. 不要用 focus/resume 或 Sync Now 辅助，否则验证不到真实链路
```

## 12. 明确不在 Phase 4C 范围内

```text
Vault / MCP 写入方通知            → Phase 4D
Queue 投递可靠性                  → 后续
R2 Event Notifications            → 后续
Hot realtime / LiveDocumentRoom    → 未授权
删除语义                          → 仍为 BLOCKED
桌面端定期 R2 LIST polling         → 永不
Gateway 代理文件内容               → 永不
临时 R2 凭据 / OAuth               → 后续
```

# Phase 3A — 自动调度器语义规格（Autonomous Scheduler Semantics）

本文档**只定义语义，不定义实现**。Phase 3A 不写 scheduler 代码。

审计基准：

```text
base commit   971dfa8445ddf04b4fe431df586e850f9bac739d
              "docs: close Phase 2A / 2A.5 and freeze the network layer"
typecheck     通过
tests         106 passed | 1 skipped
build         通过，生产产物 24.2 KB
working tree  clean
```

本文档中每一条"现状"都有源码依据。凡是本文档与源码冲突，以源码为准。

---

## 0. 结论速览

```text
触发               事件 / startup / focus-resume / 未来 remoteDirty
事件语义           事件 = "state may now be dirty"，仅此而已
决策主体           永远只有 scan + previous + 纯 planner
debounce           global trailing 1200 ms（local / startup），800 ms（focus / resume）
dirty 模型         monotonic 全局 version + Map<key, version>（coalescing hint，不是事实库）
single-flight      cycle 并发 = 1，executor 并发 = 1
reconcile 范围     full reconciliation（full local scan + full remote scan + planner）
rerun 规则         stale → 立即；unresolved → backoff 5s→60s；failed → backoff 15s→5m；
                   blocked / conflict → 只等新事件
startup            一次 full reconciliation（onLayoutReady 之后 debounce 1200 ms）
focus / resume     触发，但带 ≥30 s 最小间隔
网络失败           limited backoff，不做 retry framework
认证失败           进入 blocked-by-auth，停止自动 cycle，只等配置变化 / 新本地事件
self-write event   **不抑制**（接受多一轮廉价 noop cycle）
delete             全程 BLOCKED，scheduler 不补能力
```

---

# 第一部分 现状审计（源码事实）

## 1.1 触发层现状

| 项 | 现状 | 依据 |
| --- | --- | --- |
| Vault event listener | **不存在** | 全 `src/` 无 `vault.on(` / `registerEvent` |
| timer / polling | **不存在** | 全 `src/` 无 `setInterval` / `setTimeout` |
| scheduler | **不存在** | `SafeExecutor` 在生产代码里 **零调用点** |
| 生产入口 | 只有两条命令 + 设置页两个按钮 | `main.ts:32-33`、`settings.ts:33-34` |
| 状态栏 | `addStatusBarItem()`，纯文本 | `main.ts:44-45`、`setStatus()` |

`SafeExecutor` 的唯一调用方是测试与 dev 自检脚手架：

```text
src/dev/integration/convergence.ts          （dev only，生产被 stub 掉）
test/integration/safe-executor.integration.test.ts
```

`buildSyncPlan` 在生产代码里的唯一调用方是 `bootstrap.ts:85`。也就是说：
**planner 与 executor 之间在生产路径上目前没有任何连接。** 这个连接就是 Phase 3A 本身。

## 1.2 planner 的入口与输入

`buildSyncPlan(local, remote, previous)`（`src/sync/planner.ts:7`）：

```text
纯函数、无网络、无时钟、无随机
key 全集 = local ∪ remote ∪ previous，按 localeCompare 排序后遍历
输出 SyncPlan { operations: SyncOperation[] } —— 顺序即该排序，deterministic
```

决策表（逐字对应源码）：

```text
previous 不存在：
  local 有 & remote 无                → upload   (ifNoneMatch: *)
  local 无 & remote 有                → download (ifMatch: etag)
  local 有 & remote 有                → conflict "both-created-different"

previous 存在：
  local 有 & remote 有
      local 未变 & remote 未变        → noop
      local 变   & remote 未变        → upload   (ifMatch: 观测到的 etag)
      local 未变 & remote 变          → download (ifMatch: etag)
      两侧都变                        → conflict "both-modified"
  local 无 & remote 无                → noop "both sides deleted"
  local 无 & remote 有
      remote 变                       → conflict "local-deleted-remote-modified"
      否则                            → delete-remote      ← BLOCKED
  local 有 & remote 无
      local 变                        → conflict "local-modified-remote-deleted"
      否则                            → delete-local       ← BLOCKED
```

关键观察（**决定了 scheduler 的一条硬约束**）：

> planner 的输入是**三个完整集合**。它没有任何"只考虑某几个 key"的入口，
> 也不接收任何"这次是哪个事件触发的"信息。partial reconciliation 不是"少传参数"，
> 而是"换一个正确性模型"。

## 1.3 前置条件的来源（决定了 stale 的语义）

upload 的条件写取值只有两个来源：

```text
reason "new local file"                    → expectedRemote { kind: "absent" } → PUT If-None-Match: *
reason "local changed since previous …"    → expectedRemote { kind: "etag", value: there.etag } → PUT If-Match
```

第二个来源里 `value` 来自**本轮 scan 观测到的远端 ETag**，而 `there.etag` 是
`RemoteEntry.etag?: string` —— **可选的**。当它缺失时（`executor.ts:59`）：

```text
{ status: "blocked", key, reason: "missing-remote-etag" }
```

download 同理（`executor.ts:73`）：`expectedRemote.etag` 缺失 → `blocked/missing-remote-etag`。

> 这是一条 planner 无法表达、只能由 executor 兜底的路径。scheduler 必须把它当作
> 一个**稳定复现的 blocked**（见 §4.2 表与 §5），而不是失败重试。

## 1.4 SafeExecutor 的执行模型

```text
一次只执行一个 operation（顺序，无并发，无内部队列）
execute(delete-*)                     → blocked     （硬阻断，无条件）
execute(noop / conflict)              → failed "operation … is not executable"
```

**scheduler 绝不允许把 noop / conflict 送进 executor。** 它们不是操作，是结论。

失败分类（`uploadFailure` + 各 try/catch）：

```text
412 (RemoteObjectChangedError)              → stale
4xx（非 429）                                → failed      （明确的否定答案）
5xx / 429                                    → unresolved   （ambiguous-put）
RemoteTransportError / 任何未预期异常          → unresolved   （ambiguous-put）
本地读改写（LocalFileChangedError）            → stale (local-changed)
Vault 落盘失败（parent-path-is-file 等）        → failed
state put() 抛错                              → unresolved   （state-commit-failed）
```

## 1.5 previous-state commit 模型

```text
commit 粒度          单 key（StateStore.put）
commit 时机          只有在该 operation 被证明成功之后
commit 内容          { key, local:{size,mtime}, remote:{size,etag,lastModified?},
                        syncedAt, remoteIdentity, ignorePolicy }
remote 侧字段来源      PUT 响应本身（etag + 写出的字节数）—— 不发明 lastModified
```

两条独立的写入路径，必须分开理解：

| 方法 | 语义 | 生产调用点 |
| --- | --- | --- |
| `saveVerified(map)` | "已证明双向逐字节相同"的初始 baseline | `main.ts:92`（Inspect） |
| `put(entry)` | "某条 operation 已证明完成" | `executor.ts:56`（**目前无生产调用点**） |
| `saveAll(map)` | 预留给未来 | 无人调用 |

**baseline 有效性过滤**（`main.ts:85`）：`previous` 只有在

```text
!filter.ignores(key) && entry.ignorePolicy === ignorePolicy && entry.remoteIdentity === {endpoint,bucket,prefix}
```

时才会进入 planner。这是"换 namespace / 改忽略策略 → 旧 baseline 不复用"的落点。

## 1.6 ignore policy

```text
内置排除：.obsidian/plugins/mineral-obsidian-sync/、.ds_store、thumbs.db、*~、*.tmp
用户排除：路径本身 + 全部子孙
大小写：ignores() 用 toLowerCase()，但用户规则匹配用的是**原大小写**的 normalized 路径
         ⇒ 忽略规则是"大小写不敏感的内置项 + 大小写敏感的路径前缀"
指纹：ignorePolicyFingerprint = 排序去重的规范化路径 JSON 数组
```

`scanLocal`（`vault.getFiles()`）与 `scanRemote`（LIST 结果）**都**过同一份 filter。
所以 ignored key 在 planner 眼里根本不存在，不可能产生 operation —— 包括不可能产生删除。

## 1.7 remote identity

```text
RemoteIdentity = { endpoint: new URL(endpoint).toString() 去掉尾斜杠,
                   bucket, remotePrefix: normalizePrefix(prefix) }  ← 结尾带 "/" 或空
```

`scanLocal` 是同步的；`scanRemote` 是分页 LIST。对象 key = `<prefix>/<vault 相对路径>`；
映射失败（目录占位对象、`//`、越界 prefix）会让整个 LIST **fail-closed 抛错**，
而不是静默跳过 —— 这条语义 scheduler 必须原样继承。

## 1.8 现有 status bar 状态

```text
main.ts:45         "✓ idle"           （onload）
main.ts:77         "… analyzing"      （inspect 开始）
main.ts:96         "✓ inspected" / "! conflicts"
main.ts:99         "○ offline/error"
```

无任何点击处理器。`setStatus` 是 private 方法，除了 inspect 与 dev 自检之外无人调用。

## 1.9 现有 Inspect 路径与其"单飞"真相

`inspectSyncState()` 是**目前唯一的并发保护机制**，值得逐字理解，因为它是 scheduler 的反面教材：

```text
this.activeAnalysis?.abort()        ← abort 是"请求"不是"取消"
scanLocal (同步)
Promise.all([scanRemote, loadAll])
buildBootstrapResult(..., signal)   ← signal 只在每轮 reader 循环里检查
await saveVerified(...)             ← 已经写盘了
if (signal.aborted) return          ← 在写盘【之后】才检查，直接静默返回
DryRunModal.open()
```

三条对 scheduler 有直接影响的结论：

1. **`AbortController` 不是取消原语。** `RequestUrlTransport` 调用
   `requestUrl({...})`，`SignedRequest` 里没有 `AbortSignal` 的位置，所以一次已发出的
   HTTP 请求无法被中止。scheduler 不能把 `abort()` 当作"停止 cycle"的手段。
2. **abort 检查点在副作用之后。** 被 abort 的那次 inspect 会静默 return：不弹窗、不改状态栏。
   这在本阶段是 UI 层面的小瑕疵，但作为 scheduler 的先例是**不能复制**的：scheduler
   必须在**每个写入步骤之前**检查代际是否已过期（见 §2.8）。
3. **`this.client()` 每次调用都新建实例**（`main.ts:51`），inspect 里一次流程就造了
   两个 client（`main.ts:82` 与 `main.ts:86`）。当前 settings 在一次 inspect 内不变，
   所以无害；但 scheduler 必须**一个 cycle 绑定一个 config 快照**（见 §2.9）。

## 1.10 平台与 API 事实（已核对 typings 与真机记录）

| 事实 | 来源 |
| --- | --- |
| `vault.on('create'/'modify'/'delete')` 回调参数是 `TAbstractFile` | `obsidian.d.ts:7558-7570` |
| `vault.on('rename')` 回调是 `(file, oldPath)` | `obsidian.d.ts:7576` |
| **回调类型是 `TAbstractFile`，所以文件夹事件也会到达** | 同上 |
| `vault.on('create')` **在 vault 首次加载时会为每个已存在文件各触发一次** | `obsidian.d.ts:7552-7554` |
| 官方建议：不想收到加载期的 create 事件，就在 `onLayoutReady` 里注册 | 同上 |
| `Vault.createBinary` 不创建父目录；`Vault.createFolder` 非递归 | 真机验证，`ensure-folders.ts` 注释 |
| 点目录下的文件不进 vault 索引 ⇒ `getFiles()` 看不到 | 真机验证，`development.md` |
| HEAD 的非 2xx 响应在 Android 上被平台丢弃 | 真机验证，`transport.ts` 注释 |
| executor 的远端状态来自 LIST，写入取自 PUT 响应，读取用条件 GET ⇒ 全链路 HEAD 数量为 0 | `development.md` |

最后一条对 scheduler 尤其重要：**scheduler 不需要、也不允许引入 HEAD**。

---

# 第二部分 冻结正确性边界（不可协商）

## 2.1 事件的唯一语义

```text
Vault event  ≠  upload
Vault event  ≠  download
Vault event  ≠  delete
Vault event  ≠  conflict
Vault event  ≠  noop

Vault event  =  "state may now be dirty"
```

决定 upload / download / conflict / noop / blocked delete 的，**永远且只能是**：

```text
scan current state  +  previous state  +  pure planner
```

**Scheduler 不得绕过 planner。** 任何形式的

```text
"这是 create 事件，所以上传"
"这是 delete 事件，所以计划删除"
"这是 rename，所以远端改 key"
```

都是**禁止**的。事件只能转化为 dirty 标记与"跑一轮"的请求。

理由（不是风格问题）：planner 需要三个完整集合才能区分
`new local file`（→ `If-None-Match: *`）与 `local changed`（→ `If-Match: etag`）。
只凭一个事件无法知道该用哪个前置条件，猜错就是**覆盖远端**或**无谓 412**。

## 2.2 事件不携带事实

`TAbstractFile` 上的 `stat` 是**事件发生时刻**的快照，scheduler 不得用它构造 `LocalEntry`：

```text
LocalEntry.key/size/mtime 只能来自 scan 时刻的 vault.getFiles()
```

原因：`executor` 的 stale 判定是 `scan 时的 stat` vs `执行时的 stat`。如果 scheduler
用事件时刻的 stat 造 operation，就等于把"观测"和"事件瞬间"混为一谈，
stale 保护会失去意义（详见 §3.10 / §3.11）。

## 2.3 Phase 3A 允许自动执行的操作集

```text
upload existing/new      ✅ 自动执行
download existing/new    ✅ 自动执行
noop                     ✅（不是操作，直接计入结果）
conflict                 ✅ surface only —— 不执行、不阻塞其他 key
delete-local             ⛔ BLOCKED
delete-remote            ⛔ BLOCKED
```

**删除不属于 Phase 3A。** 即使 planner 产生 delete candidate：

```text
SafeExecutor 继续返回 blocked（executor.ts:50，无条件，无开关）
Scheduler 不得偷偷补删除能力：不调 DELETE、不调 adapter.remove、不调 vault.delete、
不把 delete candidate 改写成别的操作
```

`scheduler` 对 `blocked` 的处理见 §4.2 与 §5：**计入结果、暴露、绝不因它重跑。**

## 2.4 Planner 是唯一决策者

```text
MUST: 每一轮 cycle 都重新 scan → 重新 plan
MUST NOT: 缓存 SyncPlan 到下一轮
MUST NOT: 在 cycle 内修改、过滤、重排、丢弃 planner 的 operation（除了"跳过不可执行类型"，
          而 noop/conflict 本来就不应该被送进 executor）
```

## 2.5 SafeExecutor 是唯一写入者

```text
MUST: 一切 Vault 内容写入与一切 R2 写入都经过 SafeExecutor
MUST NOT: scheduler 自己调 vault.createBinary / modifyBinary / createFolder / adapter.write*
MUST NOT: scheduler 自己调 r2.putObject / getObject / listObjects（LIST 只允许经由 scanRemote）
```

理由不只是"分层好看"：`SafeExecutor` 是唯一同时拥有**前置条件复查**、
**PUT 响应取 baseline**、**per-key 状态提交**三件事的地方。绕过它意味着绕过这三件事。

---

## 第三部分 核心设计

## 3.1 Scheduler 状态机

状态刻意只有 5 个。**不引入 `debouncing` 与 `running` 之外的任何中间态**；
backoff 不是状态，是 `idle` 上的一个定时器 + 一个原因标签（见 §5.4 的理由）。

```text
                    requestReconcile(reason)
   ┌──────────────────────────────────────────────────────────┐
   │                                                          │
   ▼                                                          │
┌──────┐  event / config-change / resume                       │
│ idle │──────────────────────────────►┌────────────┐         │
└──────┘                               │ debouncing │         │
   ▲                                   └────────────┘         │
   │                                         │                │
   │                              trailing debounce elapsed   │
   │                                         ▼                │
   │                                   ┌─────────┐            │
   │        cycle end, no dirtiness    │ running │            │
   ├───────────────────────────────────│         │            │
   │                                   └─────────┘            │
   │                                         │                │
   │                       ┌─────────────────┴──────────────┐ │
   │                       │                                │ │
   │              dirtiness detected              cycle threw │
   │              (version advanced)              (unexpected)│
   │                       │                                │ │
   │                       ▼                                ▼ │
   │              ┌──────────────┐                    ┌───────┐│
   │              │ rerun-pending│                    │ idle  ││
   │              └──────────────┘                    │ +back ││
   │                       │  start trailing debounce │  off  ││
   │                       └──────────────────────────┴───────┘│
   │                                                           │
   │                    ┌──────────────────┐                   │
   └────────────────────│ blocked-by-auth  │◄──────────────────┘
      配置变化 /        └──────────────────┘   401 / 403 / 凭据无效
      成功的一轮
```

另有一条**与状态正交**的布尔量（不是状态）：

```text
stopped = false   插件已卸载 / 已禁用 → 拒绝一切新 cycle 与新 debounce
```

`stopped` 不做成状态，因为它必须能在**任何**状态下被置位，且置位后不可恢复。

### 状态转移表

| 当前 | 输入 | 下一状态 | 动作 |
| --- | --- | --- | --- |
| idle | 任何 `requestReconcile` | debouncing | 打 dirty 标记、启动/重置 trailing debounce |
| idle | backoff 到期 | debouncing | 同上（backoff 到期的动作就是 `requestReconcile("retry")`） |
| debouncing | 又来事件 | debouncing | 重置 debounce 计时（coalesce） |
| debouncing | debounce 到期 | running | 捕获 config/generation 快照、开跑 cycle |
| debouncing | `stopped` | — | 清掉 timer，回到 idle，不再进入 running |
| running | 事件到达 | running | **只打 dirty 标记**（version++），不动 timer |
| running | config 改变 | running | 标记代际过期，**让当前 cycle 跑完**；结束后按 rerun |
| running | cycle 正常结束，无新增 dirtiness | idle | 清 cycle 期前已见的 dirty 标记 |
| running | cycle 正常结束，有新增 dirtiness | rerun-pending → running | 启动一次 trailing debounce，到期后开下一轮 |
| running | cycle 抛未预期异常 | idle | 记录 `lastError`、按 §5 决定 backoff、状态栏 error |
| running | 认证失败（401/403） | blocked-by-auth | 停止自动 cycle，状态栏 `○ auth`，**不**注册 retry timer |
| blocked-by-auth | config 改变 | debouncing | 重新尝试一轮 |
| blocked-by-auth | 新本地事件 | blocked-by-auth | 只更新状态栏为 pending，**不**开 cycle |
| 任意 | `stopped` | — | 禁止启动后续 operation 与后续 cycle |

### 为什么 backoff 不是独立状态

backoff 只需要一个"到期后请求一轮"的 timer，外加一个 `retryReason` 标签。
把它做成状态会让 `idle` / `idle+backoff` / `blocked-by-auth+backoff` 三向组合爆炸，
而它对**语义**没有任何贡献。唯一必须独立成状态的是 `blocked-by-auth`，
因为它的规则是"**连 timer 都不注册**"（§5.5），与 backoff 的"注册一个 timer"相反。

### 为什么没有 `paused` 用户状态

见 §6.2：Phase 3A **没有 Pause**。唯一类似"暂停"的是 `blocked-by-auth`，
而它是**被动的错误状态**，不是用户功能。

## 3.2 Single-flight invariant

```text
任意时刻最多只有一个 reconciliation cycle 在运行。
```

禁止：

```text
cycle A
cycle B      ← 绝不发生
cycle C
```

运行期间又出现事件时：

```text
不要启动第二轮
↓
mark dirty（version++，累积到集合）
↓
current cycle continues（绝不打断、绝不影响）
↓
current cycle finishes
↓
run another cycle
```

### rerun 是"立即"还是"再 debounce 一次"？

**决定：再 debounce 一次（短、global、单一计时器）。**

理由（针对本项目的真实规模）：

1. **coalescing**：`git checkout`、插件安装、批量粘贴会一次产生几百个事件。
   如果 cycle 期间是"立即重跑"，那么一轮 600 ms 的 cycle 期间到达的 100 个事件
   会产生 100 次重跑排队。debounce 把它们压成一轮。
2. **成本只在"事件确实打断了 cycle"时才付**：如果一轮 cycle 期间没有任何事件
   （最常见情况），version 不变，根本不会进入 rerun-pending，一轮都不多跑。
3. **"立即"没有正确性优势**：stale 的语义是"我的观测过期了"，而不是"我必须在 X ms 内
   修正它"。多等 1.2 s 不会让任何数据变得不安全 —— 条件写保护已经在原地。
4. **它天然处理了"cycle 结束瞬间又来事件"**（Case 14）：dirty 标记是 version 化的，
   debounce 只是启动方式，不承担正确性。

**唯一例外：`stale`。** §4.2 说明为什么 `stale` 走"0 延迟路径" ——
因为它意味着"执行时观测已被证伪"，此时用户刚刚停止编辑的概率极高，
而且不重跑就等于把工作留到下一个随机事件。

## 3.3 DirtySet 语义

### 定位

```text
DirtySet = wake-up / coalescing hint
DirtySet ≠ 同步事实数据库
DirtySet ≠ 待办列表
DirtySet ≠ scan 的替代品
```

它的**唯一**职责是回答："既然刚刚跑完，还有没有必要再跑一轮？"
它**不**参与 planning，**不**决定范围，**不**携带 size/mtime/etag。

### 数据结构（语义，不是实现）

```text
version      单调递增整数。任何一次"状态可能变脏"的请求都 ++
dirty        Map<canonicalKey, version>   —— 记录该 key 最后一次被标记时的 version
```

### key canonicalize

```text
MUST 使用与 scan 完全相同的 canonicalKey()（src/sync/path.ts）
```

理由：planner 的 key 空间来自 `scanLocal` 的 `canonicalKey(file.path)`。如果 DirtySet
用另一套规范化（比如 `replace(/\/+/g,'/')` 或小写化），就会得到
**永远不会与任何 planner key 相等**的 key —— 这在 Phase 3A 里只是"多跑一轮"，
但会污染未来 partial reconciliation 的正确性，因此现在就必须对齐。

```text
canonicalKey 抛错（空路径 / `.` / `..` 段）→ 丢弃该事件，不 fallback 到原始路径
不做大小写归一（Obsidian 已经有自己的路径语义）
不做 Unicode 归一（同上：scan 不归一，DirtySet 就不能归一）
```

### ignored key 是否进入 DirtySet

**决定：不进入 `dirty` map，但 `version++` 照常。**

```text
ignored key 的 event
  → version++          （必须：见 §3.9 的 clear 语义）
  → 不写入 dirty map   （因为"ignored 变化"永远不可能改变任何 planner 结果：
                        scanLocal/scanRemote 两侧都套同一份 filter）
  → 不启动 debounce / 不请求 cycle
```

唯一例外：**ignore policy 本身变化**（§6.6）—— 那时不是"某个 key 脏了"，
而是"全局 baseline 的有效性变了"，走 `requestReconcile("config-change")`。

### rename 如何表示

```text
rename(oldPath, newPath)
  → oldPath 若可 canonicalize 且未被忽略 → dirty.set(oldPath, version)
  → newPath 若解析为文件且未被忽略       → dirty.set(newPath, version)
  → version++
```

**Phase 3A 不实现 rename inference。** 也就是说：

```text
planner 看到的仍然是  旧路径消失（→ delete-remote，BLOCKED）
                      新路径出现（→ upload，If-None-Match: *）
```

这是一个**已知且可接受**的结果：

```text
本地：old/path.md 已不存在，new/path.md 存在
远端：old/path.md 仍然存在，new/path.md 被上传
```

即：**重命名在 Phase 3A 会留下一个远端孤儿对象。** 它不会被删除（delete BLOCKED），
它会被当作"远端独有对象"在下一次 planner 里给出 `download`（如果本地没有该路径）
—— 但因为它对应的是**旧路径**，而本地那份内容已经搬到新路径，于是下一轮 planner 会看到
`local 无 & remote 有` 且 previous 存在 → 若 remote 未变则 `delete-remote` → BLOCKED。

净结果：**旧路径的远端对象稳定地停在 BLOCKED，phase 3A 不会有任何破坏性动作。**
这一点必须写进用户可见文档（重命名不会自动重命名远端对象）。

跨"文件夹被重命名"的情况见 §3.6。

### duplicate event 如何合并

```text
create a.md → dirty.set("a.md", v)
modify a.md → dirty.set("a.md", v')     ← 同一个 key，只保留最新 version
modify a.md → dirty.set("a.md", v'')
modify a.md → dirty.set("a.md", v''')
```

最终：

```text
dirty = { "a.md" → v''' }
```

即"最终只保留 a.md" —— 但**注意**这不是因为它"去重成了一次同步"，
而是因为 (a) key 相同被 Map 覆盖，(b) 事件类型被**丢弃**（DirtySet 不记 kind）。
真正让 4 次事件收敛成 1 次循环的是 **trailing debounce**，不是 DirtySet。

### running 中新事件如何累积

```text
一律 version++ 并 dirty.set(key, version)
不重置任何 timer（timer 在 running 期间不允许启动，见 §3.4）
不影响当前 cycle 的任何一步
```

### cycle 完成后何时 clear

这是本设计里**最容易写错的一处**。错误写法：

```text
cycle 结束 → dirty.clear()      ← 会吞掉 cycle 运行期间到达的事件
```

正确语义（version 化 clear）：

```text
cycle 开始时：  startVersion = version          （快照）
cycle 结束时：  if (version === startVersion) dirty.clear()
                else dirty = { k → v ∈ dirty | v > startVersion }
```

等价描述：

> **只清除"本轮开始之前就已经被看见"的标记；本轮运行期间产生的标记必须存活到下一轮。**

为什么必须有"cycle 期间"这个概念：整轮 cycle 是 `await` 出来的（LIST、GET、PUT、
IndexedDB 都是异步）。任何 Vault event handler 都在这些 await 之间执行。
也就是说 **"cycle 结束时"与"事件到达"的相对顺序在 JS 单线程里是确定的，
但跨越 await 的过程不是原子的** —— 所以"清空"这个动作必须能被 version 判定为合法。

### 与"scan 期间 dirty"的关系（Case：§3.13）

```text
scan local（同步，无 await）
  ↓
用户 modify      ← 事件在 scan 之后、scan remote 期间到达
  ↓
scan remote（await）
planner
```

此时：

```text
本轮 local snapshot 已经 stale（它不包含用户的修改）
但 planner 仍会正常产出 operation，而 executor 的前置条件会保护写操作
```

Scheduler 的义务只有一条：

```text
scan 期间出现 event → version++，本轮结束必然进入 rerun
```

**即使本轮最后全部是 noop，也必须再跑一轮。** 这是非常重要的 race：
noop 只说明"用**旧**观测看，没有差异"，不说明"用**新**观测看也没有差异"。

## 3.4 debounce 语义

### global，不是 per-key

**决定：global trailing debounce，单一计时器。**

```text
任何被接受的 dirty 请求 → 重置这唯一的计时器
计时器到期                → 开一轮 cycle（full reconciliation）
```

理由：

1. cycle 是 **full reconciliation**（§3.5），per-key 计时器没有任何东西可以"只跑那个 key"。
2. per-key 计时器在 100 文件 burst 下会产生 100 个几乎同时到期的 timer，
   每个都想开一轮 cycle —— 结果是 99 次被 single-flight 拒掉，
   但**每次拒绝都必须重新安排一次 rerun**，反而制造了一层没必要的簿记。
3. global debounce 天然就是 burst 的答案（§3.7）。

### 推荐初值

```text
local Vault event（create / modify / delete / rename）   1200 ms
startup（onLayoutReady 之后的首次）                       1200 ms
focus / resume                                           800 ms
config change                                            400 ms
rerun-pending（cycle 结束后的跟进）                        1200 ms
stale 触发的 rerun                                        0 ms（见 §4.2）
```

**为什么是 1.2 s 而不是机械地取 1–2 s 的中点：**

```text
下限约束：Typing 场景下 Obsidian 的 modify 事件间隔通常在 150–400 ms。
          取值 < 800 ms 会在"用户持续打字"时不断开 cycle —— 每轮 cycle 都会
          读文件、发 LIST、可能发 PUT，而几乎每一轮都会立刻被下一个字符变成 stale。
          那既浪费网络，也把状态栏变成闪烁的噪音。

上限约束：这是交互式插件，用户"停手"到"看到同步完成"的体感延迟就是 debounce + cycle。
          cycle 本身在网络良好时约 200 ms–1 s（一次 LIST + 若干条件写）。
          把 debounce 推到 3–5 s 会让"改完一按 Ctrl+S 就想切设备"的体验变差，
          而当前 Vault 规模（个人 Vault，几百个文件）用 1.2 s 没有任何成本压力。

1.2 s 的位置：覆盖绝大部分连续输入的空隙，又让"停手"后的反馈保持在 2 s 量级。
```

**这是一个可调常数，不是语义。** 唯一属于语义的部分是：

```text
MUST: trailing（用户停手之后才跑），不是 leading（每次事件立刻跑）
MUST: 单一 global 计时器
MUST: running 期间计时器不启动（见下）
```

### running 时事件是否重新 debounce

```text
不。running 期间一切事件只 version++ / dirty.set()，不触碰计时器。
rerun 的计时器在 cycle **结束**并且判定需要 rerun 之后才启动。
```

理由：如果 running 期间允许重置计时器，那么在长 cycle（比如首轮上传 300 个文件）
期间持续到来的事件会**永远**推迟 rerun —— 计时器每次都被推后，
而 cycle 本身可能需要几分钟。结果是"用户在整个 cycle 期间的修改，
要等到 cycle 结束后再等 1.2 s"，这本来是对的；但如果计时器在 cycle 期间就一直在跑，
它可能**在 cycle 结束前到期**，而到期时刻又必须被 single-flight 拒绝并重新安排 ——
纯属多余。让计时器只在 `idle` / `rerun-pending` 上存在，代码路径少一半。

## 3.5 Reconcile 范围：full reconciliation

**结论：Phase 3A 第一版 = full reconciliation。**

```text
每一个 cycle：
  full local scan   （vault.getFiles() + filter）
  full remote scan  （ListObjectsV2 全部分页 + filter）
  previous 全量载入 + identity/ignorePolicy 过滤
  buildSyncPlan(local, remote, previous)
```

### 为什么不做 key-scoped reconciliation

```text
1. planner 的输入是三个完整集合。要"只跑 a.md"，就必须构造出
   local = {a.md}、remote = {a.md}、previous = {a.md} 三个 map ——
   而这三份"局部真值"必须来自一次全量 scan。也就是说，
   key-scoped 并不能省掉全量 scan，只是把"全量 scan"改名为
   "全量 scan + 过滤"。省不下来。

2. 一旦真的只扫 dirty key，正确性模型就变了：
   planner 判断 "new local file" 依赖 previous 里【没有】这个 key；
   判断 delete 依赖 previous 里【有】而本次 scan 里【没有】。
   "本次 scan 里没有" 这个事实，只有在扫描范围覆盖全 key 空间时才成立。
   局部扫描会把"未被扫描"错误地表达成"不存在" —— 后果是批量删除候选
   （现在被 BLOCKED，所以不会立刻造成数据损失，但那只是一个侥幸的兜底，
   不是可以依赖的正确性）。

3. 规模。个人 Vault 几百个文件：本地 scan 是内存遍历（同步、无 IO，
   getFiles() 的 stat 已经是索引里的数据）；远端 scan 是一次分页 LIST
   （几百个 key 大约 1–2 个请求）。一轮 cycle 的固定开销本来就在
   "1 次 LIST" 这个量级上。partial reconciliation 能省下的
   （本地遍历 + 少数几个 LIST 页）远小于它引入的正确性风险。
```

### DirtySet 在 Phase 3A 里的真实作用

```text
DirtySet 只用于回答"要不要再跑一轮"。
它不缩小 cycle 的范围。
```

这是**有意**的：先让"再跑一轮"这个机制在没有正确性风险的位置上线，
等规模真的需要时，再单独设计 key-scoped scan（那是一个独立阶段，
需要同时改 scan、planner 输入契约与 baseline 语义）。

### partial reconciliation 是明确非目标

```text
MUST NOT: 为了"更快"而在 Phase 3A 里实现只扫 dirty key 的路径
```

## 3.6 Local event 来源

Phase 3A 只监听 **Vault** 事件，且只在 `onLayoutReady` 之后注册。

```text
vault.on('create', (file: TAbstractFile) => …)
vault.on('modify', (file: TAbstractFile) => …)
vault.on('delete', (file: TAbstractFile) => …)
vault.on('rename', (file: TAbstractFile, oldPath: string) => …)
```

监听器**必须**通过 `Plugin.registerEvent()` 注册（`Plugin` 继承 `Component`，
`registerEvent` 返回的 `EventRef` 在 unload 时自动 `offref`）。
这样 §6.3 的"卸载时移除监听器"不需要手写清理代码。

### 每种事件的语义

| 事件 | 回调参数 | Scheduler 语义 |
| --- | --- | --- |
| `create` | `TAbstractFile`（**可能是 TFolder**） | 解析为 `TFile` → `dirty.set(canonicalKey(path))`；解析为 `TFolder` → 忽略（§3.6.2） |
| `modify` | `TAbstractFile`（实际只对文件触发） | 同上 |
| `delete` | `TAbstractFile`（**可能是 TFolder**） | 无法解析实体（已不存在）。见 §3.6.1 |
| `rename` | `(file, oldPath)` | 若 `file` 是文件 → 新路径 + 旧路径都 dirty；若是文件夹 → 见 §3.6.2 |
| 加载期的 `create` | 每个已存在文件一次 | **不注册监听器于 onload**，因此收不到；startup 走一次全局 reconcile |

**统一规则：所有事件无论类型，都先 `version++`，再做"是否写入 dirty map"的判断。**
事件类型（create/modify/delete/rename）在 Phase 3A 里**不写入 DirtySet、不参与任何决策**。

### 3.6.1 delete 事件与"文件夹删除 vs 文件删除"

`delete` 回调拿到的是已被移除的实体，`vault.getFileByPath(path)` 必然返回 `null`，
所以**无法**通过 vault 查询判断它是文件还是文件夹。处理方式：

```text
若该 path 是某个【已知文件夹路径】→ 忽略（不写 dirty map，version 照常 ++）
否则                              → dirty.set(canonicalKey(path))
```

"已知文件夹路径"的判定语义（实现细节留待 Phase 3A 决定，但语义必须如此）：
只有当一个 path **从未**以 `TFile` 身份出现过时，才允许怀疑它是文件夹。
**宁可信其是文件**：把文件夹路径误当文件写进 dirty map 的代价是
"多跑一轮 noop cycle"；反过来（把文件路径当文件夹忽略）的代价是
"丢失一次真实变化" —— 两者不对称，必须偏向后者不可能发生。

> 结论：删除事件**默认按文件处理**，把"它其实是文件夹"当作误报来容忍。
> 这也顺带覆盖了"删除文件夹会连带删除其中文件"的情况：那个文件夹路径会
> 进入 dirty map，触发一轮 reconcile，而那一轮会**完整重扫**，
> 从容发现里面所有文件都消失了（然后产出 BLOCKED 的 delete candidate）。

### 3.6.2 文件夹事件

```text
优先考虑：folder events do not directly map to remote objects
```

依据：

```text
1. 同步对象是 R2 objects。对象 key 与 Vault 文件路径一一对应。
2. canonical data model 里没有"空目录"这个概念：
   scanLocal 用 getFiles()（只有文件），scanRemote 用 LIST（只有对象）。
3. 因此一个纯文件夹事件（createFolder / renameFolder）在 planner 里
   【不可能】产生任何差异 —— 除非它的子孙文件发生了变化，
   而子孙文件的变化有自己的事件（或至少会被下一轮的全量 scan 看到）。
```

**决定：**

```text
create/modify/delete/rename 中，凡是解析为 TFolder 的事件：
  → version++                （保守，无害）
  → 不写入 dirty map         （写入也没有任何 planner 意义）
  → 不启动 debounce          （避免"下载时建两个父目录 ⇒ 两次无意义 cycle"）
```

判定方式（实现语义，不在本阶段写代码）：

```text
优先：instanceof TFolder（obsidian 是 external，单实例）
兜底：若 `instanceof` 不可靠，用 "是否具有 children 数组 / 缺少 stat" 判定
      —— 但【绝不】用"路径出现过 createFolder 事件"这种状态推断，
      因为它会与 unload/reload、外部程序直接落盘等情况冲突。
```

### 3.6.3 §3.13 的收尾：父目录创建事件

下载 nested file 时 executor 的调用序列是：

```text
ensureParentFolders → Vault.createFolder × N（逐级）
                    → Vault.createBinary   × 1
```

产生了：

```text
N × (folder create event)   ← §3.6.2 忽略
1 × (file create event)     ← dirty.set(key)   → 触发一轮 noop cycle
```

**已知代价：每次"创建新嵌套文件"的下载会多产生一轮 noop cycle。**
这个代价是可接受的，而且**不做特殊优化**：

```text
MUST NOT: 用"下载前先记住要建哪些目录，然后在事件里匹配忽略"这类启发式
          —— 那正是 §3.8 要拒绝的 self-write suppression 的一个变体。
```

如果未来要削掉这一轮，正确做法是让 executor 暴露"我刚刚写了什么"这一事实
（一个显式的 write-intent 通道），而不是靠事件猜测。那是后续阶段的事。

### 3.6.4 一个必须承认的现实限制

`vault.on` 只覆盖 **Obsidian 自己经手的**改动（编辑器、文件浏览器、
插件 API 调用）。如果用户用资源管理器 / `git checkout` / `rsync` 直接改磁盘，
Obsidian 的 Vault 索引**不一定会**为每个文件补发事件。

```text
所以：scheduler 的正确性不能建立在"事件覆盖一切"这个假设上。
```

这正是 startup reconcile（§6.5）与 focus/resume（§6.1）必须存在的原因 ——
它们是"绕过事件的变化"的兜底发现入口。**但也要清楚：**
Phase 3A 没有持续 polling，因此在一个长时间打开、没有任何事件的会话里，
纯外部修改可能**要到下一次 startup / focus / resume 才被发现**。

这是**已知且接受**的限制，写入非目标（§7）。

### 3.7 Large burst

```text
git checkout            → 可能 100–1000 个 create/modify/delete 事件
100 文件插件安装/更新     → 同上
批量粘贴 / 复制           → 同一文件多次 modify + 多个 create
```

处理：

```text
100 events → 100 × version++ → dirty map 收敛到 ≤100 个 key
           → 单一 global debounce 被重置 100 次
           → 用户/批量操作停止后 1.2 s
           → 【1】轮 cycle
```

**绝不能发生：**

```text
100 events → 100 个 cycle
```

保证机制的两条腿：

1. **global debounce**：所有事件共享一个计时器，事件只推迟它，不复制它。
2. **single-flight**：即使 debounce 因为某种原因连续到期（例如批量操作分成了
   几个相隔 1.5 s 的波次），也绝不会出现两个 cycle 重叠；
   第二波只会在第一波结束后以 rerun 的形式跑。

一个值得注意的细节：**批量操作期间 cycle 可能已经在跑**（用户先改了 1 个文件触发
debounce，cycle 开跑，随后 `git checkout` 灌入 500 个事件）。
此时 500 个事件只做 `version++` + `dirty.set`，cycle 跑完 → 判定脏 → 再 debounce
1.2 s → 第二轮 cycle 看到全部 500 个变化。**总轮数 = 2，不是 501。**

### 3.8 插件自己的本地写入事件（最重要的一节）

时间线：

```text
remote download
↓
SafeExecutor.download()
↓
vault.modifyBinary(file, bytes)  /  vault.createBinary(path, bytes)
↓
Obsidian emits 'modify' / 'create'
↓
scheduler hears event
↓
dirty.set(key)   →  一轮额外的 reconcile
```

## 方案 A：不抑制

```text
所有 Vault event 都 mark dirty（包括插件自己写出来的）
```

优点：

```text
简单：不需要任何"我刚写过什么"的簿记
不会遗漏真实变化：任何抑制逻辑的漏洞都会变成"漏同步"，而漏同步是数据损失
自愈：多出来的那一轮会顺便修复 ambiguous-put 与 state-commit-failed
      （§8 / development.md 的既知技术项 b）
```

缺点：

```text
自己的 download 会触发一轮额外 reconcile
每次嵌套文件下载 = 1 轮额外 cycle（含 1 次 LIST）
```

## 方案 B：Self-write suppression

```text
maintain selfWriteSet / generation / short-lived marker
来忽略 Executor 自己产生的 Vault event
```

优点：

```text
省掉那次额外 cycle
```

风险（**这是决定性的一条**）：

```text
SafeExecutor 在写盘之后、commit 之前会 re-stat 并提交 {size, mtime} baseline
（executor.ts:92-94）。

如果抑制逻辑是"某 key 在 T 毫秒内的事件全部忽略"，那么在
【modifyBinary 完成 → commit 完成】这个窗口里，用户对同一文件的那一次真实修改
会被这个时间窗一起吞掉。

后果不是"多一轮"，而是：
  baseline 记录了 executor 写下的 mtime，
  而本地内容已经是用户改过的新版本，
  下一轮 planner 看到 local 与 previous 的 size/mtime 一致 → noop
  → 【用户的修改永远不会被上传】
```

也就是说：**方案 B 的错误方向是"静默丢失用户的修改"，而方案 A 的错误方向是"多一次 LIST"。**
在 data safety 面前这两个代价不在同一个量级。

还有第二个理由：**executor 目前不告诉任何人它写了什么。**
`OperationResult` 只有 `{status, key}`，没有"这不是时间窗，这是我写的"的证据。
所以任何抑制都只能是**启发式**（时间窗 / 路径匹配），启发式就会误吞。

## Phase 3A 推荐：方案 A（不抑制）

```text
决定：Phase 3A 不实现任何 self-write suppression。
```

必须同时写下来的细则：

```text
1. 额外的那一轮是【廉价且无破坏性】的：planner 会看到
   local == previous（刚提交的 baseline）且 remote == previous → 全部 noop。
   网络开销 = 1 次 LIST（无 GET、无 PUT、无 HEAD）。
2. 它不是纯粹的浪费 —— 它是 ambiguous-put / state-commit-failed 的自然自愈路径。
   把它优化掉等于把 §8 的自愈机制一起优化掉。
3. 它可能被 debounce 与用户的下一次编辑合并（用户在下载后的 1.2 s 内又编辑了），
   此时那一轮同时也是用户编辑的同步轮 —— 一次，不是两次。
4. 它绝不会产生反馈循环：executor 写的文件会立刻拿到 baseline，
   所以第二轮 noop，不会写、不会再触发新事件。
```

**"优先安全而不是省一次 scan"在这里的准确含义**：省掉的那一次 scan 不是收益，
而是用一次静默的数据丢失风险换来的一次 LIST。

## 3.9 Cycle 的完整语义

### 一轮 cycle 的正式定义

```text
Cycle start
↓
1. 检查 stopped / blocked-by-auth → 拒绝启动
2. 捕获 cycle 快照：
     configToken     = { endpoint, bucket, prefix, ignorePolicyFingerprint,
                         accessKeyId, generation }
     startVersion    = version
     一个 client 实例（绑定上面的 config 快照，绝不在 cycle 中途重新读 settings）
3. 检查 config 是否仍然是当前配置 → 否则立即结束（不写任何东西）
4. scan local（同步，无 await）
5. scan remote（await，可能多页）
6. load previous（await）+ 按 identity / ignorePolicy 过滤
7. planner（纯函数，同步）
8. 顺序执行 plan 中【可执行的】operation：
     upload / download → SafeExecutor.execute()
     noop / conflict   → 不送 executor，直接计入结果
     delete-*          → 不送 executor 也可以（结果相同），但送进去会得到 blocked；
                         语义上二者等价，实现时择一即可（见下）
9. 每条成功 operation 的 previous-state 由 executor 自己 per-key 提交
10. 收集结果：applied / stale / failed / unresolved / blocked / conflict
11. cycle end
↓
decide：rerun / idle / backoff / blocked-by-auth
```

关于第 8 步的 delete：推荐**把 delete candidate 送进 executor 并如实记录它的 `blocked`**，
因为这样"删除被阻断"是一个**被执行的、有记录的结论**，而不是 scheduler 偷偷过滤掉的东西。
scheduler 不得依赖"我知道它会被 block 所以我不送"。

### cycle = optimistic reconciliation attempt，不是事务

必须明文写死：

```text
一轮 cycle 不是 atomic sync transaction。
一轮 cycle 不是一致性快照。
一轮 cycle 是【一次乐观的、基于某一时刻观测的重试性收敛尝试】。
```

理由：local 与 remote 在 cycle 执行期间**会继续变化**（用户编辑、其他设备写 R2）。
本轮 cycle 的 `local` / `remote` map 只代表 **scan 那一刻** 的观测，
planner 的 operation 只携带那份观测里提取出来的**前置条件**。

安全性不来自"快照是原子的"，而来自：

```text
executor 在执行前后复查前置条件（local stat / remote ETag / If-None-Match）
任何前置条件不再成立 → stale / 412 → 本轮该 key 不写，等下一轮
```

### Plan lifetime（硬不变式）

```text
一个 SyncPlan 只属于生成它的那一轮 observation。
cycle 结束（无论成功、部分失败、抛错）→ plan 丢弃。
下一轮必须重新 scan → 重新 plan。
```

```text
MUST NOT: 把旧 plan 缓存到下一轮继续执行
MUST NOT: 对旧 plan 做"只重跑失败的那几条"的局部重试
```

理由：`expectedRemote.etag` / `expectedLocal.{size,mtime}` 都是**观测时刻的事实**。
用旧 plan 重试，等于用一个已知过期的观测去写 —— 最好的情况是 412，
最坏的情况是 If-None-Match 与"其实已经存在"的组合下产生一次不该发生的写尝试。

### 执行顺序

```text
MUST: 保持 planner 返回的顺序（key 的 localeCompare 升序），逐条顺序执行
MUST NOT: 重排成 "uploads first" / "downloads first"
MUST NOT: 引入并行 priority queue
MUST NOT: 引入 operation 级并发
```

现状依据：`planner.ts:10` 的排序就是全部的 deterministic 保证；
`SafeExecutor` 是顺序的（无内部并发），`development.md` 把它定义为"顺序执行"。

不引入"uploads first"的理由：那会引入第二个排序策略（谁优先？按 key？
按操作类型？两种混合时按什么？），而它带来的收益（父目录先就位？）
在**跨 key** 的语义里根本不存在 —— 每个 key 的 operation 是自包含的
（download 会自己 ensureParentFolders）。**记录为可选优化，不进 Phase 3A。**

### Concurrency

```text
scheduler cycles concurrency      = 1
executor operation concurrency    = 1
```

`bootstrap.ts` 里的 `concurrency = 3` 只属于 **Inspect 路径**（内容哈希比对），
Phase 3A 的 cycle **不调用** `buildBootstrapResult`（见 §9）。

---

## 第四部分 结果语义

## 4.1 结果分类的现状依据

`OperationResult`（`executor.ts:12-19`）**不含** `conflict` —— 因为 conflict 从来不是
executor 的产物，它是 planner 的产物。所以 scheduler 的结果汇总必须把两类合并：

```text
executor 结果： applied | stale | failed | unresolved | blocked
planner 结论：  noop   | conflict        （不送 executor）
```

## 4.2 结果处理表

| Result | 本轮继续执行其他 key | 自动 rerun | backoff | 用户可见 |
| --- | --- | --- | --- | --- |
| `applied` | ✅ 继续 | 不需要（但若有 dirty 则照常 rerun） | 无 | 计入 `lastResultCounts`；状态栏在 cycle 结束时汇总 |
| `stale` | ✅ 继续 | ✅ **是，立即**（0 ms，跳过 debounce） | 无 | 不单独提示（这是正常竞争，不是错误）；debug 日志记录 |
| `unresolved`（ambiguous-put / state-commit-failed） | ✅ 继续 | ✅ 是，经过 **backoff** | 初始 5 s，倍增至上限 60 s | 状态栏 `○ error`；debug 日志；**不弹 Notice** |
| `failed`（4xx / Vault 落盘失败） | ✅ 继续 | ✅ 是，经过 **backoff** | 初始 15 s，倍增至上限 5 min | 状态栏 `○ error`；同一 key 连续失败才值得一次 Notice |
| `blocked`（delete / missing-remote-etag） | ✅ 继续 | ❌ **否**（只等新事件 / config-change） | 无 | 计入 `blocked` 计数；`delete-*` 的存在应可在 Inspect 里看到 |
| `conflict` | ✅ **继续**（其他 key 正常收敛） | ❌ 否（只等新事件） | 无 | 状态栏 `! conflicts` + 冲突数；细节留给 Inspect |

"本轮继续执行其他 key" 对所有结果是 **YES**：**没有任何单 key 结果可以中止整轮 cycle。**

### 4.3 为什么 `stale` 走 0 延迟路径

```text
stale 的含义：执行器在【即将写】的那一刻发现观测已被证伪。
```

这个信号的价值在于它的**即时性**：用户刚刚改完文件、或另一台设备刚刚写完 R2，
而我们的 plan 已经过期。此时：

```text
1. 新状态极可能【已经稳定】（用户停手了，远端写者写完了一次 PUT）。
   debounce 的存在意义是"等编辑停下来"，而 stale 本身已经证明
   "在观测之后发生过一次完整的写"。
2. 不立即重跑的唯一后果是"把收敛推迟到下一个随机事件" —— 可能几分钟。
   对一个以"改完就能在另一台设备看到"为目标的插件，这是最差的行为。
3. 风险极低：立即重跑就是一次 full scan + plan。如果又 stale，还会再触发一次。
   这就是为什么必须有 §5 的循环保护 —— 但 stale 的循环风险远低于 unresolved：
   stale 要求"远端/本地在两次观测之间真的变了"，这在真实环境里不可能持续发生；
   unresolved 只要求"写请求没有完成"，那在断网时可以【每一轮】都发生。
```

### 4.4 Conflict 语义

```text
如果 planner 得到 conflict：
  Scheduler 不得停止整个系统。
  其他 unrelated keys 必须继续执行。
```

明确回答"其他 unrelated keys 是否继续执行"：

```text
YES —— 且这不是"推荐"而是【必须】。
```

依据与理由：

```text
1. planner 的输出本来就是 per-key 独立的（每个 key 一条 operation）。
   conflict 只是"这一个 key 的结论"，它不携带任何全局含义。
2. 一个 first-sync 的 both-created-different 冲突，不应该阻止
   其余 400 个"远端独有 → 需要下载"的 key 完成收敛。
3. 停止整个系统会让"一个冲突"变成"整个 Vault 不同步" ——
   这会把一个可控的、局部的、有明确 UI 出口的状态，
   放大成一个静默的整体故障。
```

定义：

```text
conflicted key stays unresolved
  → 它的 planner 结论是 conflict，不执行、不提交 state、保持 conflict
  → 下一轮 planner 仍然会为它产出 conflict（因为两侧都还没变）
other keys converge normally
status bar exposes conflict count
```

```text
MUST NOT: 在 Phase 3A 实现 conflict merge UI / 自动解决 / "保留两边"的重命名
MUST NOT: 因为存在 conflict 就禁止 upload / download 其他 key
MUST NOT: 把 conflict 当作 stale 或 unresolved 来 backoff 重试
```

现有 UI 依据：`dry-run-modal.ts:18-21` 已经把 `conflict` 单独成组并用错误色显示。
Phase 3A **不新增** conflict UI；现有 Inspect 报告就是"surface"的落点。

## 4.5 状态栏

现有 invariant **必须保持**：

```text
Status bar is read-only.
```

Phase 3A 新增的被动状态（`setStatus` 的文本）：

```text
✓ synced        idle，且上一轮 cycle 无 conflict / error
✓ idle          idle，尚无任何 cycle（onload 后的初始值）
… pending       debouncing（有 dirty 等待处理）
↻ syncing       running
! conflicts     idle，但存在 conflict（可带数量）
○ offline/error idle，上一轮有 unresolved / failed，或处于 blocked-by-auth
— stopped       插件已卸载（实际上卸载后状态栏已消失，仅作语义完整性）
```

```text
MUST NOT: 给状态栏元素绑定任何点击处理器
MUST NOT: 状态栏触发同步
如果未来要实现点击行为：只能 open diagnostics（例如 Inspect 报告），
                        不得 trigger sync / 不得 retry / 不得 pause
```

注意状态栏与 Inspect 的交互：Inspect 现在会写 `"… analyzing"` / `"✓ inspected"`。
Phase 3A 必须明确一个 **owner**（建议：两者都经同一个 `setStatus`，
但 Inspect 结束后的值必须让位给 scheduler 的真实状态）。
不能出现"sync cycle 在跑，但状态栏停在 `✓ inspected` 因为用户刚点了 Inspect"。

## 4.6 Manual commands

```text
Sync Now          ⛔ NO
Push Now          ⛔ NO
Pull Now          ⛔ NO
Retry Now         ⛔ NO（即使作为开发工具也不进 production）
Pause / Resume    ⛔ NO（见 §6.2）
```

现有两条命令继续存在且**不改变性质**：

```text
Mineral Sync: Inspect Sync State   → read-only diagnostics（不得调用 scheduler）
R2 Sync: Test Connection           → 单次 LIST 连通性诊断
```

明确：

```text
MUST NOT: 让 Inspect 调用 scheduler 的 requestReconcile
MUST NOT: 让 Inspect 触发一轮同步
MUST NOT: 让 Test Connection 参与任何调度决策（它的结果不改变 dirty 状态）
```

Inspect 与 scheduler 的**唯一**合法交互是"读同一份状态"：
scheduler 的诊断信息可以被 Inspect 显示（§4.7），但 Inspect 不写 scheduler 状态。

## 4.7 Runtime diagnostics（最小集合）

内存中的统计对象，**不入库、不上报、不持久化**：

```text
lastCycleStartedAt      number | undefined
lastCycleFinishedAt     number | undefined
lastCycleReason         "startup" | "local-event" | "focus-resume" | "stale" |
                        "retry" | "config-change" | "remote-change"
lastResultCounts        { applied, stale, unresolved, failed, blocked, conflict, noop }
lastError               { at, kind: "auth" | "transport" | "http" | "vault" | "state",
                          message: string }   ← 必须脱敏（复用 main.ts 的
                                                safeConnectionDiagnostic 策略）
pendingDirtyCount       number             ← dirty map 大小
dirtyVersion            number
currentState            "idle" | "debouncing" | "running" | "rerun-pending" | "blocked-by-auth"
configGeneration        number
stopped                 boolean
```

消费者（Phase 3A 不要求全部接上，但结构必须现在定）：

```text
status bar        → currentState + conflict 计数 + error 有无
Inspect 报告      → lastCycle* / lastResultCounts（追加一节只读信息）
debug 日志        → lastError 细节
```

```text
MUST NOT: 建立 telemetry / 上报 / 远端日志
MUST NOT: 把凭据、签名头、文件正文写进任何诊断字段
```

## 4.8 Logging

```text
禁止：每次文件 modify 都 console.log（噪音会淹没真正有用的信息，
      而且 writing 期间每秒可能几十条）
```

只记录（`debugLogging` 开启时）：

```text
cycle start          （含 reason、configGeneration、startVersion）
cycle end            （含耗时、lastResultCounts）
状态机转移            （idle→debouncing→running→…）
backoff 安排与到期
unexpected errors    （沿用现有 console.error 风格）
```

永不记录：

```text
文件正文 / 任何字节内容
credentials（accessKeyId、secretAccessKey）
signed headers（Authorization、x-amz-*）
完整 URL（应脱敏成 endpoint 占位）
```

现状依据：`main.ts:54-63` 的 `safeConnectionDiagnostic` 已实现了脱敏策略，
scheduler 的日志必须复用它，不得另起一套。

---

## 第五部分 循环、失败与生命周期

## 5.1 无限 rerun loop 的形态

```text
cycle → same result → immediate cycle → same result → 100% CPU / network storm
```

四种可能触发它的结果：

```text
failed       例如 403 / Vault 路径被文件占用
unresolved   例如断网、PUT 结果不明
blocked      delete candidate、missing-remote-etag
conflict     两侧持续都变
```

**关键观察：这四种结果有一个共同特征 —— 它们在"输入完全没变"的情况下会稳定复现。**
（`stale` 不在其中：stale 要求输入端真的发生了写。）

所以防止 loop 的**唯一**原则是：

```text
一次 cycle 之后，只有当【有理由相信输入已经变了】时才自动再跑。
否则只等新的外部触发。
```

## 5.2 明确的 rerun 触发规则

```text
应该 immediate rerun（0 ms）：
  - 出现至少一个 stale
  - 本轮运行期间有新的 dirty 事件（version 前进）

应该 rerun with backoff：
  - 出现 unresolved（ambiguous-put / state-commit-failed）
  - 出现 failed（4xx / Vault 落盘失败）
  - 传输失败（RemoteTransportError）
  - 5xx / 429

不应该自动 rerun（只等新事件 / config-change / focus-resume / 未来 remoteDirty）：
  - blocked（delete-local / delete-remote / missing-remote-etag）
  - conflict
  - 全部 noop 且无 dirty
  - blocked-by-auth（连 timer 都不注册）
```

## 5.3 "只等新事件"的判定必须是**纯函数式**的

```text
blocked / conflict 不自动 rerun 的正确性依赖一条不变式：

  「在没有任何外部触发的情况下，again == again」
  即：如果同样的 local / remote / previous 再跑一轮，
      会得到完全相同的 blocked / conflict 结果。

这条不变式成立，因为 planner 是纯函数（planner.ts 无 IO、无时钟、无随机）。
```

**但要小心一个漏洞**：`blocked/missing-remote-etag` 不是"同样的输入 → 同样的结果"。
它的输入里包含了"本次 scan 的 remote 是否给出了 ETag"，而 LIST 的返回
在某些情况下可能变化（例如对象被重写后 ETag 出现/消失）。
不过这不构成 loop 风险：`missing-remote-etag` 意味着 **planner 拿到了
一个没有 ETag 的 RemoteEntry**，而 `remoteChanged()`（fingerprint.ts:20-27）
在 baseline 侧也没有 ETag 时会保守判定为"已变化"。这类 key 的下一轮
要么因为 remote 未变而进入 delete/conflict 分支，要么因为 ETag 出现了
而变成可执行的 upload/download。**它不会在同一状态上无限复现。**

## 5.4 Backoff 参数（Phase 3A 第一版，刻意简单）

```text
unresolved：
  initial     5 s
  倍数        ×2
  max         60 s
  重置条件    一次 cycle 结束时 unresolved 计数为 0

failed：
  initial     15 s
  倍数        ×2
  max         5 min
  重置条件    一次 cycle 结束时 failed 计数为 0

传输类失败（RemoteTransportError）算 unresolved 路径，不算 failed。
```

**为什么两类分开：**

```text
unresolved 是"我们不知道发生了什么" —— 它可能是瞬时的（一次丢包），
  也可能是持久的（真的断网）。5 s 起步能在短暂抖动后快速恢复，
  而 ×2 到 60 s 意味着持续断网时每分钟只尝试一次，不会形成网络风暴。

failed 是"服务器或本地明确拒绝了" —— 4xx 与 Vault 落盘失败都不会
  因为多等几秒而变好（403 需要改配置，parent-path-is-file 需要用户改文件系统）。
  所以起步更慢（15 s），上限更长（5 min），避免无意义的重复请求。
```

**为什么不做成状态机（指数退避的状态）**：

```text
backoff 只是一个 (delay, reason) 的 timer。
把它做成状态会让"idle 有 backoff / blocked-by-auth 有 backoff /
rerun-pending 有 backoff"三向组合爆炸，而它对语义没有任何贡献。
唯一需要独立成状态的是 blocked-by-auth，因为它的规则是
"连 timer 都不注册"，与 backoff 相反。
```

**backoff timer 到期时只做一件事**：`requestReconcile("retry")` ——
走正常的 state machine（`idle → debouncing → running`），而不是绕过它。
这样"config 在 backoff 期间改变了"这类竞态会被 §6.6 的代际检查自然吸收。

## 5.5 认证失败

```text
401 / 403 / 明确无效凭据
```

**绝对不能**：

```text
每 2 秒自动再试一次
```

规则：

```text
1. 进入 blocked-by-auth 状态
2. 状态栏 → "○ offline/error"（或专门的 "○ auth"）
3. 不做任何自动重试（不注册 timer）
4. 只等：
     a. 配置变化（endpoint / bucket / prefix / credentials / ignore policy）
     b. 插件重新加载（onload → startup cycle）
     c. 【可选】一个新的本地事件到达时，允许【一次】探测性 cycle
        —— 但探测失败必须立刻回到 blocked-by-auth，且不得注册下一次
5. 仍然不能增加 Sync Now
```

关于 (c) 的选择：推荐 **允许一次探测性 cycle，但严格限流**（例如距上次
auth 失败至少 60 s 才允许一次）。理由：用户在手机上遇到临时
token 过期后重新登录、或网络策略短暂失效，是真实场景；
完全不给任何恢复路径会要求用户必须重启插件。
但限流是硬要求 —— 这是唯一一条"错误状态下仍然发起请求"的规则。

**传输层依据**（`errors.ts`）：401/403 是**完成的 HTTP 交换**，
因此它们是 `RemoteHttpError`（→ `failed`），而不是 `RemoteTransportError`。
executor 会把 upload 的 403 归为 `failed`（`executor.ts:30`），
但 **LIST 的 403 会在 `scanRemote` 阶段直接抛出**，根本不进入 executor。
所以 scheduler 必须在**扫描阶段**就识别 auth 失败：

```text
LIST 抛 RemoteHttpError(status 401|403)  →  blocked-by-auth
LIST 抛 RemoteTransportError             →  unresolved 类 backoff
LIST 抛其他 RemoteHttpError(4xx/5xx)     →  failed / unresolved 类 backoff
LIST 抛 "R2 returned an invalid ListObjectsV2 response" 等解析错误 → failed 类 backoff
```

最后一类（fail-closed 的解析/映射错误，例如 bucket 里有目录占位对象）
必须在文档里点明：**它不是认证问题、不是网络问题，重试不会变好。**
应当走 failed 的长 backoff，并把脱敏后的原因暴露到状态栏 / 日志。

## 5.6 Config change（含 generation token 语义）

用户改动：

```text
endpoint / bucket / remote prefix / credentials / ignoredPaths
```

规则：

```text
1. 配置变化 → configGeneration++
2. 取消 pending debounce（清 timer，dirty 标记保留）
3. 【不尝试取消】正在运行的 cycle —— 技术上做不到（见 §1.9：requestUrl 无 AbortSignal）
4. 让运行中的旧 cycle 自行跑完
5. 旧 cycle 结束后：
     - 它捕获的 configToken 与当前不一致 → 丢弃其结果（不进入诊断计数）
     - 它的 previous-state 提交带的 remoteIdentity / ignorePolicy 是【旧】的
       → 因此下次 loadAll 的过滤会自然让它们失效（main.ts:85 的同一套过滤）
6. 立即 requestReconcile("config-change")（400 ms debounce）
```

### generation token 的确切内容

```text
cycle 开始时捕获并冻结：
  endpoint / bucket / remotePrefix（原始值，不经 normalize）
  ignorePolicyFingerprint
  accessKeyId
  configGeneration（一个单调计数，每次 saveSettings 递增）
```

**为什么 accessKeyId 与 configGeneration 都要：**

```text
accessKeyId 能区分"换了另一把钥匙"；
但 secretAccessKey 被【轮换】而 accessKeyId 不变时，
光靠 accessKeyId 检测不到变化。
configGeneration 在每次 saveSettings() 时递增，因此覆盖了这种情况
（settings.ts 的所有 onChange 都会 await plugin.saveSettings()）。
```

**为什么 secretAccessKey 本身不进 token**：不必要地把密钥复制进内存里的多个对象，
违反"最少持有"原则。generation 已经足够。

### running 中配置改变时，旧 cycle 是否应该继续？

```text
继续 —— 这不是妥协，而是因为它不可能造成跨 identity 的污染：
```

```text
1. 旧 cycle 的 PUT 目标 URL 来自旧 endpoint/bucket/prefix。
   如果用户改的是 identity，那么旧 cycle 写的是【旧 namespace】——
   那是它自己观测过的 namespace，不是新 namespace。不存在"写错地方"。
2. 旧 cycle 的 previous-state 提交带有旧的 remoteIdentity / ignorePolicy 字段，
   因此新配置下的过滤（main.ts:85 的同一套）会让它们失效。
   代价是"旧 cycle 的 baseline 白写了"，不是"新 namespace 被污染"。
3. 旧 cycle 的 upload 前置条件来自旧 namespace 的 ETag。写到新 namespace
   时它压根不会执行（因为 URL 已经变了 —— 这也是为什么必须冻结
   client 而不是在 cycle 中途重新读 settings）。
4. 强行"取消"在技术上不可行（无 AbortSignal），假装取消只会让状态更难推理。
```

**必须写死的一条**：

```text
MUST NOT: 让一个 cycle 在运行中途重新读取 settings 并切换 identity
```

这从正面强制了"一个 cycle 一个 config 快照"。当前 `main.ts:51` 的
`client()` 每次新建实例、`inspectSyncState` 一次流程造两个 client
就是这个陷阱的前身 —— Phase 3A 的 cycle 必须持有**一个** client。

## 5.7 Disable / unload

```text
unload / disable 时：
1. stopped = true（第一时间置位）
2. 不再开始任何新 cycle
3. 取消 pending debounce（清 timer）与 pending backoff timer
4. 移除 Vault listeners —— 由 Plugin.registerEvent() 的自动 offref 完成
5. 如果一个 HTTP 请求已经在进行中（无法真正 abort）：
     允许它完成
     但禁止启动后续 operation / 后续 cycle
6. 允许【当前正在执行的那一条 operation】完成（不打断 mid-write）：
     理由：requestUrl 无法取消；而"半途放弃"只会让本地/远端状态更难推理。
     让一条已经在飞的 PUT 落地是【更安全】的选择 —— 它的结果要么被
     正常提交（在 unload 完成之前），要么变成 unresolved（下一轮 startup 自愈）。
```

关于第 6 点的精确边界（必须写清楚，否则实现时会含糊）：

```text
停止的最小单位是【operation 之间】，不是 operation 内部。
即：executor.execute(op) 一旦开始就让它跑完，
    但 cycle 的 operation 循环在下一条开始前检查 stopped 并中止。
```

结合现状：`onunload()` 目前只做 `this.activeAnalysis?.abort()`（`main.ts:48`）。
Phase 3A 必须在这里加上 `stopped = true` + 清 timer。
`abort()` 可以保留给 Inspect（它有自己的语义），但**不能**指望它中止 cycle。

## 5.8 Pause 是否需要

```text
当前用户原则：插件启用 = 同步运行。
```

**决定：Phase 3A 不需要 Pause。**

```text
NO
```

理由：

```text
1. 禁用插件本身就是 pause，而且是系统级、可预期、有 UI 的。
   再做一个插件内的 pause 会引入第二个"是否在同步"的真值来源 ——
   两个来源必然会在某个时刻不一致（例如 pause 期间用户改了文件，
   resume 后要不要补同步？补多少？）。
2. Pause 会立刻带出"pause 期间积累的 dirty 怎么办"这个新问题，
   而它的正确答案（"resume 后跑一轮 full reconciliation"）
   其实就是现有语义，pause 没有增加任何能力。
3. Phase 3A 的目标是"最小、安全、可实现"。Pause 是维护期需求，
   等真实出现"我需要暂时停一下但不能禁用插件"的场景再做。
```

唯一的近似物是 `blocked-by-auth`，但它是**错误状态**，不是用户功能：
用户无法主动进入它，也无法用它来"暂停同步"。

---

## 第六部分 启动、焦点与未来接口

## 6.1 Startup

```text
plugin onload
↓
workspace/layout ready（this.app.workspace.onLayoutReady）
↓
注册 Vault listeners        ← 必须在 onLayoutReady 之后，见下
↓
把 startup 视为【global dirty】
↓
requestReconcile("startup")  → 1200 ms debounce
↓
第一轮 cycle
```

回答四个问题：

```text
是否立即运行？     不是"立即"，是 layout ready 之后 + 1200 ms。
是否 debounce？    是（1200 ms）。
是否等待 Vault ready？是 —— 必须等 onLayoutReady。
是否只运行一次？   是 —— 只是启动时的那一次；之后由事件驱动。
```

**为什么必须等 `onLayoutReady`：**

```text
obsidian.d.ts:7552-7554 明确写着：
  vault.on('create') 在 vault 首次加载时会为每个已存在文件各触发一次，
  若不想收到加载期的 create 事件，应在 Workspace.onLayoutReady 里注册事件处理器。

如果在 onload 里注册，启动瞬间会有 N 个 create 事件（N = Vault 文件数）
一次性把 DirtySet 灌满 —— 语义上无害（全局 dirty 本来就要跑一轮），
但它把"startup"和"local-event"两个原因混在一起，
而且会让第一次 cycle 的 reason 变得不可解释。
```

**为什么把 startup 表达为 "global dirty" 而不是伪造所有 key 的 modify 事件：**

```text
1. 伪造事件意味着伪造的 key 集合 —— 而那个集合并不存在
   （还没 scan，不知道有哪些 key）。这会把"我需要跑一轮"这个纯粹的
   意图，扭曲成"这些具体 key 脏了"，而后者是错的（它们可能一个都没变）。
2. global dirty 的语义是"我的全部观测都不可信，重扫"，
   这正是 startup 的真实含义。
3. 它天然覆盖"插件被禁用期间磁盘上发生的变化"。
```

### 6.2 首次启动 / 没有 previous state

**必须回答：没有 previous state 时，哪些 operation 可以被自动执行？**

逐条对照 planner（§1.2），答案是**全部安全，不需要特殊例外**：

| 情况（previous 缺失） | planner 结论 | Phase 3A 行为 |
| --- | --- | --- |
| local 有 & remote 无 | `upload` (If-None-Match: `*`) | ✅ 自动执行 —— 新文件上传，不可能覆盖任何东西 |
| local 无 & remote 有 | `download` (If-Match: etag) | ✅ 自动执行 —— 新文件下载，本地目标不存在 |
| local 有 & remote 有 | `conflict` "both-created-different" | ⛔ surface only —— **不猜、不覆盖、不比较后覆盖** |

```text
⇒ 「首次启动也允许自动执行 upload / download」是安全的，
   因为唯一危险的情况（两侧都有同名文件）被 planner 表达为 conflict，
   而 conflict 在 §4.4 里是【不执行】的。
```

**但 Phase 3A 第一版仍然决定：startup cycle 不执行 upload / download。**

```text
理由：
1. 与当前已收口的行为保持一致。今天 Inspect 是唯一的入口，
   而它【不执行任何写】。让"启用插件"这个动作第一次就产生写操作，
   会让 Phase 3A 的三个变化（自动触发 + 自动执行 + 删除仍阻断）同时上线，
   一旦有问题无法归因。
2. 现有的 bootstrap 机制（buildBootstrapResult + saveVerified）就是为
   "首次会话先建立基线"设计的。startup 直接跳过它，等于绕开一个
   已经验证过的、更保守的路径。
3. "先看清，再动手"是这个插件的产品原则（README 第一段）。
   首次启动应该是"看清"的时刻。
```

**startup 第一轮 cycle 的确切语义（V1）：**

```text
scan local / scan remote / load previous / plan
↓
记录诊断（plan 的各类型计数）
↓
【不执行】任何 operation
↓
状态栏：
   有 conflict        → "! conflicts"（并把 conflict 计数放进 diagnostics）
   只有 upload/download → "○ error"? 不 —— 用一个明确的"需要人工建立基线"状态
                        （建议 "! baseline" 或复用 "✓ idle" + 诊断计数）
                        ← 具体文案是实现细节，语义是"有一批操作等待首次确认"
   全部 noop          → "✓ synced"
```

**这条"首次会话不自动执行"的规则如何解除**（必须在文档里明确，否则实现时会变成永久禁令）：

```text
条件：previous state 非空（即 IndexedDB 里存在至少一条通过
      identity/ignorePolicy 过滤的 baseline 条目）
⇒ 从那一刻起，后续 cycle 正常执行 upload / download。
```

也就是说，解除条件不是"运行了几轮"，也不是"用户点了什么"，
而是**"本 namespace 已经有可信基线"**这个客观事实。

**这与"startup = global dirty"并不冲突**：startup 依然是一轮
full reconciliation，只是这一轮在"无基线"时的执行策略是"只观察"。

**明确禁止：**

```text
MUST NOT: 因为"要自动同步"而改变 first-sync 的保守语义
MUST NOT: 在两侧都有文件且无 baseline 时自动挑选一方（无论按 mtime、size 还是内容）
MUST NOT: 自动调用 buildBootstrapResult 建立基线 —— 那需要读内容 + 哈希，
          属于 Inspect 路径的职责，且它有自己的并发与信号语义
```

> 既知技术项 b（`development.md`）："模糊结果的自愈：ambiguous PUT / state 提交失败后，
> 下一轮可以通过远端内容与本地一致的哈希比对重新收敛 baseline。
> 该能力已在 buildBootstrapResult 中存在，目前只接在 Inspect 路径上。"
> **Phase 3A 不接入它。** 接入它意味着 cycle 里要跑内容哈希（读文件 + 读远端），
> 那是另一个阶段的性能与语义决策。Phase 3A 的自愈是"下一轮 full scan → noop"，不是哈希收敛。

## 6.3 Focus / resume

区分两种情况：

```text
Desktop app focus      窗口重新获得焦点。触发【非常频繁】（alt-tab 一次就一次）。
Mobile app resume      应用从后台回到前台。触发频率低，但【信息量极高】。
```

**为什么这件事重要：**

```text
Phase 3A 没有 remote push / pulse / 持续 polling。
因此"另一台设备已经写了 R2"这件事，在本地是【完全不可见】的，
除非我们主动去 LIST 一次。
focus / resume 是目前唯一一个"用户回来了，值得再看一眼远端"的自然信号。
```

**决定：Phase 3A 让 focus / resume 触发 reconciliation，但带最小间隔。**

```text
触发条件：visibilitychange → visible（两端通用；桌面 focus 亦可用
          app.workspace.on('active-leaf-change')? 不 —— 那个语义是切换笔记，
          与"应用获得焦点"无关，不要用它）
debounce：800 ms
最小间隔：两次 focus/resume 触发的 cycle 之间至少 30 s
          （若上一轮 cycle 在 30 s 内结束过，则本次触发只 version++，
            不启动 debounce，直到 interval 满足）
```

理由与成本：

```text
成本：桌面端每次 focus 都多一次 LIST。用 30 s 最小间隔把
      "频繁 alt-tab" 压成"最多每 30 s 一次"。
      注意：即使触发了 debounce，dirty 与 single-flight 仍然生效 ——
      短时间内的多次 focus 会 coalesce；正在跑的 cycle 不会被叠加。
收益：手机从后台回来的那一刻，能立刻发现另一台设备刚写的东西。
      这是"跨设备"这个产品目标里【当前唯一可用的发现入口】。
```

**为什么不做成"只属于未来 Phase 4 remote watch"：**

```text
1. Phase 4 的 remote pulse 解决的是"不用用户操作也能发现远端变化"。
   focus/resume 解决的是"用户已经回来了，此时值得确认一次"。
   前者是持续的、后者是一次性的 —— 它们不是同一件事的早期版本，
   而是互补的两个入口。
2. 代价极小：一次 LIST。而收益是"从手机切回 Obsidian 就能看到
   电脑上刚写的内容" —— 这是产品核心体验里最容易感知的一块。
3. 它完全不需要改状态机：只是多一个 requestReconcile("focus-resume") 的调用点。
```

**明确的边界：**

```text
MUST NOT: 在"不可见 / 后台"状态下跑 cycle
          （后台跑没有意义：用户看不到结果；移动端还可能被系统限制）
MUST NOT: 用一个高频 timer 去检查可见性
MUST: visibilitychange 的原生事件（或 Obsidian 的等价事件）是唯一入口
MUST NOT: 把 focus/resume 当作"绕过最小间隔"的借口
```

## 6.4 Remote polling（明确禁止）

Phase 3A **不实现**持续 remote polling。明确禁止：

```text
每 3 秒 LIST R2
每 5 秒 HEAD
background timer
pulse object
```

这些属于后续：

```text
Phase 4 — remote pulse / adaptive watch
```

**但 scheduler 必须预留接口**：

```text
remoteDirty signal
```

未来的 pulse 变化只需要：

```text
requestReconcile("remote-change")
```

不需要改状态机。

**为什么现在就要预留**：因为"预留"在这里的准确含义是
**`requestReconcile(reason)` 必须是唯一入口，且 reason 必须是可扩展的联合类型**。
只要做到这一点，Phase 4 接入 pulse 就是新增一个调用点，
不需要碰 single-flight、debounce、dirty 或结果处理中的任何一条语义。
反之，如果 Phase 3A 出现了"只有本地事件才能触发 cycle"的隐含假设
（例如在 event handler 里直接 `void runCycle()` 而绕过 requestReconcile），
Phase 4 就要重写调度层。

**Phase 3A 里 "remote-change" 这个 reason 是否存在？**

```text
存在，但【没有生产调用点】。它是为 Phase 4 预留的类型成员。
唯一允许在当前代码里被使用的地方是类型定义本身。
MUST NOT: 为了"验证这个 hook 可用"而伪造一个 remote-change 触发。
```

## 6.5 Network failure

设计目标：不要构建复杂 retry framework。

场景与处理：

| 场景 | 现象 | 分类 | 处理 |
| --- | --- | --- | --- |
| offline / DNS / TLS / socket | `RemoteTransportError` | unresolved | backoff 5 s → 60 s |
| temporary 5xx | `RemoteHttpError(5xx)` | unresolved | 同上 |
| 429 | `RemoteHttpError(429)` | unresolved | 同上 |
| 401 / 403 | `RemoteHttpError(401/403)` | failed → **auth** | blocked-by-auth（§5.5） |
| 其他 4xx | `RemoteHttpError(4xx)` | failed | backoff 15 s → 5 min |

**Phase 3A 第一版最保守方案（推荐）：**

```text
failed / unresolved cycle
↓
limited backoff（§5.4 的参数）
↓
retry（经由 requestReconcile("retry")，走正常状态机）
```

同时保留一条**逃生路径**（不需要额外机制，因为它天然存在）：

```text
任何新的本地事件 / focus / resume / config-change
都会立刻 requestReconcile，并【清掉】正在等待的 backoff timer
（理由：那些信号说明"输入确实变了"，而 backoff 的前提是"输入没变"）。
```

明确写下来的参数（避免实现时再决定）：

```text
initial delay      unresolved 5 s / failed 15 s
max delay          unresolved 60 s / failed 5 min
倍数               ×2
reset condition    一次 cycle 结束时该类计数为 0
```

**不做的事：**

```text
MUST NOT: 指数退避 + jitter + 多次重试队列 + 熔断器
MUST NOT: 对不同 key 做不同的退避（backoff 是 cycle 级的，不是 key 级的）
MUST NOT: 把 offline 检测做成主动探测（不做 ping、不做 HEAD 探测）
```

**一个必须承认的确定性问题**：在持续离线的环境下，最终稳定形态是
"每 60 s 一次失败的 LIST"。这是**有意**的（它保证网络恢复后最多 60 s 内自动收敛），
而不是缺陷。如果用户在意这 60 s 一次的失败请求，禁用插件是唯一手段（§5.8）。

## 6.6 未来接口预留（不改状态机）

未来只需要新增**调用点**，不新增语义：

```text
Phase 4 remote pulse        → requestReconcile("remote-change")
未来多 Vault / 多 namespace  → requestReconcile("config-change")（已存在）
未来 conflict merge UI       → 解开 conflict 之后 requestReconcile("local-event")? 
                              不需要：用户操作本身会产生 Vault 事件
未来 key-scoped scan         → 改 §3.5，属于独立阶段，不改状态机
```

---

## 第七部分 时序案例（14 个）

以下 timeline 中，`v` 表示全局 dirty version，`dirty` 表示 dirty map。

### Case 1 — 普通编辑

```text
t=0ms     modify a.md        v=1  dirty={a.md:1}  timer→1320ms
t=200ms   modify a.md        v=2  dirty={a.md:2}  timer→1400ms
t=430ms   modify a.md        v=3  dirty={a.md:3}  timer→1630ms
t=900ms   modify a.md        v=4  dirty={a.md:4}  timer→2100ms
t=2100ms  debounce elapsed → running（startVersion=4）
t=2300ms  scan local（a.md 的新 size/mtime）
          scan remote（a.md 的旧 ETag）
          previous（a.md 的旧 baseline）
          plan → upload a.md（If-Match: 旧 ETag）
          executor → PUT 2xx + ETag → applied
          previous.commit(a.md)（executor 内部，per-key）
t=2500ms  cycle end：v 仍为 4（无新事件）→ dirty.clear() → idle
状态栏：↻ syncing → ✓ synced   （用户 4 次击键只产生 1 次上传）
```

### Case 2 — 编辑过程中开始同步

```text
t=0       modify a.md              v=1
t=1200    debounce elapsed → running（startVersion=1）
t=1250    scan local → 记录 a.md 的 stat（内容 A）
t=1300    scan remote（await，LIST）
t=1400    user creates b.md        v=2  dirty={a.md:1, b.md:2}   ← 只在跑，不动 timer
t=1500    plan → 【只有 a.md 的 upload】（b.md 不在本轮 local 观测里）
t=1600    executor: readStableLocalBytes(a.md) 复查 stat
          → 如果用户在 1250 之后还改过 a.md → LocalFileChangedError
          → stale(local-changed)                       ← 前置条件保护生效
          如果没改过 → PUT a.md → applied
t=1700    cycle end：v(2) > startVersion(1) → 不清 b.md → rerun-pending
          启动 trailing debounce → 2900ms
t=2900    running（startVersion=2）
t=3100    scan local → 看到 a.md（新 baseline，noop）+ b.md（新文件）
          plan → upload b.md（If-None-Match: *）
          executor → applied
t=3300    cycle end：v 未变 → dirty.clear() → idle
```

**这一例子证明两件事**：(a) b.md 的变化**没有丢**（Case 14 的核心）；
(b) a.md 被用户在 scan 之后改动时，**executor 的本地前置条件**（不是 scheduler）
把它变成 stale，而不是让一个过期的 operation 覆盖掉用户的新内容。

### Case 3 — 下载产生 Vault modify event

```text
远端 a.md 被另一设备改动（ETag A → B）
本地 a.md 未变（baseline 指向 A）
↓
（触发来自 startup / focus / 本地事件 / 未来的 remote pulse）
running（startVersion=N）
scan local  → a.md @ (size, mtime_A)
scan remote → a.md @ ETag B
previous    → a.md @ { local:(size,mtime_A), remote:{etag:A} }
plan        → download a.md（If-Match: B）
executor:
  检查本地前置条件 ✅
  GET If-Match: B → 200 + bytes
  再检查本地前置条件 ✅
  vault.modifyBinary(file, bytes)
  ↓
  【Obsidian emits 'modify' a.md】
  → scheduler: v++，dirty.set("a.md")          ← 见 §3.8 方案 A
  executor: adapter.stat(a.md) → commit baseline { size, mtime_new }
cycle end：
  v 前进了 → 不清 a.md → rerun-pending → debounce 1200ms
↓
第二轮 running（startVersion=N+1）
scan local  → a.md @ (size, mtime_new)
scan remote → a.md @ ETag B
previous    → a.md @ { local:(size,mtime_new), remote:{etag:B} }
plan        → noop a.md
cycle end：v 未变 → dirty.clear() → idle
状态栏：↻ syncing → ✓ synced
```

**明确选择：接受这一轮额外的 noop cycle（方案 A，不抑制）。** 代价 = 1 次 LIST。
收益 = 不会因为抑制窗口误吞用户的真实修改（§3.8），
且它顺带是 ambiguous-put / state-commit-failed 的自愈路径。

### Case 4 — sync running 时另一文件变化

```text
t=0     sync running（处理 a.md 的 upload）
t=100   user modify b.md    v++  dirty.set("b.md")
t=200   user modify b.md    v++  dirty.set("b.md")
t=800   a.md applied，cycle end
        → 检测到 v 前进 → rerun-pending → debounce 1200ms
t=2000  running（startVersion = 最新 v）
        → scan 看到 a.md 已同步（noop）、b.md 已变化（upload）
t=2300  b.md applied → cycle end → v 未变 → idle
```

```text
绝不会：a.md 与 b.md 被两轮 cycle 并发处理
绝不会：b.md 的两个事件产生两轮 cycle
```

### Case 5 — remote stale

```text
running（startVersion=N）
scan remote → a.md @ ETag A
plan        → upload a.md（If-Match: A）
            ↓
        另一设备把远端 A → B
            ↓
executor: PUT If-Match: A → 412 → RemoteObjectChangedError
        → stale(remote-changed)
        → 不提交 state、不覆盖 B
cycle end：
  stale 存在 → 【0 ms immediate rerun】（§4.3）
  不清 dirty（version 前进了）→ rerun-pending
↓
第二轮：scan remote → a.md @ ETag B
        previous → { local:(本地版), remote:{etag:A} }
        local 变了（相对 baseline? 取决于本地是否变过）
        → 若本地未变、远端变了 → download a.md（If-Match: B）→ applied
        → 若两侧都变          → conflict "both-modified" → surface only
```

**stale 是否必然触发 rerun？**

```text
是。stale 是本设计中唯一走 0 ms 立即重跑的本地结果。
理由见 §4.3：它证明"输入真的变了"，因此不适用"只等新事件"的抑制逻辑。
```

### Case 6 — conflict

```text
running（startVersion=N）
plan：
  a.md → conflict "both-modified"
  b.md → upload   (本地新增)
  c.md → download (远端新增)
执行：
  a.md 不送 executor → 计入 conflict，保持未解决
  b.md → PUT → applied
  c.md → GET + 写盘 → applied
cycle end：
  conflict 存在 → 【不重跑】
  v 未变（假设）→ dirty.clear() → idle
状态栏：! conflicts
```

```text
b.md 与 c.md 正常收敛 —— 这就是 §4.4 的"其他 key 继续执行"。
a.md 保持 conflict，直到用户改动它 / 远端改动它 / config 变化
（任何一种都会产生新的 dirty 信号）。
```

### Case 7 — blocked delete

```text
previous 里有 old.md；本地已删除 old.md；远端未变（仍有 old.md）
plan → delete-remote old.md
executor.execute → blocked "deletion-not-supported-in-phase-2a"
cycle end：
  blocked 存在 → 【不重跑】
  v 未变 → dirty.clear() → idle
下一轮何时发生？只有当外部发生真实触发时（用户又改了别的文件 / startup / focus）。
又一轮 → 仍然是 blocked → 仍然不重跑。
```

```text
这就是"不能因 blocked 无限 rerun"的落地方式：
blocked 被【明确排除】在自动 rerun 之外。
代价：old.md 的远端对象一直留着（Phase 3A 本来就不删除）。
```

### Case 8 — ambiguous PUT

```text
plan → upload a.md（If-Match: A）
executor: PUT 已送到 R2（对象可能已经变成 B），但响应没有回来
        → RemoteTransportError → unresolved "ambiguous-put"
        → 不提交 state
cycle end：
  unresolved 存在 → rerun with backoff
  backoff(unresolved) → 5000ms → requestReconcile("retry")
↓
t+5000ms：running
  scan local  → a.md 未变（本地还是那份内容）
  scan remote → a.md @ ETag B（如果 PUT 真的落盘了）/ @ A（如果没落盘）
  previous    → a.md @ { local:…, remote:{etag:A} }
  plan：
    远端变成 B → remote 变了、local 没变 → download（把 B 拉回来）→ applied
    远端仍是 A → local 变了、remote 没变 → upload（重试）→ applied
cycle end：unresolved 计数为 0 → backoff 重置
```

**是否 immediate rerun？** 不。

```text
明确的决定：unresolved 走 backoff（5 s），不走 0 ms。
理由：unresolved 的常见成因是传输层中断（断网、原生桥接失败），
      立刻重跑有很高概率再得到一次 unresolved，形成紧密 loop。
      5 s 的延迟对"内容最终收敛"没有任何影响，而它足以让一次瞬时抖动过去。
```

### Case 9 — app startup

```text
插件 onload
  → settings 加载
  → 命令注册 / 设置页 / 状态栏（"✓ idle"）
  → 【不注册 Vault listeners】（避免加载期 N 个 create 事件）
  → workspace.onLayoutReady(() => { 注册 listeners; requestReconcile("startup"); })
↓
+1200ms（debounce）
running（reason="startup"）
  scan local / scan remote / load previous / plan
  ↓
  previous 为空（首次会话）→ 【不执行任何 operation】，只记录诊断
  previous 非空            → 正常执行（§6.2 的解除条件）
cycle end → 按结果决定 idle / rerun / backoff / blocked-by-auth
```

### Case 10 — mobile resume

```text
前台 → 后台（visibilitychange → hidden）
  （不做任何事：不跑 cycle、不注册 timer）
其他设备写入 R2（本地完全不可见 —— 没有 pulse、没有 polling）
后台 → 前台（visibilitychange → visible）
  → 最小间隔检查：距上次 focus/resume cycle ≥ 30 s？
      否 → 只 v++，不启动 debounce
      是 → requestReconcile("focus-resume") → 800ms debounce
↓
running → scan remote → 发现远端新 ETag
  → plan → download（或 upload，取决于本地是否也变了）
  → applied → 状态栏 ✓ synced
```

```text
这是 Phase 3A 里【唯一】能发现"另一台设备写了 R2"的机制。
它不需要改状态机（只是一个 requestReconcile("focus-resume") 调用点），
也不违反"不做持续 polling"的边界。
```

### Case 11 — configuration change mid-cycle

```text
t=0     running（configGeneration=7，捕获了 {endpoint_old, bucket_old, prefix_old,
                                              accessKeyId_old, ignorePolicy_old}）
t=300   用户改 remote prefix → saveSettings()
        → configGeneration=8
        → 清 pending debounce
        → 【不尝试取消当前 cycle】
t=800   旧 cycle 继续跑（用旧 client、旧 identity、旧 filter）
        → 它的 upload 写的是【旧 namespace】
        → 它的 previous.commit 带 remoteIdentity_old
t=1200  旧 cycle 结束：
        capturedGeneration(7) ≠ currentGeneration(8)
        → 丢弃结果（不进 lastResultCounts）
        → 提交过的 baseline 带 remoteIdentity_old
          → 下一次 loadAll 的过滤会让它们失效（main.ts:85 的同一套过滤）
        → requestReconcile("config-change") → 400ms debounce
t=1600  running（configGeneration=8，新 client、新 identity、新 filter）
        → previous 里旧 identity 的条目已被过滤掉
        → planner 把新 namespace 当作"没有 previous"
        → 又见 §6.2 的 first-sync 保守语义（如果新 namespace 没有 baseline）
```

```text
关键点：旧 cycle 的写入落在旧 namespace（它观测过的那个），
        它【不可能】污染新 namespace 的 state —— 因为 state 条目自带 identity 字段。
```

### Case 12 — plugin unload mid-cycle

```text
running：
  operation 1（a.md upload）已提交 baseline
  operation 2（b.md upload）正在进行中：PUT 已发出，尚未返回
↓
用户禁用插件 → onunload()
  → stopped = true
  → 清 pending debounce / backoff timer
  → registerEvent 的 EventRef 自动 offref（listeners 移除）
  → 【不打断 operation 2】
↓
operation 2 的 PUT 返回：
  2xx → executor 提交 baseline（如果 IndexedDB 仍然可达）→ applied
  失败 / 无响应 → unresolved（不提交）
  但【无论结果如何】，cycle 的 operation 循环在下一步前看到 stopped → 中止
  → 不会再启动 operation 3
↓
下次启用插件 → onload → startup cycle
  → 如果 operation 2 的 PUT 落盘了但 baseline 没提交：
      scan remote 看到对象存在、previous 里没有它
      → 与本地内容比较 → 见 §6.2（无 baseline 且两侧都有 → conflict）
      ← 这是已知的、保守的收敛行为，不会误删也不会覆盖
```

### Case 13 — 100-file burst

```text
t=0      git checkout → 100 个事件在 ~200ms 内到达
         v=1..100，dirty 收敛到 ~100 个 key，唯一 timer 被重置 100 次
t=200    最后一个事件 → timer→1400ms
t=1400   running（startVersion=100）
         scan local（100 个新 size/mtime）
         scan remote（1 次或少数几次 LIST）
         plan → 100 个 operation（按 key 升序）
         executor 顺序执行 100 条（每条一个 PUT，每条一个 per-key commit）
t=…      cycle end：
           v 未变（用户在批量操作后没再动）→ dirty.clear() → idle
```

```text
总轮数 = 1。绝不会 100 个 cycle。

如果用户在 executor 跑第 37 条时又改了别的文件：
  v++ → cycle end 时 v > startVersion → rerun-pending → 第二轮处理剩余变化。
  第二轮也会重新 scan 全部 100+1 个 key —— 第 1..36 条已经是 noop，
  第 37..100 条依赖它们各自的 ETag 前置条件，而 baseline 已经提交，
  所以它们会被 planner 重新判定（noop 或 upload）。
```

### Case 14 — cycle 结束瞬间又来事件（**证明不会丢事件**）

这是必须证明的案例。关键在于 **clear 的 version 语义**（§3.3）。

```text
t=0      running（startVersion = 42）
t=100    executor 完成最后一条 operation
t=110    ★ user modify c.md
           → 事件 handler 执行：v 42→43，dirty.set("c.md", 43)
t=120    cycle 的收尾代码开始执行：
           if (v === startVersion)  → 43 !== 42 → 不清空
           清除 dirty 中 version <= 42 的项：
             { "a.md" → 41, "c.md" → 43 }
           → { "c.md" → 43 }               ← a.md 被清、c.md 存活
           → rerun-pending → debounce
t=1320   第二轮 running → scan 看到 c.md 的新内容 → upload → applied
```

**反例（错误实现）**：

```text
t=120    cycle 收尾：dirty.clear()          ← 无条件清空
t=1320   （没有 rerun，因为没有 dirty）
         c.md 的修改要等到下一个随机事件才被发现 —— 【事件被吞了】
```

**为什么"事件在 cycle 收尾之后到达"也安全**：

```text
t=120    cycle 收尾：v === startVersion(42) → dirty.clear() → idle
t=121    ★ event：v 43，dirty.set("c.md", 43) → 正常 requestReconcile
         → debounce → 新一轮
```

```text
⇒ 无论事件落在"收尾之前"还是"收尾之后"，都不会丢。
   唯一会丢的实现是"无条件 clear"，而那正是必须被禁止的写法。
```

**实现层面必须遵守的一条（否则 version 语义会被绕过）**：

```text
MUST: "比较 version" 与 "清除 dirty 中 <= startVersion 的项" 必须在
      同一个同步块内完成，两者之间不得有 await。
      （否则事件可能插在两者之间，而这个插入【恰好】是安全的 —— 
        因为 version 已经前进、不会被本次 clear 影响 —— 
        但把两个动作放在同一个同步块里可以让这件事不需要依赖推理。）
```

---

## 第八部分 明确不解决什么（非目标）

Phase 3A **不解决、不实现、不设计**：

```text
remote pulse / pulse object
continuous remote polling（LIST / HEAD 定时轮询）
Queue / job queue / 持久化待办
Gateway / Cloudflare Worker / Durable Object
temporary credentials / STS / 临时凭据端点
WebSocket / 长连接
LiveRoom / 多人协作
AI streaming
delete semantics（删除语义、回收站、墓碑、tombstone）
rename inference（重命名推断）
conflict merge（冲突合并 / 保留两边 / diff UI）
multipart upload（大文件分片）
multi-writer collaborative editing
key-scoped / partial reconciliation
self-write suppression
Pause / Resume UI
Sync Now / Push Now / Pull Now / Retry Now
从 scheduler 接入 buildBootstrapResult 的内容哈希自愈
把 conflict 变成可执行的 operation
把 blocked delete 变成可执行的 operation
telemetry / 上报 / 远端日志
```

另外三条**边界声明**（不是功能，是限制）：

```text
1. 纯外部（非 Obsidian）修改可能不被事件覆盖，最长要等到
   startup / focus / resume 才被发现（§3.6.4）。
2. 在持续离线环境下，最终稳定形态是"最多每 60 s 一次失败的 LIST"（§6.5）。
3. 重命名会在 R2 留下孤儿对象，且孤儿对象不会被自动清理（§3.3）。
```

---

## 第九部分 推荐的第一版 Scheduler（V1）

```text
Sources（触发源）：
  - startup          （onLayoutReady 之后，reason="startup"）
  - local Vault file events（create/modify/delete/rename，onLayoutReady 之后注册）
  - focus / resume   （visibilitychange → visible，≥30 s 最小间隔）
  - future remoteDirty hook（requestReconcile("remote-change")，Phase 4 接入，现在无调用点）

Mechanism（机制）：
  - global dirty version（单调递增）
  - dirty: Map<canonicalKey, version>     ← coalescing hint，不是事实库
  - 唯一入口 requestReconcile(reason)
  - global trailing debounce：local 1200ms / startup 1200ms / focus-resume 800ms /
                              config-change 400ms / rerun 1200ms / stale 0ms
  - single-flight：任意时刻至多一个 cycle
  - full scan / replan 每一轮（不做 key-scoped）
  - cycle 期间的事件累积为 dirty，cycle 结束后按 version 判定是否 rerun
  - clear 只清 <= startVersion 的项
  - SafeExecutor 是唯一写入者；scheduler 不写 Vault、不写 R2、不发 LIST 以外的远端请求
  - delete 全程 BLOCKED（不补能力、不绕过）
  - 结果处理：applied 继续 / stale 立即 rerun / unresolved backoff 5s→60s /
              failed backoff 15s→5m / blocked 只等新事件 / conflict 只等新事件
  - 认证失败 → blocked-by-auth（不注册 retry timer）
  - config change → generation++，旧 cycle 跑完但结果丢弃，随后强制新一轮
  - unload → stopped=true，清 timer，移除 listeners，允许飞行中的 operation 完成，
             但不再启动后续 operation 与 cycle
  - 状态栏只读、不触发同步；无 Sync Now；“首次会话无 baseline”时 startup 只观察不执行
```

相对于提示词里建议形状的**三处主动偏离**（审计后决定）：

```text
1. rerun 采用"cycle 结束后再 debounce 一次"，而不是"结束后立即重跑"。
   理由：100 文件 burst 下"立即"会让排队深度等于事件数（§3.2）。

2. stale 采用 0 ms 立即重跑，与 unresolved / failed 的 backoff 分开。
   理由：stale 证明输入真的变了，不适用"只等新事件"的抑制逻辑（§4.3）。

3. startup 在"没有可信 baseline"时【不执行】任何 operation。
   这是唯一一条"比提示词更保守"的偏离，理由见 §6.2
   （三个变化同时上线无法归因 + bootstrap 机制已存在且已验证）。
```

---

## 第十部分 Implementation contract（MUST / MUST NOT）

### MUST

```text
1.  MUST 保证任意时刻最多只有一个 reconciliation cycle 在运行。
2.  MUST 把 Vault event 只翻译成 dirty 标记 + "跑一轮"的请求；
        绝不翻译成 upload / download / delete / conflict / noop。
3.  MUST 每一轮 cycle 都重新 scan local + scan remote + load previous + 由 planner 决策。
4.  MUST 在 stale 之后重新 scan / 重新 plan；绝不重试旧 operation、绝不移除条件。
5.  MUST 保留运行期间到达的事件（version 化 clear：只清 <= startVersion 的项）。
6.  MUST 允许与 conflict 无关的其他 key 正常收敛（单 key 结果不得中止整轮 cycle）。
7.  MUST 保持 delete-local / delete-remote 为 BLOCKED，且不绕过 SafeExecutor 补删除能力。
8.  MUST 让 SafeExecutor 成为唯一写入者（Vault 内容写入 + R2 写入）。
9.  MUST 让每个 cycle 持有冻结的 config 快照（endpoint/bucket/prefix/ignorePolicy/
        accessKeyId/configGeneration）与单一 client 实例。
10. MUST 对 unresolved 与 failed 使用有限退避（5s→60s / 15s→5m，×2，计数归零重置）。
11. MUST 在认证失败（401/403）时进入 blocked-by-auth 并停止自动重试（不注册 timer）。
12. MUST 让 blocked 与 conflict 只等待新的外部触发，不自动 rerun。
13. MUST 在 dispose/unload 时：置 stopped、清 timer、移除 listeners；
        允许飞行中的 operation 完成，但不再启动后续 operation 与 cycle。
14. MUST 把"仍有 pending dirty"作为 cycle 结束后 rerun 的判定依据（而不是"上一轮有没有操作"）。
15. MUST 在 cycle 的每个写入步骤之前确认代际 / stopped / config 仍然有效。
16. MUST 让状态栏保持只读（无点击处理器、不触发同步）。
17. MUST 让所有路径过滤复用 createVaultPathFilter 与 ignorePolicyFingerprint。
18. MUST 复用 existing 的脱敏策略记录错误，绝不记录凭据、签名头、文件正文。
19. MUST 在 onLayoutReady 之后才注册 Vault listeners。
20. MUST 让 startup 在没有可信 baseline 时只观察、不执行任何 operation。
21. MUST 保持 operation 顺序 = planner 的 deterministic 顺序，逐条顺序执行。
22. MUST 让一轮 cycle 被理解为 optimistic reconciliation attempt（不是事务、不是快照）。
```

### MUST NOT

```text
1.  MUST NOT 缓存 SyncPlan 到下一轮；cycle 结束即丢弃。
2.  MUST NOT 在 stale 之后使用无条件写（绝不去掉 If-Match / If-None-Match）。
3.  MUST NOT 从状态栏触发同步。
4.  MUST NOT 新增 Sync Now / Push Now / Pull Now / Retry Now。
5.  MUST NOT 在 blocked / conflict / failed / unresolved 上忙循环（busy-loop）。
6.  MUST NOT 让 Vault event 直接产生 operation（绕过 planner）。
7.  MUST NOT 实现 key-scoped / partial reconciliation。
8.  MUST NOT 实现 self-write suppression（时间窗 / 标记 / generation 抑制）。
9.  MUST NOT 实现删除语义（DELETE / vault.delete / adapter.remove / 墓碑）。
10. MUST NOT 实现 rename inference。
11. MUST NOT 实现持续 remote polling / 后台 timer / pulse object / WebSocket。
12. MUST NOT 在 cycle 运行中途重新读取 settings 并切换 identity。
13. MUST NOT 实现 Pause / Resume UI。
14. MUST NOT 让 Inspect Sync State / Test Connection 调用 scheduler 或触发同步。
15. MUST NOT 把 noop / conflict 送进 SafeExecutor 当作可执行操作。
16. MUST NOT 因为"更快"而扩大 Phase 3A 范围（不做 multipart、不做并行、不做优先级队列）。
17. MUST NOT 在启动的第一轮（无 baseline 时）自动执行 upload / download。
18. MUST NOT 在两侧都有文件且无 baseline 时自动挑选一方（按 mtime / size / 内容都不行）。
19. MUST NOT 让 cycle 里跑内容哈希（不接 buildBootstrapResult 到执行路径）。
20. MUST NOT 把 blocked delete 变成自动清理远端孤儿对象的借口。
21. MUST NOT 记录文件正文、credentials、signed headers 到日志或诊断。
22. MUST NOT 在不可见 / 后台状态下跑 cycle。
```

---

## 第十一部分 Open questions

以下问题**确实**无法只凭现有架构决定，需要在 Phase 3A 实现或真机验证时回答。
它们都不影响第一至第十部分的语义（那些已经是决定）。

1. **`delete` 事件无法区分文件与文件夹（§3.6.1）。**
   语义已经定死（"宁可信其是文件"），但**具体判定手段**未定：
   `instanceof TFolder` 在 Obsidian 的实际运行环境里是否可靠（插件与 Obsidian 是否
   共享同一份模块实例）？需要在真实 Obsidian 里做一次最小验证。
   在验证之前，实现应采用"默认按文件处理"的安全侧。

2. **`focus` 状态的观测手段。**
   语义已定（≥30 s 最小间隔 + visibilitychange），但 Obsidian 在桌面与移动端
   是否都可靠地触发 `document.visibilitychange`（而不是仅触发 Electron 的
   `browser-window-focus`）需要真机验证。若移动端不触发，需要另找等价入口 ——
   这会影响 Case 10 的可用性，但不影响其他任何语义。

3. **`blocked/missing-remote-etag` 的真实发生率。**
   语义已定（blocked、不自动 rerun、只等新事件）。但"LIST 返回的条目没有 ETag"
   在真实 R2 上到底会不会发生、什么时候发生，目前没有真机数据。
   如果它其实总会带 ETag，那么这条 blocked 就是死代码（无害）；
   如果它会出现，就需要在文档里把它变成一个用户可见的解释。

4. **持续离线时"每 60 s 一次失败 LIST"的实际体验。**
   参数（60 s 上限）是按"网络恢复后最多 60 s 内收敛"倒推的，
   但没有真机测量过移动端的耗电与系统限制（Android 后台/前台限制）。
   若实测认为过于频繁，需要调整的是 `max delay` 常数，**不是**语义。

5. **`vault.on('create')` 在 `onLayoutReady` 里注册是否真的能避免加载期事件洪泛。**
   typings 的注释（`obsidian.d.ts:7552-7554`）明确建议这么做，
   但"注册时机是否足够晚"需要在真实的大 Vault 上测一次
   （观测对象：第一轮 cycle 的 `lastCycleReason` 是否稳定为 `"startup"`，
   `pendingDirtyCount` 是否在第一轮之前就异常增长）。

6. **状态栏 owner 冲突的具体处理方式（§4.5）。**
   语义已定（scheduler 的真实状态优先），但 Inspect 结束后的具体文案与
   恢复时机是实现细节，需要在 Phase 3A 实现时定稿。

以上 6 条均为**实现细节或真机观测项**，其语义答案都已在第一至第十部分给出。

---

## Verdict

```text
Scheduler semantics ready for implementation: YES
```

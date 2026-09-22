# Phase 4C.5 — 删除安全与状态 GC（Deletion Safety & State GC）

本文档冻结 Phase 4C.5 的语义。它把过去被统称为"打开 delete"的**三个不同问题**拆开，并按依赖顺序排列。

审计基线：插件 `7254518`；本文档对应的实现提交见下方各阶段。

## 0. 为什么现在做

Phase 4C 已经证明 create/modify + Gateway 跨设备链路可用（真机三项双向验证全部通过）。
但同一次真机排查暴露了一个协议缺口：

```text
R2 里被外部删除的对象
  → 本地索引仍然记着 baseline
  → planner 得到 local/remote 状态与 previous 不一致
  → 产生无法收敛的 key
  → 状态栏永久显示 conflict
  → 只能手工清空整个 IndexedDB 才能恢复
```

实测证据（真实 Vault + 真实 R2）：

```text
R2 对象 404 · Windows 402 · Android 404
用户删除了 R2 里的 .mineral/ 与 private/
两端本地也都不存在这些文件夹
但本地 IndexedDB 仍保留 618 条 baseline（含这些 key）
```

`delete-local` / `delete-remote` 当时都是硬阻断的，所以这些 key 永远不会消失。
**这不是"以后再做的功能"，而是已经证明会让 cold sync 无法完全收敛的协议缺口。**

## 1. 三个不同问题（不要统称成"打开 delete"）

```text
问题 A  过期 baseline 清理        → 纯本地簿记，不碰任何用户数据
问题 B  远端删除传播到本地         → 会删除本地文件，必须有最后的前置条件
问题 C  本地删除传播到远端         → 会删除 R2 对象，必须能指名版本
```

对应阶段：

```text
Stage D1  Baseline GC                      ← 本阶段已实现
Stage D2  Safe delete-local                ← 本阶段已实现
Stage D3  Safe logical remote deletion     ← 本阶段只设计，不实现
Stage D4  Physical R2 garbage collection   ← 更晚，且独立
```

## 2. 冻结的 invariants

```text
1. both absent → previous GC
   local 无 && remote 无 && previous 有
   → 只删除 device-local 索引条目，绝不碰 Vault 文件或 R2 对象

2. delete-local
   MUST 在破坏性动作之前，立即重新验证本地版本

3. changed local target
   → stale / conflict，绝不删除

4. delete-remote
   MUST NOT 发出无条件 R2 DELETE

5. remote deletion 必须指名它要删除的**确切远端版本**

6. 并发发生的远端修改必须存活

7. deletion notification 仍然经过 RemoteChangeHub

8. tombstone / 内部 metadata 绝不作为普通 Vault 文件出现
```

## 3. Stage D1 — Baseline GC（已实现）

### 触发条件

```text
local  absent
remote absent
previous exists
```

三个条件必须同时由**完整**的本地扫描与**完整**的远端扫描证明。
如果任一侧的扫描失败或部分完成，本轮不产生 GC 候选（宁可不清理，也不误清理）。

### 语义

```text
增加一种纯本地状态操作：prune-baseline

planner:  !here && !there && previous 存在  → { type: "prune-baseline", key, reason }
executor: state.delete(key)                 → applied
          索引写失败                          → unresolved / state-commit-failed
```

它**不是**删除用户数据：

```text
不调用 vault.* 的任何删除
不调用任何 R2 写
不改变 local 文件
不改变 remote 对象
```

它只是承认"这条簿记描述的版本在两侧都不存在了"，于是把它忘掉。

### 为什么这是安全的

删的是 **device-local bookkeeping**，不是用户数据。最坏情况是：

```text
如果那个 key 的本机文件后来又出现（用户恢复、git checkout）
→ 它没有 baseline
→ planner 认为它是新文件
→ 重新上传
```

即最坏结果是"多一次上传"，不是"丢一个文件"。

### 为什么必须自动做，而不是手工清库

618 条历史 baseline 不应该要求用户删掉整个 IndexedDB（那会同时丢掉所有**仍然有效**的
baseline，反而让下一次同步变成全量重建）。GC 是按 key 精确的，只清理确实两边都不存在的。

## 4. Stage D2 — Safe delete-local（已实现）

### 触发条件（planner）

```text
previous:  local A, remote A
now:       local A unchanged, remote missing
→ delete-local { key, expectedLocal: A }
```

关键点是 `expectedLocal`：planner 必须把**做出删除决定时所依据的那个观测**交给 executor，
而不只是交一个 key。

### 执行流程（executor）

```text
1. 重新验证本地版本，就在破坏性动作之前
     adapter.stat(key) 与 expectedLocal 比较
     ├ 不匹配但文件已不存在 → 视为已完成 → 退休 baseline
     ├ 不匹配且文件仍存在   → stale / local-changed，绝不删除
     └ 匹配                 → 继续
2. 交给 VaultFileRemover.trash()
     Obsidian FileManager.trashFile（1.5+）或 Vault.trash（旧版）
     尊重用户"删除文件"偏好：系统回收站或 vault 内 .trash
3. 删除后复查文件确实消失
     └ 仍存在 → failed / trash-unavailable
4. 两侧都已不存在 → 退休 baseline（复用 D1 的语义）
```

### 为什么必须有最后的前置条件

```text
scan 看见 L1
↓
用户把它改成 L2
↓
executor 不能把 L2 删掉
```

这是 D2 唯一真正困难的部分。`expectedLocal` 让"被删除的那个文件"与"做出决定时的那个观测"
绑定在一起；版本一旦前进，操作就变成 `stale`，而不是删掉用户刚刚写下的内容。

这与 upload / download 使用的前置条件是**同一套机制**，没有引入第二种安全模型。

### recovery-first：为什么不是 permanent unlink

```text
MUST 优先使用可恢复的 trash 语义
MUST NOT 回退到硬删除
```

如果 trash 不可用（系统回收站被禁用、API 缺失、文件管理器不可用），结果是
**类型化的 failed**，文件留在原地，而不是"反正删不掉那就 unlink"。删除的收益
（少一个文件）远小于误删的代价，所以这条没有例外。

`VaultFileRemover` 是一个**只有 trash 能力**的窄接口：executor 拿不到 `Vault` 的
删除 API，因此它**在类型层面就无法**执行不可逆删除。

### 与 ignore policy 的关系

`.trash` 是内置忽略项之一，所以被 trash 的文件不会立刻被同步到 R2。
若用户把 trash 目标改到未被忽略的位置，那个文件会作为普通本地文件参与同步 —— 这是
用户可以自行配置的结果，不是插件的隐藏行为。

## 5. Stage D3 — Safe logical remote deletion（只设计，不实现）

### 为什么不能直接放开 R2 DELETE

R2 的 S3 兼容 API 为 `HeadObject` / `GetObject` / `PutObject` 提供 conditional operations，
但 **`DeleteObject` 没有条件形式**；R2 的一致性模型是并发 PUT/DELETE 时**最后完成的写者获胜**。

因此危险场景无法用前置条件挡住：

```text
scan:  remote a.md = ETag A
本地:  删除 a.md
同时另一台设备: A → B
本机:  DELETE a.md        ← 无条件，B 也会被删掉
```

这正是 `delete-remote` 一直硬阻断的原因，也是 D3 必须有**版本身份**的原因。

### Tombstone 协议（设计）

因为 **PUT 有条件形式**，可以把"删除"表达为一个**带版本的 tombstone 写入**，而不是 DELETE：

```text
本地删除 a.md
previous remote: a.md = ETag A
↓
写入 deletion intent（一个内部 metadata 对象）：
  path          = a.md
  baseRemoteEtag = A          ← "我要删的不是未来的任何一个 a.md，而是明确的版本 A"
```

`baseRemoteEtag` 是版本身份。它把一个无序的"删除"变成了一个**可比较**的事实。

### effective remote state

扫描不再只 LIST 文档，而是构造一个合成视图：

```text
LIST documents
+
LIST .minera-sync/tombstones/
↓
effective remote state

object    a.md = A,  tombstone(a.md, base=A)  →  effective: deleted
object    a.md = B,  tombstone(a.md, base=A)  →  base 不匹配 → delete/modify conflict
object    a.md = A,  无 tombstone             →  effective: A
```

于是：

```text
另一设备已经 A → B 时，本机的 tombstone(base=A) 与当前 remote B 不匹配
→ planner 得到 delete vs remote-modify
→ conflict
```

**B 存活。** 这就是安全删除真正需要的版本身份，而且它只依赖已有的 full reconciliation 模型。

### 存储位置

```text
.minera-sync/tombstones/<encoded-path>
```

必须以 **R2 内部 metadata** 的形式存在，而不是 Vault 文件：它在同步键空间之外，
因此永远不会作为普通笔记出现在任何设备上（invariant 8）。

### 与现有架构的契合

```text
已有：previous / RemoteChangeHub / generation / full reconciliation
D3 新增：tombstone 写入（PUT，条件形式可用）+ tombstone 扫描 + effective state 合成
D3 不需要：无条件 DELETE
```

物理对象可以暂时留在 R2 —— **逻辑上已经是 deleted** —— 以后由 D4 独立清理。

### D4 的位置

D4（物理 GC）是一个独立阶段，因为它需要回答：

```text
什么时候可以安全地物理删除一个已被 tombstone 的对象？
需要一个足够老的 watermark，保证所有设备都见过了那个 tombstone
```

这属于"存储回收"而不是"同步正确性"，所以排在最后。

## 6. 实施契约

### MUST

```text
1.  MUST 只在完整本地扫描 + 完整远端扫描都成功时产生 prune-baseline 候选
2.  MUST 让 prune-baseline 只删除 device-local 索引条目
3.  MUST 在 delete-local 的破坏性动作之前立即重新验证本地版本
4.  MUST 在本地版本已前进时报告 stale，绝不删除
5.  MUST 优先使用可恢复的 trash 语义
6.  MUST 在 trash 不可用时报告类型化 failed，绝不回退到永久 unlink
7.  MUST 让 delete-local 成功后退休 baseline
8.  MUST 让 prune-baseline 与 delete-local 都不产生 remote dirty notification
        （两者都不改变 R2）
9.  MUST 让 delete-remote 继续返回 blocked，直到 D3 提供版本身份
10. MUST 让 D3 的 remote deletion 指名它要删除的确切远端版本
11. MUST 让 tombstone 存在于同步键空间之外，绝不作为 Vault 文件出现
```

### MUST NOT

```text
1.  MUST NOT 因为"反正要删了"而跳过本地版本复查
2.  MUST NOT 在 trash 失败后 unlink
3.  MUST NOT 让 prune-baseline 触发任何 Vault 或 R2 写
4.  MUST NOT 发出无条件 R2 DELETE
5.  MUST NOT 用 delete-local 传播"本地已修改而远端被删"的情况（那是 conflict）
6.  MUST NOT 在没有 previous 证据时推断删除
7.  MUST NOT 在扫描不完整时清理 baseline
```

## 7. 对真机测试的直接改善

D1 + D2 完成后，排查中遇到的那类残留会自我收敛：

```text
之前：
  R2 probe 被删 · 本地 probe 仍在 · previous 仍在
  → delete-local
  → BLOCKED
  → 状态永远不干净，只能整库 IndexedDB reset

现在：
  R2 probe 被删 · 本地 probe 未变
  → safe delete-local（先复查版本，再 trash）
  → 两边都不存在
  → baseline GC
  → 彻底消失，不需要手工干预
```

反方向（本地删除传播到 R2）在 D3 之前仍然不能自动完成，测试脚手架继续用
`scripts/r2-delete-probe.mjs` 显式清理**它自己创建的**测试对象 —— 那是诊断工具，
与产品同步删除是两件事。

# Phase 4C.6 — Conflict Resolution

本文档冻结冲突解决的语义。它覆盖：merge base、冲突身份、3-way merge、resolution intent、
手动解决 UI，以及三者如何经过既有 planner / SafeExecutor 安全路径落地。

审计基线：插件 `c265f75`（Phase 4C.5 收口）。

## 0. 为什么真正的 3-way 需要 merge base

```text
不存在 merge base 时：
  local  "A\nB-local\nC\n"
  remote "A\nB\nC\nD-remote\n"
```

只比较这两份内容，**无法判断** local 里的 `B-local` 是"用户改的"还是"remote 从未有过 B"。
任何只看两边的算法都只能猜，而猜错的代价是覆盖掉一边的内容。

真正的 3-way 需要第三份输入：

```text
base   "A\nB\nC\n"     ← 双方共同的祖先
local  "A\nB-local\nC\n"
remote "A\nB\nC\nD-remote\n"
→ clean merge: "A\nB-local\nC\nD-remote\n"
```

因为有了 base，"B → B-local" 被识别为 local 的改动、"追加 D-remote" 被识别为 remote 的改动，
两者落在不同区域，因此可以安全合并。

## 1. previous 元数据不是 merge base 正文

现有 IndexedDB `previous-sync-state` 只保存 **size / mtime / etag**，**不保存正文**。
所以：

```text
已有 baseline           →  能判断"谁变了"
没有正文快照            →  不能做 3-way merge
```

这不是缺陷，而是 Phase 4C.6 引入 merge base store 的原因。

**已经存在的冲突无法自动合并。** 它们发生在 merge-base 功能上线之前，
所以 `autoMergeStatus = "base-unavailable"`，UI 明确显示：

> Merge base unavailable for this conflict. This conflict predates merge-base snapshots.

绝不伪造一个空 base。绝不退化成 2-way 猜测。

## 2. Merge base store

```text
IndexedDB: r2-personal-sync-conflict-v1
object store: merge-base, keyPath ["channel", "path"]
```

不扩展现有 previous DB：那个库的内容直接决定删除推断与冲突推断，
为它做 schema migration 的风险远大于"快照丢了就退回手动合并"。

```ts
{
  protocolVersion: 1,
  channel, path,
  // 证明快照对应哪一个 previous baseline，而不只是"路径相同"
  baseline: { localVersion: { size, mtime }, remoteETag? },
  sha256, byteLength,
  encoding: { bom, eol: "lf"|"crlf"|"mixed", trailingNewline },
  content,          // 仅规范化文本（LF、无 BOM）
  updatedAt
}
```

### 写入时机

只有已经证明 local / remote 收敛到同一内容时才写入：

```text
1. successful upload       ✅
2. successful download     ✅
3. successful merged resolution ✅
4. keep-local / keep-remote 成功 ✅
```

写入是 **best-effort**：写失败不会让一次成功的传输变成失败或 `unresolved`。
丢失快照只降低未来的合并能力，绝不影响普通同步正确性。

### 读取时的有效性校验

```text
record.baseline.localVersion 必须等于当前 previous.local
record.baseline.remoteETag   必须等于当前 previous.remote.etag
```

不匹配 → **视为不可用**（`base-unavailable`）。
**绝不能因为 path 相同就拿旧快照当 base。**

### 上限与 GC

```text
只为可合并的文本保存正文
binary / 超限 / 非 UTF-8 → 不保存
MAX_MERGEABLE_BYTES = 1 MiB（内部常量，本阶段不做 setting）
每个 channel 保留最新 2000 条，其余淘汰
```

## 3. 可合并文件策略

第一阶段**保守**：

```text
自动 3-way merge 仅支持:  .md  .markdown  .mdx  .txt
```

不合并：`json` / `yaml` / binary / images / pdf / sqlite / plugin state。

```text
UTF-8 decode 失败   → manual-required（不替换字节，不产生替换字符）
超过 size limit     → manual-required
binary              → manual-required
```

语义合并（例如"把 JSON 解析后再序列化"）明确不属于本阶段。

## 4. 文本编码规则

merge 内部统一为 **LF + 无 BOM** 的规范化行模型，输出时按文件形状还原：

```text
输出形状优先级：local → remote → LF fallback
BOM 与 EOL 都按这个优先级决定
```

理由：local 是用户正在编辑的那一份，它的格式最能代表用户意图。

**行尾差异不产生虚假冲突。** 三份输入都先规范化，所以
"同一内容，一份 CRLF 一份 LF" 在规范化模型里完全相同。
同时输出仍采用 local 的 CRLF，**不会**因为合并而把整份文件重写成 LF。

已测试：UTF-8、UTF-8 BOM、LF、CRLF、mixed、有/无尾随换行。

## 5. 3-way merge 语义

### 依赖

```text
package:  node-diff3
version:  3.2.1
license:  MIT
deps:     0（无 transitive dependency，无 Node builtin）
browser:  dist/diff3.iife.js / diff3.mjs 均无 Node 专有 API
```

选它的理由：真正的 diff3 原语、零依赖、体积小、有独立 browser build，
并且提供 **机器可读** 的 diff 区间，而不是只给渲染好的冲突标记。

**没有引入任何 Git implementation。**

### 我们只取它的 diff 原语

`diffIndices(base, side)` 给出每一侧相对 base 的改动区间。两侧的改动由本仓库自己合成，
而不是直接调用它的 `diff3Merge`。原因：

> `diff3Merge` 的冲突**区域**是合并 hunk 产生的，相邻两行的改动会落进同一个 region，
> 于是被报告为重叠——即使它们改的是**不同行**。那会把本规格自己的例子
> （local 改 B、remote 在 C 后追加）变成虚假冲突，恰好毁掉自动合并的意义。

自己合成后，判定就变得精确：

```text
两侧的改动是否触及同一 base 行？
  否 → clean merge
  是 → 再判断：两边改成了完全相同的结果吗？
        是 → clean merge（双方一致，不是分歧）
        否 → conflict
```

### 语义

```text
双方改不同区域        → clean merge
双方改同一行且不同    → conflict
双方改同一行且相同    → clean merge
一方删除、另一方改同一区域 → conflict
两方在同一点插入不同内容   → conflict
仅 line-ending 差异   → 不产生冲突
```

冲突 hunk 只呈现**真正不一致的区域**（连同 base 的对应区域），不是整个文件。

### 明确没有 2-way 回退

没有 base 就没有合并。**不存在**"退而求其次比较两边"的路径。

## 6. Conflict identity

冲突不是"这个 path 冲突了"，而是"**这两个版本、相对这个 baseline**不一致"。
所以身份绑定全部四项：

```text
ConflictId = base64url(SHA-256(
  "v1" :len: channel :len: path
       :len: previous 身份（local size:mtime | remote etag | remote size）
       :len: observed local（size:mtime 或 absent）
       :len: observed remote etag
))
```

长度前缀 + 版本域分隔，任何字段组合都无法与另一种组合混淆。

后果正是我们想要的：

```text
local 变了      → 新 conflictId → 旧 resolution 不再匹配
remote ETag 变了 → 新 conflictId → 同上
previous 变了   → 新 conflictId → 同上
channel 变了    → 新 conflictId → 决策绝不跨 namespace
```

旧的用户决策**在结构上无法**被应用到新内容上。

## 7. Resolution intent

```ts
{
  protocolVersion: 1,
  conflictId, channel, path,
  type: "keep-local" | "keep-remote" | "merged",
  expectedLocalVersion, expectedRemoteETag,
  createdAt,
  merged?: { content, sha256, encoding }   // 仅 merged
}
```

关键点：

```text
intent 绑定 conflictId 与 observed versions
planner 只有在 current conflict identity === intent.conflictId 时才转化为 resolution op
否则 intent stale → 不应用 → conflict 继续显示
```

stale 的 intent **既不会被丢弃成 upload/download，也不会被"升级"**；
它只是不被采纳，于是冲突仍然存在、仍然可见。

## 8. Planner 扩展

`buildSyncPlan(local, remote, previous, resolutions?)`。

```text
没有 resolutions        → 输出与之前 100% 相同
有 conflict + valid intent → 输出显式操作：
    resolve-keep-local
    resolve-keep-remote
    resolve-merged
```

**不伪装成普通 upload / download**：diagnostics、前置条件与部分成功语义都不同，
把它们合并成传输会掩盖这个差别。

planner 保持**纯函数**：resolution map 由 orchestrator 在上一轮 cycle 结束后从真实 I/O 计算好，
planner 只消费、不做 I/O。

## 9. Keep Local

含义：**以用户当时看到的 local L 为最终内容，覆盖用户当时看到的 remote R。**

```text
1. revalidate local 仍然是 L（否则 stale / conflict-superseded，不写）
2. 读取 local 内容
3. 条件 PUT：If-Match: expectedRemoteETag
4. 412            → stale，不提交 previous，重新规划
5. 5xx / 无响应    → unresolved（ambiguous-put），不提交 previous，best-effort unknown-dirty
6. 2xx            → 得到新 ETag
7. 再次确认 local 仍是 L
     ├ 是 → 提交 previous(local=L, remote=newETag) + 更新 merge base
     └ 否 → partial，不覆盖 local、不提交 previous
```

第 7 步是必要的：PUT 期间用户可能又写了字。remote 已经是 L，
local 是用户更新的内容 —— 这是真实的中间状态，**不能假装收敛**，
也不能回滚 remote（那既不可能也是另一种数据丢失）。

## 10. Keep Remote

含义：**以用户当时看到的 remote R 为最终内容，覆盖用户当时看到的 local L。**

```text
1. revalidate local 仍然是 L            → 否则 stale
2. GET If-Match: expectedRemoteETag
3. 412                       → stale（remote 变了）
4. 读到内容后再确认 local 仍是 L  → 否则 stale
5. 写入 local（modifyBinary）
6. 提交 previous + 更新 merge base
```

**不产生 R2 mutation，因此不发 Gateway 通知。**

## 11. Merged

intent 已包含 merged 结果 M（自动合并或用户编辑）。

```text
1. revalidate local 仍是 L         → 否则 stale
2. PUT M to R2 with If-Match: expectedRemoteETag
3. remote 成功后，**再次** revalidate local 仍是 L
     ├ 变了 → partial / remote-applied-local-changed
     │        · 不覆盖 local
     │        · 不提交 previous
     │        · 不回滚 remote（不可能，也不应该）
     │        · 下一轮 planner 正常处理这个新的分歧
     └ 没变 → 写 M 到 local
4. 提交 previous(local=M, remote=newETag) + 写入 merge base M
5. 清除 conflict record 与 intent
```

顺序是刻意的：remote 先写（那是另一台设备唯一能观察到的一侧，
也是唯一能施加前置条件的一侧），local 后写。

**这不是跨设备事务**，所以"remote 已成功、local 最后写失败"这类中间状态必须显式建模，
而不是假装不存在。它被表示为 `partial`，且**不提交 baseline**。

## 12. 部分成功语义

```text
applied  → 两侧都已收敛，baseline 与 merge base 更新
partial  → remote 已落地、local 未完成；无 baseline 提交；下一轮继续
stale    → 什么都没写（或只写了 remote 而 local 前置条件失败时也是 partial）
unresolved → 结果未知（ambiguous PUT / state 提交失败）
```

`partial` 在调度器计数中单独成项，**不计入 applied**，因为它故意留下未提交的 baseline。

## 13. Gateway 交互

```text
keep-local   → R2 mutation → cycle 级 markRemoteDirty
merged       → R2 mutation → cycle 级 markRemoteDirty
keep-remote  → 无 R2 mutation → **不通知**
```

沿用 Phase 4C 的既有规则：**一次 cycle 至多一次通知**；
ambiguous PUT 走 best-effort unknown-dirty；通知失败不回滚同步结果。

## 14. 手动解决 UI

命令：**`Mineral Sync: Resolve Conflicts`**

```text
无 conflict → Notice "No sync conflicts"
有 conflict → Modal
```

每个 conflict 显示：

```text
path
detected 时间
base 是否可用
local size / version
remote ETag 指纹（前 8 字符，无法反推）
autoMergeStatus
```

文本 conflict 提供 **Base / Local / Remote / Merged** 四个面板。
Base 不可用时明确写"Merge base unavailable…"，**不生成假 base**。

三个动作：

```text
Keep Local
Keep Remote
Edit Merged Result   → 可编辑 textarea → Apply
```

Merged 草稿的初始值：

```text
有 clean auto merge → 使用合并结果
有 overlapping conflict → 使用带标记的 draft（<<<<<<< LOCAL / ======= / >>>>>>> REMOTE）
无 base → 使用 **local 内容**
```

无 base 时默认 local 而不是标记文本，是因为"把用户自己的正文替换成一堆标记"
是一个破坏性默认值；用户应参照右侧 remote 面板自行编辑。

标记只存在于 UI 草稿里，**用户点击 Apply 之前绝不会写进真实笔记**。

### UI 绝不直接写数据

UI 的依赖接口只有三个能力：

```ts
{ list(): Promise<ConflictRecord[]>;
  propose(intent: ResolutionIntent): Promise<void>;
  debug?(message: string): void }
```

没有 transport、没有 R2 client、没有 Vault、没有 state store。
**UI 在类型层面就无法修改内容**，它只能提交一个 intent 并请求一轮 reconciliation。

有测试直接断言这个接口形状，并对真实 modal 代码驱动一遍，
确认它只调用 `propose` 且不触碰任何数据面对象。

## 15. 状态栏与 Notice

```text
✓ idle / ↻ syncing / … pending        既有语义不变
! conflicts (N)                       N 个活动 conflict
○ offline/error                       unresolved / failed / auth
```

首次发现某个 conflict 时 Notice 一次：

```text
Mineral Sync: N conflicts need attention. Run "Mineral Sync: Resolve Conflicts".
```

按 `conflictId` 去重，**不会每个 reconcile 都弹**。

## 16. 冲突记录的生命周期

```text
r2-personal-sync-conflict-v1 / object store "conflicts", keyPath ["channel","conflictId"]
```

```text
只有当前 active conflict 保留
planner 下一轮不再报告该 path 冲突 → record 被 GC
path 的 conflictId 变了（版本前进）→ 旧 record 被 GC，新 record 建立
resolution applied → record 与 intent 一起清除
```

`autoMergeStatus`：

```text
not-attempted | clean | manual-required | base-unavailable | unsupported | too-large | decode-failed
```

同一 conflictId 在一次会话中**只尝试一次** auto-merge，因此 manual-required 的冲突
不会每轮都重跑合并。

## 17. 明确 OUT OF SCOPE

```text
delete-local / delete-remote          仍然 BLOCKED（Phase 4C.5 D3 的 tombstone 尚未实现）
remote delete safety / tombstone      不被本阶段改动
baseline deletion propagation         不被本阶段改动
semantic JSON/YAML merge              不做
binary merge                          不做
recovery history（被替换一侧的副本）    deferred（见下）
```

### Deferred: recovery copies

在 Keep Remote / merged 覆盖本地之前，把被替换的一侧存入 device-local recovery store
是一个有价值的加固，但它需要额外的 bounded GC（条数或天数）与一套新的 UI 出口。
本阶段**未实现**，因为它会显著增加复杂度，而部分成功路径已经保证了不覆盖用户的新内容。

## 18. 实施契约

### MUST

```text
1.  MUST 只在 local/remote 已证明收敛时写 merge base
2.  MUST 校验快照的 baseline 与当前 previous 一致，否则视为不可用
3.  MUST 只在格式可合并、大小未超限、且能严格解码为 UTF-8 时自动合并
4.  MUST 使用真正的 base/local/remote 三方合并
5.  MUST 在没有 base 时退回手动，绝不伪造 base 或做 2-way 猜测
6.  MUST 让 conflict identity 绑定 channel/path/previous/local/remote
7.  MUST 让 planner 只采纳 conflictId 与当前观测完全一致的 intent
8.  MUST 保持 buildSyncPlan 为纯函数
9.  MUST 在破坏性动作之前重新验证本地版本
10. MUST 用 If-Match: observedETag 作为写入远端的前提条件
11. MUST 在远端写成功而本地写未完成时报告 partial 且不提交 baseline
12. MUST 让 UI 只能提交 intent，不能直接写数据
13. MUST 让状态栏与 Notice 按 conflictId 去重
14. MUST 让 resolution 只在真正 applied 后清除对应 conflict 与 intent
15. MUST 让 keep-remote 不产生 Gateway 通知
```

### MUST NOT

```text
1.  MUST NOT 用 mtime 判断 merge 安全性
2.  MUST NOT 用 Number 保存 generation
3.  MUST NOT 修改 delete 语义，或顺手实现 remote delete
4.  MUST NOT 引入 self-write 时间窗口 suppression
5.  MUST NOT reset 用户 IndexedDB
6.  MUST NOT 自动操作真实用户冲突作为测试
7.  MUST NOT 在自动测试中访问真实 R2 / Gateway
8.  MUST NOT 让 conflict 按钮绕开 planner
9.  MUST NOT 让 "Keep Local" 无条件覆盖 remote
10. MUST NOT 让 "Keep Remote" 直接覆盖 local 而不复查本地版本
11. MUST NOT 回滚一次已经成功的远端写入
12. MUST NOT 修改已冻结的 R2 transport / SigV4 语义
```

## 19. 真机验收

自动测试不能冒充真机结果。需要用户执行：

```text
Test A — clean automatic merge
  先让一个文件在 merge-base 上线后成功同步一次（这样才有 base）
  Windows 改 line B；Android 在 line C 后追加 line D
  恢复同步 → 预期自动 clean merge，两端 + R2 同内容，无 conflict UI 残留

Test B — overlapping conflict
  base: value = A；Windows: value = B；Android: value = C
  预期 auto merge 拒绝 → 状态栏 ! conflicts (1) → Resolve Conflicts 可见 Base/Local/Remote
  用户编辑为 value = BC → Apply → 最终两端 + R2 都是 value = BC，conflict 清零

Test C — stale manual resolution
  打开 conflict modal 先不 Apply
  另一端再次修改 remote
  再 Apply 旧 resolution
  预期：旧 resolution 被拒绝为 stale，绝不覆盖新的 remote 修改，UI 刷新成新的 conflict
```

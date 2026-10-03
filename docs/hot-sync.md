# 热同步（插件侧，Phase Hot-D / Hot-E）

后端实现与验证证据见 backend 仓库 `docs/hot-sync-implementation.md`，架构设计见
`docs/hot-sync-design.md`。本文件只讲**插件这一侧**：它持有什么、什么时候让路、以及在真机上还需要证明什么。

## 1. 开关

| 设置 | 说明 |
| --- | --- |
| **启用热同步** | 默认关闭。打开后，**打开中的** Markdown 文件由服务器端房间接管。 |
| **Gateway enabled / endpoint / token** | 热同步的前置条件；未启用时热同步不会启动。 |
| **热同步状态** | 只读：打开的会话数、持有的路径数、待交接数、冲突数、因热让路的冷操作数。 |

channel 仍然由 R2 identity 派生，没有新的输入项。设备身份在首次使用时生成并存进 Obsidian 的设备本地存储（按 Vault 隔离）；旧版本使用设备本地 `localStorage`。同步或复制 `data.json` 不会复制热会话身份。启动时保留既有会话和所有待发送的 CRDT 更新，将它们迁移到本机身份；不改变更新内容和操作 ID。

## 2. 一个文件的生命周期

```text
file-open(Markdown)
  → acquire（带上本地内容哈希）
      ├ created / joined → 建 socket → welcome 的 CRDT state 应用到编辑器
      └ conflict         → 保持冷同步，弹出提示，不覆盖任何内容
  编辑中
      ├ editor-change → 最小差异 → Y.Text → 先用持久 outbox 落盘，再发送
      ├ 远端 operation → 一次带范围的 editor.transaction
      └ 服务端 checkpoint → receipt（只确认某个明确 revision）
file-open(另一个文件) / 关闭
  → flush outbox（有界等待自己的 ack）
  → 请求覆盖 lastAcceptedRevision 的 checkpoint
  → 本地字节哈希 == receipt.contentHash ？
      否 → handoff-pending：**继续围栏冷同步**，提示用户
      是 → release
             ├ released            → 提交冷 baseline，解除围栏
             ├ 还有别的客户端在线   → saved-hot-elsewhere：提交 baseline，但路径仍然热，围栏保留
             └ 其他失败            → handoff-pending
```

## 3. 冷同步让路（栅栏）

`HotSyncCoordinator` 是"这个路径能不能被冷路径动"的唯一答案：

```text
conflict         > handoff-pending > hot > （无）→ 可以冷同步
```

两层，缺一不可：

1. **计划输入**（`buildSyncPlan` 的 `deferPath`）：被热会话持有的 key 在 plan 里得到
   `noop(reason = deferred-by-hot-ownership)`——既不是 "missing"，也不是 "nothing to do"。
   这一步买到的不是性能而是**安全**：同一个 key 若不带围栏，在"R2 里没有对象 + 本地未变 + 有 baseline"
   这一形态下 planner 会产出 **`delete-local`**（删掉用户正在编辑的文件），在双改形态下会产出 conflict。
   这两个事实都不该在冷侧出现。（有测试明确对比两种结果。）
2. **执行边界**（`hotDeferral`）：scheduler 在跑每个操作前再问一次 `isFenced(key)`，命中计 `deferred` 并跳过。
   `deferred` 与 `blocked` 同属确定性结论，不阻塞 generation 游标；被 deferred 的 noop 也不参与
   merge-base 回填（那不是"收敛"，是别人在写）。
3. **服务端 authority**（`hotAuthority`）：每个冷 mutation 前向 Gateway 申请 `/hot/cold/acquire`。
   - `granted` → 执行，之后 `settle` 归还 lease；
   - `deferred` → 跳过（另一个设备正在编辑这个路径，只有 Gateway 知道）；
   - `unreachable` → **继续执行**：控制平面不可达不能停掉 R2 同步，此时由 R2 的条件写与服务端
     checkpoint 的 `If-Match` 前提兜底，冲突会被报成 `EXTERNAL_CONFLICT` 而不是静默覆盖。

另外四个本地事件入口（create / modify / delete / rename）同样拦截。rename 的接线是：命中热路径时先做
**命名空间操作**（同 DocumentId、epoch+1、旧路径 tombstone、新路径写入），**成功则不 mark 任何路径**——
Vault 已经写过新路径，此时再登记成冷变更会与命名空间操作抢同一个前提；**被拒绝则 mark 两个路径**，
因为 Obsidian 已经把文件移走了，那确实是一次需要冷侧协调的本地变更。

### 外部修改（设计文档 §24 的保守版）

热文件被**编辑器缓冲区之外**的东西写到磁盘时（其他插件、外部程序、脚本），插件比较
**磁盘内容 vs 绑定编辑器缓冲区**——刻意不跟 CRDT 比，因为用户正在输入时文件短暂落后于缓冲区是正常的，
拿 CRDT 比会在每次普通保存上误报。两者不一致即：

```text
flagExternalEdit(path)
  → 该路径进入 conflict 栅栏（冷同步继续让路）
  → 通知一次（同一次外部修改只说一次）
  → 外部字节既不合并进 CRDT，也不会被本插件悄悄覆盖
```

第一版不做 diff import。当前出口是解算界面（下一节）。

### 解算：冲突不是死路（设计文档 §26/§27）

命令 **`Mineral Sync: Resolve Hot Sync Conflicts`**，或直接点状态栏（热冲突时点击打开的就是它，
冷冲突解算器解决不了热冲突）。每个冲突一行，都不删除任何内容：

| 冲突来源 | 「保留本文件的版本」 | 「改用另一侧的版本」 | 「使用已准备好的合并结果」（有冷侧合并稿时出现） |
| --- | --- | --- | --- |
| `external-local-edit`（本机发现） | 取**磁盘**内容为文档：写回编辑器缓冲区，走普通的本地编辑路径推给服务端 | 取**会话**内容：把文档文本写回文件（覆盖外部字节） | 把合并稿写进文档与文件（同 keep-local，但内容来自用户） |
| `conflict`（服务端发现） | `keep-local`：房间把下次 checkpoint 的前提重新指向 R2 当前 revision（若该 revision 已被删除则记为"有意替换"），并把文档标成**欠一次保存**，随后由房间自己的 alarm 把本机内容写上去 | `accept-remote`：退役冲突房间，从 R2 建立新的房间，等待 welcome 后把选定版本写回编辑器和磁盘；后续输入继续走新热会话 | 先退役被拒绝的房间，再接入新房间，把合并稿作为一次**本地编辑**推给房间，然后请求 checkpoint |
| `handoff-pending` | 同上（需要一次成功的 checkpoint） | 同上 | 同上 |

### 为什么"合并"必须走热侧

冷侧的 `resolve-merged` 自带版本前提（`expectedLocal` + `expectedRemoteETag`），看起来可以自己落地，
但它有两个热侧才知道的障碍：

1. **房间是这条路径唯一的写者。** 冷侧写一次、房间再用自己的状态写一次，两次写没有共同的版本前提。
   围栏存在的意义正是如此，所以"允许冷侧合并"等于把围栏拆了。
2. **合并稿哪一侧都读不到。** R2 存的是输掉的那一侧，磁盘存的是另一侧；用户手里的合并结果只存在于
   冷侧那份 resolution intent 里。

于是解算时热侧直接使用那份已存的合并稿，把它作为**这个设备自己的编辑**交给房间
（`applyTextAsLocalEdit`，与一次键入完全同一条路径），再由房间 checkpoint 上去。有一条必须守住的
细节：**接手前要先退役被拒绝的那个房间**。`open()` 只要看到会话记录就优先 `resume()`，而冲突背后的
记录正是服务端已经拒绝过的那个会话；不先退役就重新加入，只会拿同一个理由被拒第二次——这正是
`未命名.md` 卡住的机制。

另外两条不变量不变：

- **决定失败时冲突保持冻结**。宁可文件卡住，也不能因为一次请求失败就把栅栏放下。
- **决定不传内容**。内容本来就在某一侧，需要传输的决定可能中途失败，让两侧各自以为对方是另一个样子。

`handoff-pending`（上次关闭时没能确认保存）也会列在同一个界面里，因为它的路径同样被冻结、
而且窗格可能早就不在了。它的两个选择语义不同：

- 「保留本文件的版本」→ 请求房间重新保存。**返回的是"已请求"而不是"已保存"**：请求保存不等于
  证明保存成功，所以栅栏与那条交接记录都留着，直到原有的核对真正通过（重新打开该文件即可继续）。
- 「改用另一侧的版本」→ 退役旧热会话，接入 R2 版本并写回本地；读写或接入失败仍保留可处理的冲突。

服务端会核对"这个路径的 binding 确实是这个 document + epoch"，否则返回 404——一个过期或错认的
解算请求不能把别的文档的房间重新指向这个路径，更不能替别的文档放弃所有权。

### 命名空间操作不会因为客户端消失而烂尾

删除/重命名/新建都写成 durable phase machine，每个中间 phase 落库时**顺手武装一次恢复 alarm**：

```text
NAMESPACE_RESUME_MS = 5s，MAX_NAMESPACE_RESUME_ATTEMPTS = 6
客户端在 quiescing / checkpointed / r2-applied 之间消失
  → 协调器用存下来的 intent 自己重试并完成
  → 6 次仍失败 ⇒ 显式失败（resume-exhausted），并把 quiescing 的 binding 放回 active
```

理由很直接：**路径卡在 quiescing 比"明确失败"更糟**。前者谁都不能写，后者调用方至少知道发生了什么。

## 4. 持久化

热同步使用独立数据库 `r2-personal-sync-hot-v1`（不与 previous-state 混库：那个库的内容直接决定删除推断）。

```text
hot-sessions   每个路径一条：documentId / epoch / 状态 / 已确认 revision / 已 checkpoint revision
hot-outbox     未被 ack 的操作：update + clientOperationId（服务端按其去重）
hot-handoffs   未完成的交接：requiredRevision / contentHash / r2ETag
```

重启后 `restore()` 会重建栅栏：`handoff-pending` 与 `conflict` 立即生效，**不会**等第一次有人打开文件。

## 5. 日志与诊断

不打印正文、token、ticket 与完整路径（用 `pathDigest`）。可以看到：

```text
hot ready channel=… sessions=… handoffs=…
hot status path-digest=… status=… detail=…
hot conflict path-digest=… reason=…
hot close path-digest=… outcome=… detail=…
hot baseline path-digest=… revision=…
```

状态栏（`presentSyncStatus`）在热同步开启时额外区分这些状态——"syncing" 一个词不足以说明发生了什么：

| 状态 | 表现 |
| --- | --- |
| 热会话已连接、无待保存 | idle 图标，"Hot sync connected" |
| 正在接入 / R2 保存未完成 | syncing（转动），"Joining the hot session…" / "Saving to R2…" |
| 热会话断开 | offline 语气，"Edits are kept locally and will be sent when it reconnects" |
| 交接未完成（含窗格已关闭的情况） | waiting + 数量徽标，"Those files will not be cold-synced until the handoff finishes" |
| 热冲突 | conflict 语气 + `!`；点击**不会**打开冷冲突解算器（它解决不了热冲突） |
| 传输层问题（R2 不可达 / 凭据被拒） | 仍然优先显示：它影响所有文件，热状态只影响一个 |

热同步关闭时这些分支完全不参与，冷状态栏的表现与加这个功能之前逐字节一致（有测试锁定）。

## 6. 真机自检（一条命令）

生产 bundle 里没有自检命令（`src/dev/**` 在生产构建中被替换为空模块）。要在真机上跑：

```powershell
npm run dev                      # 开发构建（__DEV__ = true）
# 把 main.js 装进 vault 的插件目录，然后重载 Obsidian
```

在 Obsidian 里执行命令 **`Mineral Sync (dev): Hot Sync Self-Test`**。它做这些事：
```text
hot-configuration                    设置是否齐全（不齐则其余场景全部 skipped，不会 fail）
hot-open-with-real-editor            真编辑器 + 真 MarkdownView，走 Obsidian 的 requestUrl 与 WebSocket
hot-local-edit-round-trip            编辑器里输入 → 服务端 ack → checkpoint receipt 的 hash == 本地字节
hot-remote-update-reaches-the-editor 第二个"设备"（同进程、无头编辑器）输入 → **真编辑器**收到
hot-handoff-commits-a-baseline       交接完成、receipt 覆盖本地字节、冷 baseline 被提交、栅栏释放
hot-plugin-wiring                    （需已启用热同步）插件自己的 file-open 处理器把路径变热并被围栏
hot-cleanup                          命名空间 delete + 删除本地 scratch
```

报告窗口会弹出，同时写到插件目录 `last-hot-self-test-report.txt`（Android 上可直接 `adb pull`）。

**不需要点屏幕的跑法（Android 用）**：手机放在桌上通常是锁屏的，而锁屏状态打不开命令面板——
最值得跑的那次检查反而最难触发。所以开发构建还接受一个**文件触发器**：

```powershell
# 开发构建已装进插件目录后：
adb push RUN-HOT-SELFTEST /storage/emulated/0/Documents/mineral/private/mineral-sync-hot-selftest/
adb shell am force-stop md.obsidian
adb shell am start -n md.obsidian/.MainActivity     # 解锁设备后启动
# 30–90 秒后：
adb pull /storage/emulated/0/Documents/mineral/.obsidian/plugins/mineral-obsidian-sync/last-hot-self-test-report.txt
```

标记文件在**开始跑之前**就被删掉（崩溃不会变成死循环），生产构建里既没有触发器也没有自检代码。
标记文件名带 `.md`：Android 的 Obsidian adapter 只对自己索引过的路径作答，一个从外部 `adb push`
进去、没有扩展名的文件会永远 `exists() === false` —— 那和"没人请求过自检"完全一样。

> **真机实测（2026-09-28，OPPO Find X8 / Android，WebView 154）：`7 passed, 0 failed, 0 skipped`** ——
> 协议组、双设备收敛、交接 baseline、插件自身接线、清理全部在真机上通过。此前同一套自检在真机上
> `5 passed / 2 failed`、`4 passed / 3 failed`，逐条追下去抓到的**三个真实产品缺陷**（桌面单测都没暴露）：
>
> 1. **seed 只写进 CRDT，从不发送**。`seedFromTextIfEmpty` 把文件内容插入文档后没有调用
>    `onLocalUpdate`，于是"新建文件打开成热会话"的正文**从未到达 R2**；更糟的是用户随后敲的第一个字符
>    会以 diff 形式上传，产生的首个 revision **缺少文件开头那段文字**。
> 2. **seed 跑在会话注册之前**。协调器在 `open()` 里先 attach + seed，之后才 `sessions.set(...)`，
>    而绑定通过 `sessionFor(path)` 查找会话 —— 于是 seed 找不到会话、被静默丢弃
>    （真机报告里的证据：`binding=24, editor=24, revision=0, outbox=0`）。这一条是三个失败场景的
>    **共同根因**：第二个设备加入、交接、插件接线全都依赖"首内容成为第一个 revision"。
> 3. **`openHotDocument` 先关闭当前会话，再检查新文件的面板**。移动端会多发 `file-open` 事件，
>    一个"新文件的面板还没激活"的事件会先关掉正在编辑的文档的热会话，然后直接 return ——
>    文件静默退回冷同步。现在先确认面板可用，再关闭旧会话。
>
> harness 也随之修好：标记文件必须带 `.md`、触发检查改为轮询、根目录按设备探测（协议组用可见回退根，
> wiring 组用**不被同步过滤器忽略**的可见根，因为那一组验证的正是普通同步候选）、根探测改为幂等、
> 打开面板在移动端先 `revealLeaf` 并回退查找编辑器。

> **部署坑（Android 特有，值得记住）**：把新的 `main.js` 推进 vault 的插件目录**不会**改变 Obsidian
> 实际运行的代码。实测：磁盘上的 manifest 是 `0.2.0`、`main.js` 含新代码，而**已加载**的插件报告
> `manifest.version = 0.1.0`、命令列表里没有新命令——它一直在跑安装时的那份缓存代码。用一个**新的插件
> id** 安装则立刻生效（诊断探针插件就是这么验证的）。所以：更新插件后要么在设置里关掉再打开、要么
> 用新版本号重新安装，否则"我换了文件但行为没变"。
>
> 这一条已经由部署脚本自动化：`./scripts/deploy-android.ps1 -Restart`（等价于 `--rotate`）会把新包
> 装进一个全新的 `<pluginId>-deploy-<version>-<时间戳>/` 目录、改指 `community-plugins.json`、迁移
> `data.json`，再重启 Obsidian——不需要手工停用/启用，也不需要借一个新的插件 id。见
> [`deployment.md`](deployment.md)。


**根目录是探测出来的，不是写死的**：Android 的 Obsidian 会痛快地写一个点目录，然后**不把它放进 vault 索引**
（`getFileByPath` 返回 null），于是 `.mineral-sync/selftest/…` 里的文件永远打不开到 leaf 里，
wiring 组必然失败。自检启动时先探测：创建文件 → 问 vault 要它 → 能拿到就用隐藏根，
拿不到就退到 `private/mineral-sync-hot-selftest/<run-id>/`。这个退路是**可见路径**，
所以它必须同时被同步过滤器忽略（`private/mineral-sync-test-local/`、`private/mineral-sync-hot-selftest/`
是内建 excluded 前缀）——否则一次自检会把自己的草稿笔记当成用户内容上传。探测结果写在报告的
`hot-configuration` 场景里。

协议组发生在被忽略的前缀下，所以冷同步不会在"获取会话"与"第一次 checkpoint"之间插进一次普通上传。
wiring 组用可同步路径，因为要验证的正是"插件把可同步路径接管成热会话"。

自检不覆盖、必须人工确认的仍然是：中文 IME composition、光标/选择/undo 的手感、多窗格、双设备真实互见。

## 7. 人工真机验收清单（自检之外）

自动测试（含上面的自检）覆盖不了的部分必须在 Windows + Android 上做：

1. 两端打开同一文件，一端输入 → 另一端近实时出现。
2. 中文 IME composition 不产生乱码、重复字或光标跳跃。
3. 光标、选择、undo/redo 在远端编辑到达时保持合理。
4. 持续输入超过 10 秒，中间 R2 有 checkpoint（可用 MCP 读取或 `pathStatus` 的 etag 变化判断）。
5. 一端关闭文档，另一端继续输入不受阻。
6. 双端关闭后 R2 是最后的内容。
7. Android 强杀（operation 已 ack）后，服务器仍完成 checkpoint。
8. 断网期间输入 → outbox 保留 → 恢复后补送且不重复。
9. 重命名：两端打开同一文件，一端改名 → 另一端跟随（服务端与插件入口均已实现，需要在真机上确认
   Obsidian 的 rename 事件顺序与 `file-open` 的相对时序）。


## 2026-10-01：冲突解决与启动交接修复

- 本机外部修改冲突选择服务器版本时，同时更新缓冲区和磁盘；回写内容在写入前登记，迟到的 Vault 事件不会因用户继续输入而误报外部修改。写入失败不会被吞掉或显示为成功。
- 服务端冲突选择服务器版本时，网关退役旧房间并撤销旧绑定；插件接入以当前 R2 内容为基础的新房间，再完成内容回写。选择成功后继续输入有回归覆盖。
- 启动先恢复持久热围栏，再完成首次冷同步，之后接入当前 Markdown 文件。恢复的未完成交接仍受围栏保护。
- 冷写入租约未结算时，网关暂缓热 acquire；空闲房间在 R2 ETag 改变后原本就会建立新的 incarnation，此逻辑保持并加入冷写入后重新接入测试。

验证范围：插件自动化测试、网关真实 workerd/SQLite/R2 模拟；本次用户文件的实际 Obsidian 输入流程仍需重载后确认。

### Windows 日志后续修复：冷冲突不得因观察不完整而消失

2026-10-01 Windows 日志显示，合并操作被 Gateway hot authority 推迟后，冷冲突记录被空 conflict list 清除；本地增量观察还在 HEAD 200 后失败。只读实测 `未命名.md` 的 HEAD 返回 ETag/Last-Modified，但没有 Content-Length。

- HEAD 缺少大小时，用对应 ETag 的条件 GET 计算实际字节数；版本变化仍按 stale 拒绝。
- scheduler 将确实处理的路径范围传给冲突协调器；增量没观察的路径、热围栏或网关推迟的操作、未成功应用的 resolution 都保留冲突记录与已有选择。观察报错时不执行冲突清理。
- 接受服务器版本时，若旧会话身份已被替换，重新查询当前绑定并针对当前房间执行该明确选择，避免仅清掉旧本机记录。

此次没有执行用户文件的写入或替用户选择冲突版本；真实文件的自动同步需插件重载后观察。

进一步只读验证确认：默认压缩响应会返回 `W/` 弱 ETag、缺失 Content-Length，条件 GET 随之返回 412；请求 `Accept-Encoding: identity` 后返回强 ETag、73 字节长度，条件 GET 成功且正文长度一致。R2 GET/HEAD 现在在签名前指定 identity，确保 metadata 与条件写前提指向存储对象的原始表示。

### 2026-10-01：热冲突可以接受一份合并结果（`未命名.md` 死锁）

用户报告 `未命名.md`（0 字节，路径摘要 `140d7812`）"冲突合并不进去、经常报错"。日志与 IndexedDB 只读核对
给出的机制是一个死锁，而不是合并失败：

```text
用户打字 → 热侧 acquire 被拒(remote-changed) → 会话记录写成 status=conflict → 栅栏生效
冷侧     → resolve-merged 意图有效，但 isFenced() 恒为真 → 每次 cycle 都 deferred，applied 恒为 0
         → 冲突记录无法退休 → 栅栏永不释放 → 回到起点
```

三处事实：`r2-personal-sync-hot-v1` 里该路径的会话记录是 `status: conflict`（全库 402 条状态里唯一一条）；
`hot-outbox` 中该 document 已无条目（48 个 outbox 键只在 `.log` 里，是历史写入与删除的累积，`.ldb` 里为 0）；
`hot-handoffs` 无记录。`pendingSave=true` 表达的是"房间欠 R2 一次 checkpoint"，不是"本地欠内容"。

修复（本次）：

- **围栏按操作类型放行 `resolve-merged`**（`HotSyncCoordinator.isFencedFor`）。这是真正解死锁的一处。
  一条从磁盘恢复的 `status: conflict` 记录会**同时**通过两条路围栏（`this.conflicts`，以及
  `sessionStatusFencesCold("conflict")`），而它背后没有任何活着的东西。冷侧持有版本绑定的意图、以及唯一
  能落地它的执行器，却跑不了；热侧唯一的出口是"写进房间"，对没有活绑定的路径意味着重新接入一个房间——
  而用户没有任何理由去那里找，他在解算器里看到的就是这个冲突。放行范围刻意收到最窄：**只有**
  `resolve-merged`、**只有**冲突不 live（有绑定就走热侧自己的界面），upload / download / delete 与
  `resolve-keep-*` 一律继续挡——它们不携带任何"用户已经决定"的事实。
- 同一例外必须**两处都放**：`scheduler` 的本地围栏（`hotDeferral.isFenced`）与 `hotAuthority.authorize`
  的第一行短路用的是同一个判断，只改一处仍会被另一处 defer。两个入口现在都把 `operation.type` 传下去。
- 解算界面在存在冷侧合并稿（`intent.type === "merged"`）时提供第三个选择，把合并稿交给热侧；热侧以
  `applyTextAsLocalEdit` 把它变成文档的一次本地编辑，再由房间 checkpoint 上去。这条针对的是**活**冲突。
- `mergeThroughHot` 在接手前先 `forwardServerResolve(accept-remote)` **退役被拒绝的房间**——否则
  `open()` 会 `resume()` 同一条记录，用同一个理由被拒第二次，看起来就像"点了没反应"。
- 合并结果同时写回**文件**：只写文档与 R2 会让下一轮冷同步立刻看到一个用户从未制造的分歧。
- 决定失败时冲突保持冻结（既有不变量，已有回归测试覆盖）。

**诊断上的一个教训**：本地围栏造成的 defer 与"服务端 authority"造成的 defer 在日志里长得一样（都是
`cycle operation deferred-by-hot-*`），所以"冷侧被挡"这件事无法区分"有一个活会话"和"只有一条磁盘记录"。
两者的正确处置相反——前者必须挡、后者必须放——下一次应先确认路径上是否存在活绑定，再决定改哪里。
"恢复的冲突记录同样围栏"这条**没有改**：卡住的原因不是围栏太宽，而是唯一能了结它的那条路此前不接受
"合并"这种答案。

回归测试：`src/hot/coordinator.test.ts`（合并例外对 upload/download/delete/keep-* 一律不放行、有活绑定时
不放行、`handoff-pending` 时不放行、无围栏时恒为 false；合并稿进入房间；磁盘记录形态的冲突也能接受合并稿；
缺文本时保持冻结）、`src/ui/hot-conflict-modal.test.ts`（无合并稿时仍是两个选择、有合并稿时把文本随决定一起
交出、界面自身不持有任何写入口、失败的决定仍可重试）。


### 2026-10-02：冷冲突遗漏服务端冲突房间

实际日志显示 `resolve-merged` 已通过本地围栏（reason=none、live=false），随后每次都
`deferred-by-hot-authority`，applied=0。线上只读查询证明房间是 conflicted、clients=0、
acceptedRevision=48、checkpointedRevision=47、pendingSave=true。本地文件此时为 0 字节，
与房间内容哈希不同。服务端围栏保护的是尚未 checkpoint 的第三个版本，不能凭本机没有
会话就判断房间没有内容。

修复：pathStatus 返回不包含正文的房间状态与 revision 元数据。冷 authority 拒绝 hot-owned
时、以及打开已有冷冲突的文件时，插件查询并持久化服务端房间冲突，把它呈现在热冲突入口。
已有冷合并稿可在该入口明确选择，采用服务器版本则退役旧房间、重新接入 R2 版本并写回文件。
界面说明仍有未保存 revision，避免把 R2 已保存版本误当成房间的全部修改。
自动释放不得丢弃未包含在本地文件中的 pending revision；状态诊断失败仍保持 denied，
不能把网关明确拒绝降级为 unreachable 后继续写入。

本次只读诊断没有修改该用户笔记或替用户选择冲突版本。部署插件后需重新加载，再通过
热冲突入口作出选择；是否真正解除该实例冲突，以设备重新加载后的日志为准。


### 2026-10-02：统一人工冲突处理（替代前述退役后合并路径）

同一文件只有一个人工冲突入口。前台热文件的旧冷冲突记录不再关闭或禁止接入正常热会话。
冷执行器继续让路；人工意图携带 hotResolution 时，不进入冷 planner，不申请 cold lease。
界面同时呈现编辑器/本地文本、R2 已保存文本、原热房间未保存文本；旧冷合并稿供人审核，
不会自动写进热房间。正常房间已经覆盖旧冷冲突的版本时，只移除旧冲突元数据。

路径状态：cold → joining → hot；真实分叉进入 conflict-review；人工提交进入 resolving；
服务端接受 revision 后为 accepted/pending-save；checkpoint 和本地采用都确认后回到 hot；
关闭时沿原 handoff 流程把基线和权限交回 cold。

协议 sync-core 0.2.2：GET /hot/path?resolution=1 返回房间正文与 revision/hash、当前 R2
ETag/正文；POST /hot/resolve 的 decision=merged 携带 documentId/epoch、expectedRevision、
expectedContentHash、expectedRemoteETag 和结果文本。原房间原子校验并新增一个 revision，
checkpoint 对已观察的 R2 ETag 条件写入；不 retire、不换 documentId。旧版本拒绝为 stale。
operationId 和完整意图摘要持久去重，confirmOnly 查询已接受结果，不应用新决定。

插件提交前还核对磁盘哈希与编辑器哈希，并排空已发送编辑；UI 保存的人工意图支持失败重试。
HTTP 已保存结果不等于本机已采用：活会话等待对应 CRDT 帧；冻结会话重新接入同一房间。
期间新增本地输入不得被旧结果覆盖。只有服务端保存与本机采用都确认，才清除对应 conflictId。
没有确认的意图继续持久化，checkpoint 后触发再次核对。文件删除仍由既有命名空间流程负责，
文本合并不把删除悄悄改成清空文件。

打包脚本修复了 consumer 阶段误将 callback 当成 dryRun 的问题；实际安装、版本与 tarball
均核对为 0.2.2，避免打印成功却没有更新插件依赖。
# 恢复后没有连接的历史会话

冷同步下载是读取服务器已经保存的 R2 检查点并更新本机文件，不需要远端写入租约。其他设备正在热编辑时也必须允许检查点下发；GET 的 ETag 和本地版本校验仍由 SafeExecutor 执行。本机持有热会话、冲突或待交接保护的文件继续禁止冷下载，远端上传和删除仍申请网关写入权限。

历史会话记录只能建立启动保护，不能永久代替实际连接。每轮完整本地扫描前，协调器检查没有实时会话、没有正在打开的编辑器的受保护路径。只有本地没有未确认操作、待保存版本或交接记录，并且网关确认同一文档和 epoch 的房间处于 active、无人连接、所有版本已保存时，才删除历史会话记录并释放本地保护。

释放不写文件、不修改冷同步基线；后续仍由普通计划器判断下载、上传或冲突。网关不可达、房间冲突、其他客户端占用、未保存编辑均继续保留保护。查询期间开始打开文件时不能释放；打开操作也等待正在进行的恢复完成，避免与记录删除交错。

### 改名请求丢失回包

本地改名事件先保护目标路径。发送命名空间请求前，将完整改名意图和 operationId 写入设备会话记录；超时或未完成结果继续保护旧名、新名，使用同一个意图恢复，不能降级成新路径冷上传。重启恢复这两个路径的保护。确认后再更新文档路径和 epoch，并释放等待发送的编辑。

若桌面已经通过冷同步收到新名称的相同副本，网关确认改名后可把旧副本放入本地回收站，并让原编辑页打开新文件。必须逐字相同，且旧编辑页没有未保存修改；否则保留文件并报告命名空间冲突。

### 旧基线冲突与重复调度

人工冲突记录和状态刷新不能自行请求下一轮同步；只有自动合并意图或经新观察验证的人工选择需要后续执行。否则状态界面清理旧冷冲突后，相同基线会再次产生冲突并无限触发全量扫描。

冷计划遇到两边都存在、大小相同的冲突时，可以校验本地稳定读取与远端条件 GET 的完整字节。仅 SHA-256 相同的版本才更新基线；不同内容、读取失败或版本变化继续保留冲突。本机热同步保护的路径不参与这个校验。后续冲突观察和合并基线记录必须使用更新后的同一基线。

网关不可用时，加入当前热文件的请求按 5 秒起步、60 秒上限退避。编辑事件不能跳过退避或重复弹出不可用通知；当前文件显示断线状态，连接恢复后自动重试，成功加入才清除失败状态。切换到另一文件不继承前一文件的退避，插件卸载或关闭热同步会取消重试定时器。

### 2026-10-03：缺失文件的恢复选择

当手机保留基线但本地文件缺失时，冷同步会推断本地删除。如果远端热会话拒绝该删除，调度器必须记录当前缺失状态和远端版本，显示可处理的冲突，而不是保留过期记录或静默跳过。用户选择保留远端后，先根据本轮观察校验持久化 ResolutionIntent，再生成计划；即使远端 ETag 已回到基线，也必须执行带 ETag 和本地缺失前置条件的恢复，避免旧删除计划抢先执行。没有有效选择时仍保留原有删除语义。

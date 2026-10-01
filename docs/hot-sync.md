# 热同步（插件侧，Phase Hot-D / Hot-E）

后端实现与验证证据见 backend 仓库 `docs/hot-sync-implementation.md`，架构设计见
`docs/hot-sync-design.md`。本文件只讲**插件这一侧**：它持有什么、什么时候让路、以及在真机上还需要证明什么。

## 1. 开关

| 设置 | 说明 |
| --- | --- |
| **启用热同步** | 默认关闭。打开后，**打开中的** Markdown 文件由服务器端房间接管。 |
| **Gateway enabled / endpoint / token** | 热同步的前置条件；未启用时热同步不会启动。 |
| **热同步状态** | 只读：打开的会话数、持有的路径数、待交接数、冲突数、因热让路的冷操作数。 |

channel 仍然由 R2 identity 派生，没有新的输入项。设备身份（`hotClientId`）在首次使用时生成并存进 `data.json`。

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
冷冲突解算器解决不了热冲突）。每个冲突一行，两个选择，都不删除任何内容：

| 冲突来源 | 「保留本文件的版本」 | 「改用另一侧的版本」 |
| --- | --- | --- |
| `external-local-edit`（本机发现） | 取**磁盘**内容为文档：写回编辑器缓冲区，走普通的本地编辑路径推给服务端 | 取**会话**内容：把文档文本写回文件（覆盖外部字节） |
| `conflict`（服务端发现） | `keep-local`：房间把下次 checkpoint 的前提重新指向 R2 当前 revision（若该 revision 已被删除则记为"有意替换"），并把文档标成**欠一次保存**，随后由房间自己的 alarm 把本机内容写上去 | `accept-remote`：放弃该路径的热所有权，文件交回冷同步按普通规则协调（此时若仍不一致，就是一个**冷**冲突，交给已有的解算器） |
| `handoff-pending` | 同上（需要一次成功的 checkpoint） | 同上 |

两条不变量：

- **决定失败时冲突保持冻结**。宁可文件卡住，也不能因为一次请求失败就把栅栏放下。
- **决定不传内容**。内容本来就在某一侧，需要传输的决定可能中途失败，让两侧各自以为对方是另一个样子。

`handoff-pending`（上次关闭时没能确认保存）也会列在同一个界面里，因为它的路径同样被冻结、
而且窗格可能早就不在了。它的两个选择语义不同：

- 「保留本文件的版本」→ 请求房间重新保存。**返回的是"已请求"而不是"已保存"**：请求保存不等于
  证明保存成功，所以栅栏与那条交接记录都留着，直到原有的核对真正通过（重新打开该文件即可继续）。
- 「改用另一侧的版本」→ 放弃热会话，记录清掉，文件交回冷同步。

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


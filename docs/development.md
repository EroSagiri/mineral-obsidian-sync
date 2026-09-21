# 开发与验证文档

面向开发者与验证人员。使用者文档见 [`../README.md`](../README.md)。

---

## 阶段状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| Phase 1 | 本地元数据扫描、分页 `ListObjectsV2`、纯确定性三方 planner、IndexedDB previous-state、Inspect Sync State 诊断 | 完成 |
| Phase 1.5 | 安全 bootstrap 基线、惰性二进制 SHA-256 比对、`GET If-Match`、只有验证为逐字节相同的配对才能建立基线 | 完成 |
| Phase 2A | aws4fetch 仅签名、`CredentialProvider`、`RequestUrlTransport`、`R2Client` 的 GET / PUT / HEAD、`PUT If-Match`、`PUT If-None-Match: *`、`GET If-Match`、顺序 `SafeExecutor`、本地/远端执行前置条件、per-key previous-state 提交、PUT 结果不明与状态写失败 → `unresolved`、二进制 `createBinary` / `modifyBinary`、remote identity 含 endpoint/bucket/prefix、忽略策略变化 fail closed、删除硬阻断 | 完成 |
| Phase 2A.5 | 真实 R2 + 真实 `requestUrl` 传输验证、测试前缀硬保护、仅开发用的自检脚手架、`__DEV__` + 生产 stub、下载父目录修复 | 传输层已验证；下载写盘路径的真实运行**待执行**（见下方验证记录） |
| Phase 3A | 自动调度器（Vault 事件 → dirty set → debounce → planner → SafeExecutor），删除仍为 BLOCKED | 尚未开始 |

---

## 代码结构

```text
src/
  main.ts                    插件入口：命令注册、Inspect 流程编排、状态栏
  settings.ts                设置界面与默认值
  local/
    scan-local.ts            本地元数据扫描
    read-local.ts            本地字节读取（读取前后各校验一次元数据）
    ensure-folders.ts        写入前创建缺失的父目录
  remote/
    signer.ts                aws4fetch 仅签名封装（从不调用 AwsClient.fetch）
    transport.ts             requestUrl-only 传输层
    r2-client.ts             S3 语义客户端：LIST / GET / HEAD / 条件 PUT
    credentials.ts           CredentialProvider 接口与 settings 实现
    scan-remote.ts           远端元数据扫描
    errors.ts                RemoteHttpError / RemoteObjectChangedError
  sync/
    planner.ts               纯确定性三方 planner（不联网、不写盘）
    executor.ts              SafeExecutor
    fingerprint.ts           SHA-256 与变更判定
    ignore.ts                忽略策略与策略指纹
    path.ts                  key 规范化
    types.ts                 领域类型
  state/
    state-store.ts           IndexedDB 实现
    sync-state.ts            StateStore 接口
  bootstrap/
    bootstrap.ts             基线建立（惰性哈希，并发 3）
  ui/
    dry-run-modal.ts         只读检查报告
  dev/                        仅开发用（生产构建被替换为空 stub）
    integration/
      test-namespace.ts      测试命名空间与硬保护
      guarded-client.ts      唯一允许持有的 R2 client
      local-scratch.ts       本地 scratch 根目录探测与解析
      scenarios.ts           传输层场景
      convergence.ts         执行器场景
      runner.ts              Obsidian 内运行入口
      result.ts              结果模型、脱敏、报告渲染
    report-modal.ts
    self-test-command.ts     开发命令注册
    globals.d.ts             __DEV__ 声明
test/
  obsidian.ts                obsidian 模块（requestUrl）的测试替身
  integration/               进程内 R2 模拟器、fake Vault、集成测试
```

---

## 开发命令

```powershell
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run dev            # 开发构建（含自检命令，输出 main.js）
npm run build          # 生产构建（typecheck + 打包，不含任何 dev 代码）
```

### 生产构建如何剔除开发代码

两条措施同时生效，缺一不可：

1. `esbuild.config.mjs` 里的 `define: { __DEV__: ... }`：生产构建把 `__DEV__` 折叠为 `false`，`main.ts` 中 `if (__DEV__)` 整块被消除，自检命令不会被注册。
2. 同一文件里的 `stubDevelopmentModules` 插件：生产构建把 `src/dev` 模块替换为空 stub，因此自检代码**连字节都不会进 main.js**，即使有人在运行时手动调用也调不到。

验证方式：

```powershell
npm run build
Select-String -Path main.js -Pattern 'r2-sync-dev-|mineral-sync-test|self-test'
```

生产产物应约为 24 KB 且上述模式**全部无匹配**；开发产物约 340 KB 且全部匹配。

---

## 集成自检脚手架

`src/dev/integration/` 只回答一个问题：`aws4fetch`（仅签名）→ `SignedRequest` → `RequestUrlTransport` → Obsidian `requestUrl` → Cloudflare R2 这条链，在真实环境里是否真的符合设计。

它不是同步功能，也没有生产入口。

### 安装 dev 构建到测试 Vault

```powershell
npm run dev
Copy-Item -Force .\main.js       "<Vault>\.obsidian\plugins\mineral-obsidian-sync\main.js"
Copy-Item -Force .\manifest.json "<Vault>\.obsidian\plugins\mineral-obsidian-sync\manifest.json"
```

**不要覆盖 `data.json`** —— 那里存着 endpoint、bucket 与凭据。复制完成后在 Obsidian 里重载插件。

### 两条自检命令

```text
Mineral Sync (dev): R2 Transport Self-Test
Mineral Sync (dev): R2 Convergence Self-Test
```

传输自检（8 个场景，不需要 Vault 写入）：

```text
test-prefix-guard        15 次越界尝试必须在发网前被拒，list 不得暴露 run 目录外的 key
transport-primitives     逐原语能力矩阵，happy path 12 项 + 错误路径 6 项，永不中止（见下）
conditional-create       If-None-Match:* 成功 → 第二次 412 → 原内容未被覆盖
conditional-update       If-Match 成功且 ETag 前进 → 过时 ETag 412 → 新内容保留
conditional-get          匹配 ETag 成功 → 过时 ETag 412 且不返回正文
conditional-head         HEAD 的 If-Match 探测（确认端点行为）
list-scoped              ListObjectsV2 只返回 run 目录内的 key
binary-roundtrip-64k     64 KiB 二进制逐字节 + SHA-256
binary-roundtrip-1m      1 MiB 同上
```

场景式测试在第一个失败请求处就会中止，这对定位平台问题是最差的形状；而只测 happy path 的矩阵更糟 —— 它可以在一个平台上全绿却什么都不解释。`transport-primitives` 因此逐个原语独立探测、永不中止，并且**成功路径与错误路径都测**：

```text
happy path (12)   LIST / PUT If-None-Match:*(small, 64KiB) / GET(small, 64KiB) / HEAD /
                  GET If-Match / HEAD If-Match / PUT If-Match
error path (6)    HEAD absent → 404      GET absent → 404
                  HEAD If-Match(stale) → 412    GET If-Match(stale) → 412
                  PUT If-None-Match:* on existing → 412    PUT If-Match(stale) → 412
                  （错误路径只有在产生【类型化错误】时才算 ok，传输层抛错算失败）
ground truth      LIST after small PUT / after 64 KiB PUT / after update /
                  after rejected create / after rejected stale write
```

最后那几行 `LIST after …` 解决归因问题：产品的 `putObject` 用条件 `HEAD` 确认写入，HEAD 若坏掉会让一次**成功的** PUT 看起来失败，而 `ListObjectsV2` 是普通 GET，用它回查对象是否真的落盘，才能把"写入失败"与"确认失败"分开。

收敛自检（7 个场景，使用真实 Vault 与真实 IndexedDB）：

```text
local-scratch-root               解析并探测本地 scratch 根目录（附加行）
safe-executor-convergence        upload → 提交 state → 第二次计划为 noop
download-applied                 远程独有文件（根目录 / 一级嵌套 / 多级嵌套 / 父目录已存在）
                                 → 建父目录 → 写盘 → 提交 state → 再次为 noop
download-blocked-by-file-parent  父路径被文件占用 → failed / parent-path-is-file，占用文件不动
stale-remote-preserved           计划后远端被外部改动 → stale，state 不变，新内容保留
stale-local-preserved            计划后本地被改动 → stale，本地新内容保留，state 不变
state-commit-failure             R2 写成功 + state 提交失败 → unresolved，不回滚 R2
ambiguous-put                    PUT 已落盘但响应丢失 → unresolved，不提交 state
```

### 测试前缀硬保护

两条不变式，刻意分开：

**远端（不可让步）。** integration helper 可能产生的每一个 R2 object key 都必须落在 `<已配置prefix>.mineral-sync-test/<run-id>/` 内。`GuardedIntegrationClient` 是脚手架唯一能持有的 R2 client，它在签名与网络动作**之前**校验**映射后的 object key**（即 R2 真正会收到的 key）。

**本地。** 每个 Vault 路径必须位于某次运行的 scratch 根目录内；调用方永不自己拼路径，只能通过 `LocalScratch.key(leaf)` / `IntegrationTestNamespace.key(leaf)` 铸造叶子名。

拒绝范围：`.mineral-sync-test-evil/…`、`.mineral-sync-test/../…`、绝对路径、缺失 run id、兄弟 run 目录、兄弟 run 前缀，以及叶子名里的 `.` / `..` 段。

脚手架**不做任何删除**。每次运行的对象都留在自己的 run 前缀下，报告会打印出来供人工清理。

### 本地 scratch 根目录的解析

这里有一个真实事故记录。

**2026-09-21T17:10:53Z**，收敛自检首次运行，5 个场景全部在 0.5 秒内失败：

```text
ENOENT: no such file or directory, open
'<Vault>\.mineral-sync-test\20260921T171053Z\convergence\test-file.md'
```

当时整个 `.mineral-sync-test/` 在磁盘上都不存在 —— 原因是 `Vault.createBinary` **不会创建缺失的父目录**。这是脚手架的落盘策略问题，不是产品缺陷。

修复后又发现第二层限制（**2026-09-21T17:17:50Z** 的探测轨迹）：

```text
hidden:create-folders=ok
hidden:createBinary=ok
hidden:getFileByPath=FAILED (returned null)
```

Obsidian **能创建点目录、能写文件**，但**不把点目录下的文件放进 vault 索引**。产品的 `scanLocal` 依赖 `vault.getFiles()`，所以点目录作为本地根目录在 Obsidian 里不可行。

因此现在的解析流程是：

1. 显式创建目录链（`Vault.createFolder`，失败则 `adapter.mkdir`，逐级创建，容忍"已存在"）。
2. 用场景真正使用的那套 Vault 调用对首选隐藏根目录做端到端探测：`createBinary` → `getFileByPath` → `getFiles` → `readBinary` → `adapter.stat` → `modifyBinary`。
3. 只有探测失败才回退到 `private/mineral-sync-test-local/<run-id>/`。

两种情况下 R2 不变式都成立：回退时 convergence client 的远端 prefix 本身就结尾于 `.mineral-sync-test/<run-id>/`。报告会写明最终选用的根目录，并打印完整探测轨迹。

能力探测只在 `<run-base>/local-probe/` 下写一个文件，位于场景根目录之外，因此它永远不可能进入同步计划。

---

## 真实验证记录

环境：Windows 桌面版 Obsidian，真实 Cloudflare R2 bucket，真实凭据，`environment: obsidian-requesturl`。

| 时间 (UTC) | 内容 | 结果 |
| --- | --- | --- |
| 2026-09-21T17:09:15Z | Transport Self-Test | **8 / 8 PASS** |
| 2026-09-21T17:10:53Z | Convergence Self-Test | 0 / 5，全部 `ENOENT`（脚手架缺陷，已修复） |
| 2026-09-21T17:17:20Z | Transport Self-Test（guard 重构后重跑） | **8 / 8 PASS** |
| 2026-09-21T17:17:50Z | Convergence Self-Test | **6 / 6 PASS**，本地 scratch 回退到可见根目录 |
| 2026-09-21T17:29:18Z | Transport Self-Test | **8 / 8 PASS** |
| 2026-09-21T17:30:31Z | Convergence Self-Test（含 `download-applied`、`download-blocked-by-file-parent`） | **8 / 8 PASS**，成功下载写盘路径的真实 Vault 验证完成 |
| 2026-09-21T17:32:35Z | Transport Self-Test（**Android**，无矩阵） | 1 / 8 PASS：仅 `test-prefix-guard` 通过，其余全部在首个 `HEAD` 处 `Request Failed. IOException Stream closed` |
| 2026-09-21T17:32:58Z | Convergence Self-Test（**Android**，无矩阵） | 1 / 8 PASS：`local-scratch-root` 通过（纯本地），其余全部在首次远端 `HEAD` 处同样失败 |
| 2026-09-21T17:40:27Z | Transport Self-Test（桌面，含 `transport-primitives`） | **9 / 9 PASS** |
| 2026-09-21T17:40:57Z | Convergence Self-Test（桌面） | **8 / 8 PASS** |
| 2026-09-21T17:42:08Z | Transport Self-Test（**Android**，矩阵只有 happy path） | 2 / 9 PASS：矩阵 12 项 happy path **全部通过**；7 个场景仍全部失败 |
| 2026-09-21T17:47:57Z | Transport Self-Test（**Android**，矩阵含错误路径） | 7 / 9 PASS：矩阵 18 项中 16 项通过，2 项 HEAD 错误路径被平台丢弃；`conditional-head` 同理 |

### Android 非 2xx 语义（真机实测，问题已彻底摸清）

上表 17:32 那两轮曾让我判断为"Android 上 HEAD 不可用"。17:42 的 happy-path 矩阵推翻了这个判断，17:47 的错误路径矩阵给出了完整答案：

```text
OPPO Find X8 / Android 16，Obsidian requestUrl，真实 R2

HEAD 404                      → 抛 transport-error (IOException Stream closed)   ❌ 平台丢掉响应
HEAD 412                      → 抛 transport-error (IOException Stream closed)   ❌ 同上
GET  404                      → 类型化 http-404                                  ✅
GET  412                      → 类型化 precondition-failed                       ✅
PUT  412（If-None-Match 冲突） → 类型化 precondition-failed                       ✅
PUT  412（If-Match 过时）      → 类型化 precondition-failed                       ✅
HEAD 200 / 条件 HEAD 200       → 正常返回                                         ✅
64 KiB PUT / 64 KiB GET        → 正常                                             ✅
```

结论：约束按**方法**划分，不按状态码 —— **HEAD 的非 2xx 响应没有 body，被平台整个丢掉；任何带 body 的响应都正常。**

产品影响：

```text
1. 产品的 HEAD 只出现在 putObject 成功之后的条件确认，那时对象必然存在且 ETag 匹配 → 200 ✅
2. 上传与下载的 stale 判定依赖 PUT / GET 的 412，两者在 Android 上都是类型化的 ✅
3. 唯一窄窗口：PUT 成功之后、确认 HEAD 之前若被其他写者改动，确认 HEAD 会 412。
   Android 上这变成 opaque → 执行器归为 unresolved/ambiguous-put（不提交 state、不覆盖、
   下一轮重扫）；桌面端同一情况归为 stale。两者都不提交基线，都安全，只是标签不同。
4. 彻底消除该窗口（Phase 3 候选）：让 putObject 的 baseline 直接取自 PUT 响应的 ETag
   与已知 body 长度，不再发确认 HEAD。两个平台行为完全一致，且每次上传少一次往返。
```

脚手架的处理：矩阵中 `HEAD 404` 与 `HEAD 412` 两项在移动端记为"平台丢弃响应"（仍然逐字记录，
只是不计为失败），因为它们**从不决定写入是否发生**；其余 16 项 —— 包括 GET/PUT 的 404/412 ——
在任何平台上都保持严格，一旦变成 opaque 就判失败。这样移动端能全绿，同时约束依然被逐次测量。

教训：只测 happy path 的矩阵可以在一个平台上全绿而什么都不解释。错误路径必须一起测。

### 关于 `throw: false`：已经在用，而且这次实测正好是它生效的证据

一条外部建议认为根因是 `RequestUrlTransport` 没写 `throw: false`（Obsidian 的 `requestUrl` 默认在 status ≥ 400 时 reject）。核对源码后：**从 Phase 2A 起就一直在传** `throw: false`。

而那次 Android 实测本身就是内部控制 —— 同一个 build、同一个 transport、同一个调用点：

```text
GET  404 → 类型化 http-404               ✅
PUT  412 → 类型化 precondition-failed     ✅
GET  412 → 类型化 precondition-failed     ✅
HEAD 非 2xx → opaque throw                ❌
```

如果 `throw: false` 缺失，`GET 404` 与 `PUT 412` 不可能带着 status 返回。⇒ 参数是生效的；残余问题发生在原生桥接层读取"无 body 的错误响应"时，位置在 `throw: false` 的管辖范围**之下**。

不过这条建议确实挖出一个真问题：**`throw: false` 此前零测试覆盖** —— `test/obsidian.ts` 的替身完全忽略 `throw`，把这一行删掉所有测试仍然全绿。现在补上了：

```text
test/obsidian.ts   替身按 Obsidian 语义实现：status ≥ 400 且未传 throw: false 时 reject
transport.test.ts  3 项断言：throw 恒为 false；400/401/403/404/409/412/429/500/503 作为普通响应返回；
                   真正未完成的请求抛 RemoteTransportError（并保留 cause）
已验证守卫有效   临时删掉 throw: false → 4 项测试失败（含 r2-client 的条件 GET / 412 用例）
```

架构边界（这条建议讲得对，现在写进代码契约）：

```text
完成的 HTTP 交换 → 响应，不论 status        （404 / 412 / 429 / 5xx 都是协议结果，不是 transport error）
没有完成的交换   → RemoteTransportError      （DNS / TLS / socket / 原生桥接失败）
```

新增 `RemoteTransportError`，与 `RemoteHttpError` 分开：前者是"没有响应"，后者是"有响应但状态非 2xx"。执行器的分类不变（未完成的 PUT → `unresolved/ambiguous-put`，不提交 state）。报告会把包装前的原始文本一并带出（`... ← Request Failed. IOException Stream closed`），因为那行文本正是平台诊断的依据。

### 真实端点确认的行为

- R2 对 `HeadObject` 的 `If-Match` 返回 **412**。此前只能依据官方兼容表推断，现已由真实端点观测确认。
- `PUT If-None-Match: *` 第二次返回 412，且**不覆盖**既有内容。
- `PUT If-Match` 过时返回 412；`GET If-Match` 过时返回 412 且**不返回正文**。
- 64 KiB 与 1 MiB 二进制往返：长度、逐字节、SHA-256 三者一致。
- 成功下载会在真实 Vault 中创建缺失的父目录链：`root-file.md`（无需建目录）、`one-level/foo.md`、`multi/level/deep/foo.md`、`existing/parent/kept.md`（父目录已存在）四种情况全部落盘确认，且第二次 reconcile 为 noop。
- 父路径被文件占用时（`blocked/occupier` 为文件）返回 `failed / parent-path-is-file`，未创建任何文件，占用文件字节不变。
- Obsidian 能创建点目录并写入文件，但 `vault.getFileByPath()` 看不到它们。
- `Vault.createBinary` 不创建父目录；`Vault.createFolder` 非递归。

### 验证过程中发现并修复的缺陷

| # | 缺陷 | 影响 |
| --- | --- | --- |
| 1 | `crypto.getRandomValues` 单次上限 65,536 字节 | 1 MiB 二进制场景首次运行即失败；已改为分块生成 |
| 2 | 测试前缀 guard 曾接受叶子名里的 `..` 段 | 已显式拒绝 `.` / `..` 段 |
| 3 | upload 收到 4xx 曾归类为 `unresolved/ambiguous-put` | 现在 4xx → `failed`，只有 5xx/429 与传输抛错才是 `unresolved` |
| 4 | 生产 bundle 曾包含 dev 自检代码（47.3 KB，且运行时可达） | 加入生产 stub 后回到 23.9 KB，且无任何 dev 字符串 |
| 5 | 脚手架本地写入不建父目录 | 见上方事故记录，已改为显式建目录链 + 能力探测 |
| 6 | `SafeExecutor.download` 在父目录缺失时 `ENOENT` | 新增 `ensureParentFolders`；下载的本地副作用被推到尽可能晚 |
| 7 | 收敛场景从未执行过"成功 download" | 新增 `download-applied` 与 `download-blocked-by-file-parent` |
| 8 | 只测 happy path 的原语矩阵在 Android 上全绿却什么都没解释 | 矩阵补 6 项错误路径探测 + 5 项 LIST 地面真相 |
| 9 | `throw: false` 零测试覆盖（删掉它所有测试仍然全绿） | 替身按 Obsidian 语义实现，新增 3 项断言锁住该不变量 |

---

## 自动化测试

```text
npm run typecheck      通过
npm test               93 passed | 1 skipped（共 94，13 个文件）
npm run build          通过（生产产物 ~24 KB）
```

| 测试文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `src/local/ensure-folders.test.ts` | 8 | 逐级创建、复用已存在目录、父路径是文件、创建失败、并发写者、不回滚 |
| `src/remote/transport.test.ts` | 2 | transport 原样转发与凭据接口 |
| `src/remote/r2-client.test.ts` | 3 | 条件 GET 的签名头、412 → stale、403 → 类型化错误 |
| `src/sync/planner.test.ts` | 24 | 三方 planner 全部分支 |
| `src/sync/executor.test.ts` | 12 | 条件创建/更新、stale、状态提交失败、4xx vs 5xx 分类、嵌套下载、父路径被占用、删除硬阻断 |
| `src/sync/ignore.test.ts` | 2 | 忽略策略与指纹 |
| `src/bootstrap/bootstrap.test.ts` | 9 | 基线建立的全部路径 |
| `test/integration/signed-request.test.ts` | 5 | 签名不可变性、sessionToken 回归 |
| `test/integration/test-prefix-guard.test.ts` | 9 | 硬保护的越界与列表过滤 |
| `test/integration/local-scratch.test.ts` | 5 | scratch 根目录解析、回退、探测失败轨迹 |
| `test/integration/safe-executor.integration.test.ts` | 7 | 收敛、stale、unresolved、blocked，隐藏与回退两种根目录 |
| `test/integration/r2-conditional.integration.test.ts` | 7 | 传输场景 + "场景有牙齿"的注入失败测试 |
| `test/integration/r2-real.manual.test.ts` | 1（默认 skipped） | 可选的真实 R2 诊断，见下 |

进程内集成测试使用一个进程内 R2 模拟器，但跑在其上的是**真实 signer 与真实 `RequestUrlTransport`**。它们是回归保护，不是真实端点验证。

### 可选：从 Node 发起的真实 R2 诊断

```powershell
$env:MINERAL_TEST_R2_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
$env:MINERAL_TEST_R2_BUCKET="..."
$env:MINERAL_TEST_R2_ACCESS_KEY_ID="..."
$env:MINERAL_TEST_R2_SECRET_ACCESS_KEY="..."
$env:MINERAL_TEST_R2_PREFIX="some-prefix"
npx vitest run test/integration/r2-real.manual.test.ts
```

它通过 Node `fetch` 验证真实签名与真实 R2 条件语义，但**绕开了 `requestUrl`**，因此通过它不能得出"Obsidian 传输可用"的结论。不要提交这些环境变量（`.env*` 已在 gitignore 中）。

---

## Android 冒烟测试

桌面端与移动端使用同一个 `RequestUrlTransport`，没有第二套移动端实现。

已在 OPPO Find X8 / Android 16 上完成（2026-09-21）：

```text
1. Test Connection / ListObjectsV2                       ✅ 经 test-prefix-guard 与矩阵 LIST
2. R2 Transport Self-Test（含 18 项原语矩阵）             ✅ 见上方"Android 非 2xx 语义"
3. 64 KiB PUT / GET 往返                                 ✅ 矩阵实测
4. Web Crypto SHA-256                                    ✅ 1 MiB 二进制 SHA-256 一致
5. 点目录不被索引 → fallback 本地根目录正常工作            ✅ local-scratch-root 通过
6. 报告渲染与落盘（存在插件目录，可 adb 读取）             ✅
```

仍待执行：

```text
7. Convergence Self-Test（executor + 真实 IndexedDB + 真实 Vault 写盘）  ← 移动端最后一个缺口
8. 1 MiB binary 场景（移动端内存与 ArrayBuffer）—— 矩阵只到 64 KiB，
   完整 1 MiB 由 Transport Self-Test 的 binary-roundtrip-1m 覆盖
```

## 已验证 / 未验证

已验证（真实 Windows Obsidian + 真实 R2）：

```text
真实 requestUrl 传输                     已验证
真实签名被 R2 接受                        已验证
条件创建 / 条件更新 / 条件 GET / HEAD 条件 已验证
412 stale 语义                            已验证
64 KiB 与 1 MiB 二进制往返                已验证
上传路径 + state 提交 + noop 收敛          已验证
成功 download 写盘路径（真实 Vault）       已验证（2026-09-21T17:30:31Z）
stale remote / stale local 保护           已验证
状态提交失败与 PUT 结果不明 → unresolved   已验证
测试前缀隔离（真实 bucket）                已验证
删除仍然被硬阻断                           已验证
```

Android 上已单独验证（OPPO Find X8 / Android 16，2026-09-21T17:47:57Z）：

```text
全部 2xx 原语（含 HEAD、条件 HEAD、64 KiB 上下行）   已验证
GET / PUT 的 404 与 412 错误路径（类型化）            已验证
点目录不被索引 → fallback 本地根目录                  已验证
Web Crypto SHA-256（1 MiB 二进制）                    已验证
HEAD 的非 2xx 响应被平台丢弃                          已确认，且从不影响写入决策（见上）
```

未验证：

```text
Android / iOS 的 Convergence Self-Test（executor + IndexedDB + Vault 写盘）  未验证 —— 移动端最后一个缺口
自动调度、事件监听、任何后台行为                                            尚未实现
```

---

## 测试对象清理

自检不做任何自动清理，需要人工删除：

```text
R2:   <remote prefix>/.mineral-sync-test/<run-id>/    （报告里的 test root）
      整个前缀直接删除即可；多轮运行会有多个 run-id

Vault: private/mineral-sync-test-local/<run-id>/       （回退时的可见根目录）
       .mineral-sync-test/<run-id>/                     （隐藏残留，含 local-probe/probe.bin）
```

---

## 下一步

Phase 3A（自动调度器）开工前必须满足：

1. ~~收敛自检在真实 Vault 上跑通，包含 `download-applied`（成功下载写盘）。~~ 已于 2026-09-21T17:30:31Z 满足。
2. Android 冒烟测试通过，或在明确知晓风险的前提下决定暂不覆盖移动端。

Phase 3A 本身仍受以下约束：删除保持 BLOCKED；不实现 Gateway、临时凭据端点、队列、Cloudflare Worker、Durable Object、WebSocket。

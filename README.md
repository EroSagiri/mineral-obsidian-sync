# Mineral Sync — Phase 2A.5

这个 Obsidian 插件用 R2 作为远端存储，负责三件事：扫描 Vault 与远端元数据、只为**逐字节证明一致**的文件建立本设备基线、以及通过一个串行、带条件、fail-safe 的执行器去执行一份**已经观测过的**计划。

**Inspect Sync State** 是诊断功能，不是同步动作。本阶段没有手动同步、没有 push / pull，也没有自动调度器。

## 基线建立规则（Bootstrap）

对于一个既没有完整历史状态、又同时存在本地文件和 R2 对象的 key：

1. 大小不同 → 直接判定为 conflict，不读取任何文件内容。
2. 大小相同 → 只对该 key 惰性读取二进制内容。
3. 两端字节流都用 Web Crypto 做 SHA-256。
4. 只有两个哈希一致时才写入基线。有 ETag 时远端读取使用 `If-Match`；`412` 一律视为 unresolved，绝不接受。

本地文件元数据在二进制读取前后各校验一次。本地文件变化、R2 ETag 变化、或单个文件网络失败，都保持 unresolved，留待后续重试。校验并发度为 3，插件卸载后不再启动新任务。

已有完整基线的 key 走常规元数据成本模型（本地 `mtime` + size；远端 ETag + size），不会重复下载或哈希未变化的文件。

## 执行器规则（Executor）

`SafeExecutor` 一次只执行一个操作，并且每成功执行一个操作只提交该 key 的历史状态：

- `upload`：新对象使用 `If-None-Match: *`，其余情况使用 `If-Match: <观测到的 ETag>`。
- `download`：**先**执行 `GET If-Match: <观测到的 ETag>`（此时还不动本地），再复查本地前置条件，然后创建缺失的父目录，再复查一次目标，最后才写入。
- `ensureParentFolders`：逐级创建，一次一层；对自己已经创建出来的目录**绝不做回滚**；当某一级父路径被**文件**占用时拒绝继续（`failed` / `parent-path-is-file`），当目标路径本身是文件夹时也拒绝（`failed` / `target-path-is-folder`）。占用位置的文件永远不会被修改。
- `412` 一律是 `stale`，绝不变成覆盖写。收到的 4xx 是明确的 `failed`。
- 只有 5xx / 429 响应、传输层抛错、或状态提交失败才是 `unresolved`；`unresolved` 从不声称成功，也从不提交基线。
- `delete-local` 与 `delete-remote` 被硬阻断。

`Vault.createBinary` 不会创建缺失的父目录，`Vault.createFolder` 也不是递归的 —— 这两点在 2026-09-21 用真实 Vault 验证过。缺少这一步，往本地不存在的目录里下载文件会在每一次 reconcile 时都以 `ENOENT` 失败。

## 安全边界

- 已实现：R2 `ListObjectsV2`、`GetObject`、`HeadObject`、带条件的 `PutObject`。
- 不存在：R2 `DELETE`、`COPY`、multipart upload。
- Vault 写入：只发生在被证明可行的 `download` 路径；Vault 删除：不存在。
- IndexedDB 写入：只写“已证明一致”或“已证明完成传输”的 key 的 `PreviousEntry`。
- 手动同步 / push / pull 动作：不存在。
- 状态栏：只做被动状态显示，永远不会触发同步。
- 自动调度器、Vault 事件监听、轮询、Gateway、WebSocket：不存在。

凭据由 Obsidian 常规的插件设置机制保存，本插件不做加密。请使用权限范围尽量窄的 R2 token，并保护好设备配置。不要把凭据或设置数据提交到仓库。

## R2 传输集成脚手架（仅开发用）

`src/dev/integration/` 只回答一个问题：`aws4fetch`（仅签名）→ `SignedRequest` → `RequestUrlTransport` → Obsidian `requestUrl` → Cloudflare R2 这条链，在真实环境里是否真的符合设计？

它不是同步功能，也没有任何生产入口。

### 测试前缀硬保护

这里强制两条不变式，而且刻意把它们分开。

**远端（不可让步）。** 集成 helper 可能产生的每一个 R2 object key，都必须落在 `<已配置prefix>.mineral-sync-test/<run-id>/` 之内。`GuardedIntegrationClient` 是脚手架唯一能持有的 R2 client，它在任何签名和网络动作**之前**校验**映射后的 object key** —— 也就是 R2 真正会收到的那个 key。

**本地。** 每一个 Vault 路径都必须位于某次运行的 scratch 根目录之内；调用方永远不自己拼路径，而是通过 `LocalScratch.key(leaf)` 或 `IntegrationTestNamespace.key(leaf)` 铸造叶子名。

- `putObject`、`getObject`、`headObject`、`listObjects` 全部拒绝或过滤 scratch 根目录之外的一切。
- `.mineral-sync-test-evil/…`、`.mineral-sync-test/../…`、绝对路径、缺失 run id、兄弟 run 目录、兄弟 run 前缀，全部拒绝。
- 不做任何删除。每次运行的对象都留在自己的 run 前缀下，报告会打印出来供人工清理。

### 本地 scratch 根目录的解析

`Vault.createBinary` 不会创建缺失的父目录 —— 2026-09-21T17:10Z 的真实运行在写入第一个字节之前就以 `ENOENT … .mineral-sync-test/<run>/convergence/test-file.md` 失败。此外 Obsidian 也可能拒绝创建点目录。

因此脚手架现在会显式创建目录链（绝不依赖 `createBinary`），然后用场景真正使用的那套 Vault 调用（`createBinary`、`getFileByPath`、`getFiles`、`readBinary`、`adapter.stat`、`modifyBinary`）对首选的隐藏根目录做一次端到端**探测**。只有探测失败时，才回退到 `private/` 下一次运行专属的可见根目录。两条路径下 R2 不变式都成立：回退时 convergence client 的远端 prefix 本身就结尾于 `.mineral-sync-test/<run-id>/`，所以 object key 依然落在测试前缀内。报告会写明最终选用的是哪个根目录，并打印完整的探测轨迹。

能力探测只在 `<run-base>/local-probe/` 下写一个文件，位于场景根目录**之外**，因此它永远不可能进入任何同步计划。

### Obsidian 内自检（唯一真实的 `requestUrl` 证据）

```powershell
npm run dev          # dev 构建：注册自检命令
# 在 Obsidian 中重载插件，然后执行其中一条：
#   "Mineral Sync (dev): R2 Transport Self-Test"
#   "Mineral Sync (dev): R2 Convergence Self-Test"
```

传输自检覆盖：条件创建、条件更新、条件 GET、条件 HEAD 探测、受限 listing、以及 64 KiB / 1 MiB 二进制往返。收敛自检覆盖：本地扫描 → 远端扫描 → planner → `SafeExecutor` → R2 → 状态提交 → 第二次计划，外加 stale-remote、stale-local、状态提交失败、以及 PUT 结果不明这些情况。两者都会弹出一个可复制的报告窗口。

`npm run build`（生产构建）不会注册这些命令，也不会打包 `src/dev`：`__DEV__` 标志在编译期被折叠，开发模块被替换为空 stub。已通过 grep 构建产物 `main.js` 验证。

### 从 Node 发起的可选真实 R2 诊断

准备一个真实但可随时丢弃的 bucket，以及一个权限范围很窄的 token：

```powershell
$env:MINERAL_TEST_R2_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
$env:MINERAL_TEST_R2_BUCKET="..."
$env:MINERAL_TEST_R2_ACCESS_KEY_ID="..."
$env:MINERAL_TEST_R2_SECRET_ACCESS_KEY="..."
$env:MINERAL_TEST_R2_PREFIX="some-prefix"
npx vitest run test/integration/r2-real.manual.test.ts
```

这会通过 Node `fetch` 验证真实的签名和真实的 R2 条件语义。它绕开了 `requestUrl`，所以**这里通过不能作为“Obsidian 传输可用”的证据**。不要提交这些环境变量（`.env*` 已在 gitignore 中），粘贴报告前也要先检查内容。

单元测试与进程内集成测试（`npx vitest run`）在真实 signer 和真实 `RequestUrlTransport` 之上使用一个进程内 R2 模拟器。那些测试是回归保护，不是真实端点验证。

## Android 冒烟测试（尚未执行）

桌面端与移动端使用**同一个** `RequestUrlTransport`，没有第二套移动端传输实现。以下项目仍需要在真机上验证：

1. `R2 Sync: Test Connection` —— 针对真实 bucket 的 ListObjectsV2。
2. `Mineral Sync (dev): R2 Transport Self-Test` —— 条件创建 / 更新 / GET。
3. 64 KiB 与 1 MiB 二进制往返（内存与 `ArrayBuffer` 处理）。
4. 设备 WebView 上 Web Crypto `SHA-256` 是否可用。
5. IndexedDB `previous-sync-state` 读写，包括独立的集成测试数据库。
6. 确认自检报告能正常渲染，且 run 前缀始终停留在 `.mineral-sync-test/` 之内。

在这些步骤执行之前，移动端支持只能描述为**未验证**。

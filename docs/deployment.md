# 部署

一份实现、两个目标。所有部署逻辑都在 `scripts/deploy.mjs` 里，`scripts/deploy-windows.ps1`、`scripts/deploy-android.ps1`、`scripts/deploy.sh` 只是转发参数的薄壳，因此桌面、真机和 CI 不会出现三套行为的偏差。

**目录信息全部来自环境变量**，脚本里没有任何写死的 vault 路径。

---

## 快速开始

```powershell
# 1) 把 vault 路径写进 .env（.env 已被 gitignore）
Copy-Item .env.example .env
#    编辑 .env：
#    MINERAL_DEPLOY_WINDOWS_VAULT=C:\Users\me\Documents\MyVault
#    MINERAL_DEPLOY_ANDROID_VAULT=mineral

# 2) 先看计划，不做任何改动
./scripts/deploy-windows.ps1 -DryRun
./scripts/deploy-android.ps1 -DryRun

# 3) 真正部署
./scripts/deploy-windows.ps1
./scripts/deploy-android.ps1 -Restart
```

也可以完全绕开 PowerShell 壳，直接调用 Node 入口：

```powershell
node scripts/deploy.mjs --target windows
node scripts/deploy.mjs --target android --restart
node scripts/deploy.mjs --target android --dev --restart   # 含自检命令的开发包
npm run deploy:windows
npm run deploy:android:restart
```

---

## 环境变量

优先级：**CLI 参数 > shell 环境变量 > `.env` / `.env.local` > 内置默认值**。shell 优先于 `.env`，所以 CI 或一次性覆盖不需要改动被跟踪的模板文件。

### Windows / 桌面

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MINERAL_DEPLOY_WINDOWS_VAULT` | ✅ | vault 根目录（不是插件目录）。脚本自己拼 `.obsidian/plugins/<pluginId>` |
| `MINERAL_DEPLOY_KILL_OBSIDIAN` | | `true` 时复制前先结束桌面 Obsidian |
| `MINERAL_DEPLOY_RESTART_OBSIDIAN` | | `true` 时复制校验完成后重新拉起 Obsidian |
| `MINERAL_DEPLOY_OBSIDIAN_PROCESS` | | 进程名，默认 `Obsidian` |
| `MINERAL_DEPLOY_CREATE_PLUGIN_DIR` | | `true` 时允许创建尚不存在的插件目录 |

### Android

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MINERAL_DEPLOY_ANDROID_VAULT` | ✅ | vault 名（`mineral`，解析到 `/sdcard/Documents/mineral`）或绝对设备路径 |
| `MINERAL_DEPLOY_ANDROID_SERIAL` | | ADB 序列号；只有一台已授权设备时自动探测 |
| `MINERAL_DEPLOY_ADB` | | `adb` 可执行文件；不在 PATH 上时写全路径 |
| `MINERAL_DEPLOY_ANDROID_PACKAGE` | | Obsidian 包名，默认 `md.obsidian` |
| `MINERAL_DEPLOY_ANDROID_ACTIVITY` | | 显式启动组件，如 `md.obsidian/.MainActivity`；默认用 launcher intent |
| `MINERAL_DEPLOY_ROTATE_PLUGIN_DIR` | | 是否安装到新插件目录（见下文） |
| `MINERAL_DEPLOY_PRUNE_DUPLICATE_FOLDERS` | | 是否删除声明同一插件 id 的其他已启用目录（破坏性） |
| `MINERAL_DEPLOY_TIMEOUT_MS` | | 单条 ADB 命令超时，默认 `120000` |

### 共用

| 变量 | 说明 |
| --- | --- |
| `MINERAL_DEPLOY_VAULT` | 只有一个 vault 时的公共回退值 |
| `MINERAL_DEPLOY_PLUGIN_ID` | 插件 id / 目录名，默认 `mineral-obsidian-sync` |
| `MINERAL_DEPLOY_PLUGIN_FILES` | 要复制的产物列表，默认 `main.js manifest.json`（`styles.css` 存在时自动带上） |
| `MINERAL_DEPLOY_BUILD` | `production`（默认）或 `development` |
| `MINERAL_DEPLOY_TARGET` | 未传 `--target` 时的目标：`windows` / `android` |
| `MINERAL_DEPLOY_SKIP_BUILD` | `true` 时不重新构建，直接部署现有产物 |
| `MINERAL_DEPLOY_DRY_RUN` | `true` 时只打印计划 |

`.env` 的语法很小：`KEY=VALUE`、`#` 注释、可选的成对引号。值里的 `#` 不会被当成注释起始。

---

## 目标一：Windows 桌面 vault

流程：`npm` 构建 → 复制 `main.js` / `manifest.json` → 逐文件 SHA-256 比对 → 确认 `community-plugins.json` 里插件是启用状态。

两件容易踩的事它都会主动报告：

1. **Obsidian 正在运行。** 桌面 Obsidian 把旧 bundle 缓存在内存里，复制文件本身不会改变正在运行的代码。脚本会发现进程（`tasklist`）并打印提示；加 `-KillObsidian` 或 `-Restart` 让它自己处理。
2. **`community-plugins.json` 里没有这个插件。** 文件复制到位但插件处于禁用状态时，Obsidian 不会加载它。脚本会把 id 追加进注册表并打印新内容。

```powershell
./scripts/deploy-windows.ps1 -Vault "D:\vaults\work"        # 临时换 vault
./scripts/deploy-windows.ps1 -Create                        # 首次安装，目录不存在
./scripts/deploy-windows.ps1 -KillObsidian -Restart         # 关掉再拉起
./scripts/deploy-windows.ps1 -Report                        # 落一份 last-deploy.json
```

---

## 目标二：Android

### 为什么不是一句 `adb push`

把新的 `main.js` 推进**已存在**的插件目录，**不会**改变 Android Obsidian 实际运行的代码——插件按目录路径缓存已加载的 bundle（见 [`hot-sync.md`](hot-sync.md) 的"部署坑"）。磁盘上的 manifest 是 0.4.x、`main.js` 里确实是新代码，而运行中的插件仍然报告旧版本、命令列表里没有新命令。

因此脚本做了两件事：

- **默认原地更新**，并在结尾明确提示"需要重启 Obsidian 才会生效"；
- **`-Rotate` 时安装到全新的 `mineral-obsidian-sync-deploy-<version>-<时间戳>/` 目录**，把 `community-plugins.json` 指向新目录，把旧目录里的 `data.json`（设置与 R2 凭据）迁移过来，然后删掉旧目录。这是让真机确实执行新构建的唯一可靠方式。

```powershell
./scripts/deploy-android.ps1                       # 原地更新
./scripts/deploy-android.ps1 -Restart              # 重启 Obsidian（会自动开启 -Rotate）
./scripts/deploy-android.ps1 -Rotate -NoRotate     # 见下：显式控制
./scripts/deploy-android.ps1 -Dev -Restart         # 带自检命令的开发包
./scripts/deploy-android.ps1 -Serial <serial>      # 多设备时指定
./scripts/deploy-android.ps1 -Prune                # 清理重复的插件目录
```

### 写入是"临时文件 + 校验 + 原子替换"

每次推送都落在 `<目标>.tmp-<时间戳>`，比较设备端 `sha256sum` 与本地哈希，一致才 `mv -f` 覆盖。`mv` 在同一文件系统内是原子的：读取方看到的要么是旧 bundle，要么是完整的新 bundle，绝不会是写了一半的文件。设备端没有 `sha256sum` 时回退 `md5sum`；两者都没有时只依赖字节数报告，不会假装校验过。

如果设备上已有逐字节相同的构建，脚本会打印 `Unchanged` 并跳过推送，所以重复部署是廉价的。

### `-Rotate` 与 `-NoRotate`

- **`-Restart` 会默认开启 `-Rotate`**：重启的目的就是加载新代码，而原地覆盖达不到这个目的。
- `.env` 里的 `MINERAL_DEPLOY_ROTATE_PLUGIN_DIR` 显式设置时优先级高于该默认值，可用来固定行为。
- 已经确认"原地更新 + 手动重启"够用的 vault，可以固定 `MINERAL_DEPLOY_ROTATE_PLUGIN_DIR=false`。

轮换结束后会做三件事，顺序不能颠倒：

1. 把新目录写进 `community-plugins.json`（**原地替换**旧条目，保留 Obsidian 记录的启用顺序）；
2. 把旧目录里的 `data.json`（R2 凭据与全部设置）迁移到新目录——如果新目录已经有 `data.json`，则保留新的那份；
3. 删除被取代的旧目录。

### 设置（data.json）如何跨轮换存活

`data.json` 只存在于**正在运行的那个目录**里，所以迁移必须在删除之前发生。轮换时脚本会先迁移、确认落盘、再删旧目录；新目录已有 `data.json` 时不会覆盖。

### 残留的轮换目录会被自动清理

轮换会不断产生 `mineral-obsidian-sync-deploy-<version>-<时间戳>/`。部署被中断、或注册表被手工改过，都可能留下一个已经不被启用的旧目录——不占加载，但白占空间并留着过期副本。因此：

- **每次 `--rotate` 部署结束时**，所有本脚本命名的 `-deploy-` 目录（除当前目标外）都会被迁移 + 删除；
- **非轮换部署时**只打印警告并提示用 `--rotate` / `--prune` 处理，不会擅自删目录；
- 只清理 `<pluginId>-deploy-` 这个名字前缀。手工命名的目录（例如历史上的 `mineral-sync13`）永远不走这条路，而是交给下面的重复检测与 `--prune`——那两种情况需要先报告再删除。

### 重复插件目录

`community-plugins.json` 存的是**目录名**，而插件身份来自 `manifest.json` 里的 `id`。两者可以不一致（真机上就存在过 `mineral-sync13/` 目录里放着 `id: mineral-obsidian-sync` 的插件）。如果注册表里同时启用了两个声明同一 id 的目录，Obsidian 会**两个都加载**：命令重复出现、事件处理器跑两份。

脚本每次部署都会检查这种情况：

- 发现时打印警告并列出目录，提示用 `-Prune` 处理；
- `-Prune` 时把重复目录里的 `data.json` 迁移到当前目录、删除旧目录，并把它的条目从注册表里摘掉；
- 部署前的"活动目录"判定**不看注册表顺序**，而是优先选择"存在且以本插件命名"的目录，避免把行为不端的旧副本当成当前版本。

> 一个已实测的陷阱：注册表里指向 `<pluginId>`（未轮换的规范目录）时，它同样是**本插件**——检测逻辑必须把它计入"上一份安装"，否则轮换之后旧目录永远不会被回收。这条已由 `test/deploy.test.ts` 里的 `activeFolderFromRegistry` 用例锁住。

---

## 构建：production 与 development

| 模式 | 产物 | 内容 |
| --- | --- | --- |
| production（默认） | `main.js` | 压缩，`src/dev` 被整体 stub 掉，**不含任何自检代码** |
| development | `build-diag/main-dev.js` | 内联 sourcemap，保留 `__DEV__` 自检命令 |

开发构建写到 `build-diag/`（已 gitignore），只有在部署时才以 `main.js` 这个名字落地，因此调试包永远不会被误当成、或被误提交为线上产物。部署结束（以及构建失败时）`esbuild.config.mjs` 会被还原成原样。

```powershell
npm run build              # = tsc --noEmit + 生产打包
npm run build:dev          # 开发包 → build-diag/main-dev.js
node scripts/build.mjs dev --promote   # 开发包顺便覆盖成 main.js
node scripts/deploy.mjs --target android --dev --restart
```

无论哪种模式，落到 vault 里的文件名都是 `main.js`，vault 布局不随构建模式变化。

---

## 部署报告

`--report [路径]`（等价于 `-Report`）会写一份 JSON，默认 `last-deploy.json`（已 gitignore）：

```json
{
  "schema": "mineral-obsidian-sync/deploy-report@1",
  "when": "2026-10-01T14:29:26.453Z",
  "target": "android",
  "build": "production",
  "bundle": { "mode": "production", "file": "main.js", "sha256": "3233…" },
  "plugin": { "id": "mineral-obsidian-sync", "version": "0.4.17" },
  "pluginDir": "/sdcard/Documents/mineral/.obsidian/plugins/mineral-obsidian-sync",
  "files": [{ "name": "main.js", "bytes": 331063, "hash": "3233…", "remoteBytes": 331063 }]
}
```

它记录的是**这次实际部署的那个 bundle**（dev / 生产、staged 与否）的哈希，便于事后对齐"设备上跑的到底是哪一份"。

---

## 退出码与失败行为

- `0`：部署完成（`--dry-run` 同样返回 0）。
- 非 0：配置缺失（会指出应该设置哪个变量）、`adb` 不可用、设备未授权、哈希不一致、vault 或插件目录不存在等。
- **失败不会留下半个 bundle**：推送先在临时文件上完成并校验，任何一步失败都不会覆盖正在运行的产物。
- `--dry-run` 不构建、不写盘、不推送、不重启，可以安全地在任何环境里跑，用来确认路径解析结果。

---

## 相关文件

| 文件 | 作用 |
| --- | --- |
| [`scripts/deploy.mjs`](../scripts/deploy.mjs) | 统一入口：参数解析、构建、目标分发、报告 |
| [`scripts/lib/deploy-config.mjs`](../scripts/lib/deploy-config.mjs) | `.env` 读取、环境变量优先级、路径解析 |
| [`scripts/lib/deploy-lib.mjs`](../scripts/lib/deploy-lib.mjs) | 哈希、ADB 封装、注册表编辑、bundle staging |
| [`scripts/lib/build.mjs`](../scripts/lib/build.mjs) | 生产 / 开发两种构建 |
| [`scripts/targets/windows.mjs`](../scripts/targets/windows.mjs) | 桌面复制、进程检查、注册表启用 |
| [`scripts/targets/android.mjs`](../scripts/targets/android.mjs) | ADB 推送、哈希校验、轮换与去重 |
| [`test/deploy.test.ts`](../test/deploy.test.ts) | 路径解析、`.env`、轮换命名、注册表编辑的回归测试 |

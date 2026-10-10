# DSH 语音输入（SenseVoice）onnxruntime 冲突修复

## 一、症状

在 DeepSeek Harness 里启用语音输入（SenseVoice 本地识别）时报：

```
Speech worker exited before readiness: The requested API version [28] is not available, only API versio…
```

这条提示被主机截断了。worker 真正的 stderr 是完整的：

```
The requested API version [28] is not available, only API versions [1, 17] are supported in this build. Current ORT Version is: 1.17.1
```

（`Current ORT Version is: 1.17.1` 后面的内容说明了罪魁祸首，见下。）

## 二、根因

语音插件 `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` 会启动一个独立 worker 进程：

```
"DeepSeek Harness.exe"            # ELECTRON_RUN_AS_NODE=1，即 node 模式
  <app.asar>/…/speech-to-text-sensevoice/lib/worker.js  <json 配置>
```

worker 里 `require('sherpa-onnx-node')` → `sherpa-onnx.node` → `sherpa-onnx-c-api.dll` → **`onnxruntime.dll`**。

关键点：

| 位置 | 版本 | 支持的 ORT API |
| --- | --- | --- |
| 随包分发：`…\app.asar.unpacked\dsh\node_modules\sherpa-onnx-win-x64\onnxruntime.dll` | **1.28.2** | 1 – **28** ✅ |
| 系统自带：`C:\Windows\System32\onnxruntime.dll`（Windows ML / Windows AI Machine Learning 组件） | **1.17.1** | 1 – **17** ❌ |

`sherpa-onnx-c-api.dll` 是以 **DLL 名**（而不是绝对路径）导入 `onnxruntime.dll` 的。在这台机器上，这个名字被解析到了 System32 里 Windows ML 自带的那份 1.17.1，而 sherpa 的 addon 是按 ONNX Runtime 1.28 头文件编译的、启动时索要 API 版本 28 —— 1.17.1 给不出来，于是返回空指针、worker 直接退出。

已经排除的猜测：

* **不是** 模型/下载损坏：`%USERPROFILE%\.dsh\speech-to-text\sensevoice\models` 里 239 MB 的 `model.int8.onnx`、`tokens.txt`、`silero_vad.onnx` 都在，校验通过。
* **不是** Electron 引起的：用全新的普通 `node.exe` 加载同一个 addon（旁边就放着随包的 1.28.2）也会报一模一样的错。
* **不是** 麦克风/权限/设置问题。
* 把 1.28.2 复制到 exe 所在目录（应用目录）也无效——这一层导入并不走常规搜索顺序。

为什么只能靠预加载解决：Windows 加载 DLL 的依赖时，**不会**搜索该 DLL 自己所在的目录；System32 里的同名 DLL 会先被命中。唯一可靠的办法是在 `onnxruntime.dll` 这个名字被解析之前，**先按绝对路径把随包的那份映射进本进程**——一旦进程里已有 `onnxruntime.dll`，后续按名导入就会绑定到它。

## 三、本机已做的修复

1. 安装了预加载 shim：

   ```
   C:\Users\i\.dsh\speech-ort-fix\ort-preload.node   # 极小原生 DLL，只做 LoadLibraryW("<随包 onnxruntime.dll>")
   C:\Users\i\.dsh\speech-ort-fix\preload.cjs        # 守卫型加载器，只在 DSH 语音 worker 进程里生效
   ```

2. 写入了用户级环境变量（幂等，保留已有内容）：

   ```
   NODE_OPTIONS = --require C:\Users\i\.dsh\speech-ort-fix\preload.cjs
   ```

DSH 的 `dsh-subprocess` 会把父进程环境（去掉 `*KEY*/*PASSWORD*/*SECRET*/*TOKEN*` 与 `DSH_*`）传给子进程，`NODE_OPTIONS` 会原样到达 worker；`--require` 在 worker 加载业务代码之前执行，于是 ORT 1.28.2 先被映射，`sherpa-onnx-c-api.dll` 的按名导入就会绑定到它。

安全边界：

* `preload.cjs` 只在 `process.execPath` 含 `DeepSeek Harness` 且命令行含 `speech-to-text` 时才动作，其它 Node/Electron 程序（VS Code、npm 等）只是多加载一个小模块，行为完全不变（已实测普通 `node` 进程无副作用）。
* 随包 ORT 的路径是从 `process.execPath` 推导的，所以 **DSH 升级后依然有效**，不需要重新打补丁。
* 若 DSH 将来改了插件目录名/进程形态，守卫条件不匹配，修复会自动静默失效（语音输入回到报错状态，不会波及其它功能）。

## 四、验证 / 卸载 / 重装

```powershell
$fix = 'C:\Users\i\work\Projects\mineral-obsidian-sync\tools\ort-preload'

# 端到端验证：按主进程的方式拉起 worker，就绪会打印 {"port":N}
pwsh -File "$fix\verify.ps1"              # 期望 PASS
pwsh -File "$fix\verify.ps1" -Baseline    # 对照：不带修复，期望复现 [1, 17] 报错

# 卸载（去掉 NODE_OPTIONS 里的条目；加 -RemoveFiles 连目录一起删）
pwsh -File "$fix\uninstall.ps1" -RemoveFiles

# 重新安装 / 其它机器安装
pwsh -File "$fix\install.ps1"

# 需要重建 shim 时（需要 VS 的 C++ 生成工具）
pwsh -File "$fix\build.ps1"
```

**必须完全退出并重启 DSH** 才会读到新的用户级环境变量，然后重新打开语音输入。

> 注意：卸载时请用 `uninstall.ps1`。如果只手动删掉 `preload.cjs` 而 `NODE_OPTIONS` 仍指向它，Node 系程序会因为 `--require` 找不到文件而启动失败。

## 五、给上游的 bug 报告（可直接提交）

> **标题**：Windows 上 SenseVoice 语音 worker 必然失败：`onnxruntime.dll` 被解析到 System32 的 Windows ML 1.17.1，而不是随包的 1.28.2
>
> **环境**：DSH Desktop nightly win-x64（Electron 44.0.0），Windows 11 26100
>
> **现象**：启用语音输入报 `Speech worker exited before readiness: The requested API version [28] is not available, only API versions [1, 17] are supported in this build. Current ORT Version is: 1.17.1`。模型已完整下载（239 MB int8 + Silero VAD），与网络/权限无关。
>
> **复现**（脱离 DSH GUI 亦可复现）：
> ```powershell
> $env:ELECTRON_RUN_AS_NODE='1'; $env:DSH_SPEECH_TOKEN=('a'*64)
> & 'C:\…\DeepSeek Harness.exe' 'C:\…\app.asar\dsh\node_modules\@deepseek-ai\dsh-experimental-speech-to-text-sensevoice\lib\worker.js' '<json 配置>'
> ```
> 结果：`Current ORT Version is: 1.17.1`。用普通 `node.exe` 直接 `require` 同一份 addon 同样复现，说明与 Electron 无关。
>
> **根因**：`sherpa-onnx-c-api.dll` 以 DLL 名导入 `onnxruntime.dll`；Windows 解析该依赖时不会搜索 DLL 自身目录（`app.asar.unpacked\…\sherpa-onnx-win-x64\` 里的 1.28.2 因此被忽略），System32 中 Windows ML 自带的 1.17.1 抢先命中。addon 按 ORT 1.28 编译，索要 API 28 失败即崩溃。已验证：在加载 addon 之前按绝对路径 `LoadLibrary` 随包 `onnxruntime.dll`（进程内已有同名模块，后续按名导入即绑定到它），worker 能正常就绪。
>
> **建议修法（任一）**：
> 1. worker 启动早期用绝对路径预加载 `<runtime>/sherpa-onnx-win-x64/onnxruntime.dll`（例如一个 N-API shim，或在 `createTranscriber` 之前执行；本仓库的 `ort-preload.cpp` 就是 30 行的实现）。
> 2. 把随包 ORT 改成私有名字（如 `sherpa-ort.dll`）并同步改 `sherpa-onnx-c-api.dll` 的导入名，彻底避开同名冲突。
> 3. 让 sherpa addon 静态链接 ORT，或以完整路径加载。
>
> **附带问题**：用户界面把 worker stderr 截断成了 `only API versio`，恰好丢掉了能定位问题的 `[1, 17]` 与 `Current ORT Version is: 1.17.1`，建议放宽截断长度或把完整 stderr 写进日志。

## 六、目录内容

| 文件 | 说明 |
| --- | --- |
| `ort-preload.cpp` | shim 源码：只做一件事——按绝对路径 `LoadLibraryW` 随包 ORT（可用 `DSH_ORT_PRELOAD` 覆盖路径） |
| `ort-preload.node` | 已编译的 x64 shim（`process.dlopen` 可加载） |
| `preload.cjs` | 守卫型加载器：仅在 DSH 语音 worker 进程内设置 `DSH_ORT_PRELOAD` 并加载 shim |
| `install.ps1` / `uninstall.ps1` | 安装 / 卸载（复制文件 + 维护用户级 `NODE_OPTIONS`） |
| `verify.ps1` / `worker-launch.cjs` | 端到端验证；`-Baseline` 复现原始报错 |
| `build.ps1` | 用 `cl.exe` 重新编译 shim |

<#
    安装 DSH 语音输入（SenseVoice）ONNX Runtime 预加载修复。

    作用：在 DSH 语音 worker 进程启动早期，按绝对路径把随包分发的 onnxruntime.dll (1.28.2)
    映射进进程，避免 sherpa-onnx 对 "onnxruntime.dll" 的按名导入被
    C:\Windows\System32\onnxruntime.dll（Windows ML 自带，1.17.1，只支持 API <= 17）抢占。

    做法：把 ort-preload.node + preload.cjs 复制到稳定的用户目录，并把
    --require <preload.cjs> 追加进用户级环境变量 NODE_OPTIONS（幂等，保留已有内容）。
#>
[CmdletBinding()]
param(
    [string]$Destination = (Join-Path $env:USERPROFILE '.dsh\speech-ort-fix')
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

foreach ($file in 'ort-preload.node', 'preload.cjs') {
    if (-not (Test-Path (Join-Path $here $file))) { throw "缺少文件: $(Join-Path $here $file)" }
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Copy-Item (Join-Path $here 'ort-preload.node') $Destination -Force
Copy-Item (Join-Path $here 'preload.cjs') $Destination -Force

$entry = "--require " + (Join-Path $Destination 'preload.cjs')
$current = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'User')
if (-not $current) {
    $new = $entry
} elseif ($current -like "*$entry*") {
    $new = $current
} else {
    $new = "$current $entry"
}
[Environment]::SetEnvironmentVariable('NODE_OPTIONS', $new, 'User')

Write-Host "已安装:      $Destination"
Write-Host "NODE_OPTIONS: $new"
Write-Host ''
Write-Host '下一步：完全退出并重新启动 DeepSeek Harness（用户级环境变量只对新进程生效），'
Write-Host '然后重新打开语音输入。用 verify.ps1 可以直接验证 worker 能否就绪。'

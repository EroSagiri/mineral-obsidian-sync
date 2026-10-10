<#
    端到端验证：按 DSH 主进程的方式启动 SenseVoice 语音 worker，等待它就绪（打印 {"port":N}）。

    用法:
      pwsh -File verify.ps1              # 验证修复生效
      pwsh -File verify.ps1 -Baseline    # 不加载修复，复现原始报错（对照）
#>
[CmdletBinding()]
param(
    [string]$DshRoot = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
    [int]$TimeoutSeconds = 240,
    [switch]$Baseline
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$exe = Join-Path $DshRoot 'DeepSeek Harness.exe'
$worker = Join-Path $DshRoot 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-experimental-speech-to-text-sensevoice\lib\worker.js'
$modelDir = Join-Path $env:USERPROFILE '.dsh\speech-to-text\sensevoice\models\sensevoice-onnx'
$vadDir = Join-Path $env:USERPROFILE '.dsh\speech-to-text\sensevoice\models\silero'

# worker.js 位于 app.asar 内部，PowerShell 无法直接探测，只能确认归档与模型存在。
foreach ($p in $exe, (Join-Path $DshRoot 'resources\app.asar'), (Join-Path $modelDir 'model.int8.onnx'), (Join-Path $modelDir 'tokens.txt'), (Join-Path $vadDir 'silero_vad.onnx')) {
    if (-not (Test-Path -LiteralPath $p)) { throw "找不到 $p（模型需先由插件下载完成）" }
}

$work = Join-Path $env:TEMP 'dsh-speech-verify'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$specPath = Join-Path $work 'spec.json'
$outPath = Join-Path $work 'out.txt'
$errPath = Join-Path $work 'err.txt'
Remove-Item $outPath, $errPath -ErrorAction SilentlyContinue

$spec = @{
    exe              = $exe
    worker           = $worker
    cwd              = (Join-Path $env:USERPROFILE '.dsh\speech-to-text\sensevoice')
    stripNodeOptions = [bool]$Baseline
    config           = @{
        providerId     = 'sensevoice-local'
        dataRoot       = (Join-Path $env:USERPROFILE '.dsh\speech-to-text\sensevoice')
        modelDirectory = $modelDir
        vadModelPath   = (Join-Path $vadDir 'silero_vad.onnx')
        precision      = 'int8'
        threads        = 2
        model          = (Join-Path $modelDir 'model.int8.onnx')
        tokens         = (Join-Path $modelDir 'tokens.txt')
        vad            = (Join-Path $vadDir 'silero_vad.onnx')
    }
}
$spec | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $specPath -Encoding utf8

# 子进程从当前进程继承环境，这里显式带上已安装的用户级 NODE_OPTIONS（-Baseline 时由 launcher 去掉）。
$env:NODE_OPTIONS = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'User')
Write-Host "模式            : $(if ($Baseline) { 'Baseline（不带修复）' } else { '修复后' })"
Write-Host "NODE_OPTIONS    : $($env:NODE_OPTIONS)"

$wrapper = Start-Process node -ArgumentList @((Join-Path $here 'worker-launch.cjs'), $specPath) -PassThru -NoNewWindow `
    -RedirectStandardOutput $outPath -RedirectStandardError $errPath

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$port = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $text = Get-Content -LiteralPath $outPath -Raw -ErrorAction SilentlyContinue
    if ($text -and $text -match '\{"port":(\d+)\}') { $port = [int]$Matches[1]; break }
    if ($wrapper.HasExited) { break }
}

$out = Get-Content -LiteralPath $outPath -Raw -ErrorAction SilentlyContinue
$err = Get-Content -LiteralPath $errPath -Raw -ErrorAction SilentlyContinue
Write-Host '--- worker stdout ---'; if ($out) { Write-Host $out.Trim() }
Write-Host '--- worker stderr ---'; if ($err) { Write-Host $err.Trim() }

if ($port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conn) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Stop-Process -Id $wrapper.Id -Force -ErrorAction SilentlyContinue

if ($port) {
    Write-Host ''
    Write-Host "PASS: 语音 worker 已就绪（127.0.0.1:$port）"
    exit 0
}
Write-Host ''
Write-Host 'FAIL: worker 未在超时前就绪'
exit 1

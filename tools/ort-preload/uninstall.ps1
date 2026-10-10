<#
    卸载 ONNX Runtime 预加载修复（默认保留 %USERPROFILE%\.dsh\speech-ort-fix 里的文件）。

    -RemoveFiles 同时删除该目录。
#>
[CmdletBinding()]
param(
    [string]$Destination = (Join-Path $env:USERPROFILE '.dsh\speech-ort-fix'),
    [switch]$RemoveFiles
)

$ErrorActionPreference = 'Stop'
$shim = Join-Path $Destination 'preload.cjs'
$entry = "--require $shim"
$current = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'User')

if (-not $current) {
    Write-Host '用户级 NODE_OPTIONS 本来就是空的，无需清理。'
} else {
    $new = ($current -replace [regex]::Escape($entry), '').Trim()
    if ([string]::IsNullOrWhiteSpace($new)) {
        [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $null, 'User')
        Write-Host '已移除用户级 NODE_OPTIONS。'
    } else {
        [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $new, 'User')
        Write-Host "已从 NODE_OPTIONS 中移除本修复，保留其余内容: $new"
    }
}

if ($RemoveFiles -and (Test-Path -LiteralPath $Destination)) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
    Write-Host "已删除 $Destination"
}

Write-Host '完全重启 DeepSeek Harness 后生效。'

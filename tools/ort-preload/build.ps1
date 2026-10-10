<#
    重新编译 ort-preload.node（仅在需要重建 shim 时使用，需要 Visual Studio 的 C++ 生成工具）。

    用法: pwsh -File build.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$vcvars = Get-ChildItem 'C:\Program Files*\Microsoft Visual Studio\*\*\VC\Auxiliary\Build\vcvars64.bat' -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $vcvars) { throw '未找到 vcvars64.bat，请安装 Visual Studio 的“使用 C++ 的桌面开发”工作负载。' }

Push-Location $here
try {
    cmd /c "call `"$vcvars`" >nul 2>&1 && cl /nologo /LD /O2 ort-preload.cpp /Fe:ort-preload.dll"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $here 'ort-preload.dll'))) { throw 'cl 编译失败。' }
    Copy-Item (Join-Path $here 'ort-preload.dll') (Join-Path $here 'ort-preload.node') -Force
    Remove-Item (Join-Path $here 'ort-preload.obj'), (Join-Path $here 'ort-preload.lib'), (Join-Path $here 'ort-preload.exp') -ErrorAction SilentlyContinue
    Write-Host "已生成: $(Join-Path $here 'ort-preload.node')"
} finally {
    Pop-Location
}

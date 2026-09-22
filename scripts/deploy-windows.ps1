param(
  [string]$Vault = "C:\Users\i\work\文档\obsidian\quartz\mineral"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$pluginId = "mineral-obsidian-sync"
$target = Join-Path $Vault ".obsidian\plugins\$pluginId"

Push-Location $projectRoot
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Build failed." }
  if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw "Obsidian plugin directory does not exist: $target" }

  foreach ($name in @("main.js", "manifest.json")) {
    $source = Join-Path $projectRoot $name
    $destination = Join-Path $target $name
    Copy-Item -LiteralPath $source -Destination $destination -Force
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    $destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    if ($sourceHash -ne $destinationHash) { throw "Hash verification failed for $name" }
    Write-Host "Installed $name SHA-256 $destinationHash"
  }
  Write-Host "Windows deployment complete: $target"
  Write-Host "Reload Obsidian or restart it before testing this bundle."
} finally {
  Pop-Location
}

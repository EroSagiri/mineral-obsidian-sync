#Requires -Version 5.1
<#
.SYNOPSIS
  Deploy the plugin to a desktop Obsidian vault.

.DESCRIPTION
  Thin wrapper: all logic lives in scripts/deploy.mjs so Windows, Android and CI
  share one implementation. Configure the target directory with environment
  variables (shell or .env), then call this script.

      $env:MINERAL_DEPLOY_WINDOWS_VAULT = "C:\Users\me\Documents\MyVault"
      ./scripts/deploy-windows.ps1

  Environment variables (shell first, then .env / .env.local):

      MINERAL_DEPLOY_WINDOWS_VAULT   vault root directory              (required)
      MINERAL_DEPLOY_PLUGIN_ID       plugin folder name                (default: mineral-obsidian-sync)
      MINERAL_DEPLOY_PLUGIN_FILES    artifacts to copy                  (default: main.js manifest.json)
      MINERAL_DEPLOY_BUILD           production | development          (default: production)
      MINERAL_DEPLOY_SKIP_BUILD      true to reuse the existing bundle
      MINERAL_DEPLOY_KILL_OBSIDIAN   true to stop a running Obsidian first
      MINERAL_DEPLOY_RESTART_OBSIDIAN true to relaunch Obsidian afterwards
      MINERAL_DEPLOY_DRY_RUN         true to print the plan without writing

.EXAMPLE
  ./scripts/deploy-windows.ps1 -DryRun
  ./scripts/deploy-windows.ps1 -Vault "D:\vaults\work" -Restart
  $env:MINERAL_DEPLOY_WINDOWS_VAULT = "D:\vaults\work"; ./scripts/deploy-windows.ps1 -Create

.NOTES
  Extra arguments are forwarded to scripts/deploy.mjs verbatim.
#>
[CmdletBinding()]
param(
  # Vault root. Equivalent to --vault / MINERAL_DEPLOY_WINDOWS_VAULT.
  [string]$Vault,
  # Vault root as a positional argument (first positional parameter wins).
  [Parameter(Position = 0)][string]$VaultPath,
  # Deploy the development bundle (self-test harness included).
  [switch]$Dev,
  # Print the plan without building, writing or restarting anything.
  [switch]$DryRun,
  # Reuse the bundle already on disk instead of rebuilding.
  [switch]$SkipBuild,
  # Relaunch Obsidian after the copy so the new bundle is loaded.
  [switch]$Restart,
  # Create the plugin directory when the vault has never had the plugin installed.
  [switch]$Create,
  # Stop a running Obsidian before copying (recommended when it is open).
  [switch]$KillObsidian,
  # Write a JSON report of the deployment.
  [switch]$Report,
  # Any further arguments are passed to scripts/deploy.mjs unchanged.
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Extra
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

$arguments = @((Join-Path $PSScriptRoot "deploy.mjs"), "--target", "windows")
$effectiveVault = if ($Vault) { $Vault } elseif ($VaultPath) { $VaultPath } else { $null }
if ($effectiveVault) { $arguments += @("--vault", $effectiveVault) }
if ($PSBoundParameters.ContainsKey("Dev")) { $arguments += "--dev" }
if ($PSBoundParameters.ContainsKey("DryRun")) { $arguments += "--dry-run" }
if ($PSBoundParameters.ContainsKey("SkipBuild")) { $arguments += "--skip-build" }
if ($PSBoundParameters.ContainsKey("Restart")) { $arguments += "--restart" }
if ($PSBoundParameters.ContainsKey("Create")) { $arguments += "--create" }
if ($KillObsidian) { $env:MINERAL_DEPLOY_KILL_OBSIDIAN = "true" }
if ($Report) { $arguments += @("--report", (Join-Path $projectRoot "last-deploy.json")) }
if ($Extra) { $arguments += $Extra }

Push-Location $projectRoot
try {
  & node @arguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

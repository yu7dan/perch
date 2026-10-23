#Requires -Version 5.1
<#
.SYNOPSIS
  Build a portable friend-beta zip for Windows x64.

.DESCRIPTION
  Builds perch.exe and perch-hook.exe with -Release, stages them next to the
  docs/licenses they must ship with, then writes dist\Perch-<Version>-win-x64.zip.
  No installer, no signing yet -- the zip is meant to be extracted and run.

.PARAMETER Version
  Version written into the binary and the zip name.

.PARAMETER SkipBuild
  Reuse whatever is already in build\ (useful when only the staging changed).
#>
param(
  [string]$Version = "0.1.0-beta.1",
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = Split-Path $PSScriptRoot -Parent
$build = Join-Path $repo "build"
$dist = Join-Path $repo "dist"
$name = "Perch-$Version-win-x64"
$stage = Join-Path $dist $name
$zip = Join-Path $dist "$name.zip"

if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot "build.ps1") -Version $Version -Release
  if ($LASTEXITCODE -ne 0) { throw "build.ps1 failed (exit $LASTEXITCODE)" }
}

foreach ($exe in @("perch.exe", "perch-hook.exe")) {
  $p = Join-Path $build $exe
  if (-not (Test-Path $p)) { throw "missing $p -- run the build first" }
}

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null

Copy-Item (Join-Path $build "perch.exe") $stage
Copy-Item (Join-Path $build "perch-hook.exe") $stage
Copy-Item (Join-Path $repo "README.md") $stage
Copy-Item (Join-Path $repo "LICENSE") $stage
Copy-Item (Join-Path $repo "THIRD-PARTY.md") $stage
Copy-Item (Join-Path $repo "docs\START-HERE.txt") $stage

# Licenses for binaries and fonts must travel with the build.
New-Item -ItemType Directory -Force (Join-Path $stage "licenses") | Out-Null
Copy-Item (Join-Path $repo "licenses\*") (Join-Path $stage "licenses") -Recurse
# README screenshots are linked from README.md.
New-Item -ItemType Directory -Force (Join-Path $stage "docs\images") | Out-Null
Copy-Item (Join-Path $repo "docs\images\*.png") (Join-Path $stage "docs\images")

if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
if ($LASTEXITCODE -ne 0) { throw "Compress-Archive failed" }

$h = Get-FileHash $zip -Algorithm SHA256
"{0}  {1:N1} MB" -f $zip, ((Get-Item $zip).Length / 1MB)
"SHA256  " + $h.Hash

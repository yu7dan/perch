#Requires -Version 5.1
<#
.SYNOPSIS
  Build the single-file Perch release for Windows x64.

.DESCRIPTION
  Builds the hook receiver first, embeds it in perch.exe, and writes exactly
  one user-facing file:

    dist\Perch-<Version>-win-x64.exe

  No zip, docs, licenses, README or second executable enter the download.
  The hook receiver is extracted by Perch to %LOCALAPPDATA%\Perch\bin on
  first run. Permissions/licence text lives in the app's About section and
  the source repository.

.PARAMETER Version
  Version written into the binary and the download filename.

.PARAMETER SkipBuild
  Reuse whatever is already in build\ (useful when only the filename changed).

.PARAMETER BuildDir
  Optional directory containing perch.exe. Defaults to build\.
#>
param(
  [string]$Version = "0.1.0-beta.1",
  [switch]$SkipBuild,
  [string]$BuildDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = Split-Path $PSScriptRoot -Parent
$build = if ($BuildDir) { (Resolve-Path $BuildDir).Path } else { Join-Path $repo "build" }
$dist = Join-Path $repo "dist"
$name = "Perch-$Version-win-x64"
$exe = Join-Path $dist "$name.exe"

if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot "build.ps1") -Version $Version -Release
  if ($LASTEXITCODE -ne 0) { throw "build.ps1 failed (exit $LASTEXITCODE)" }
}

$bin = Join-Path $build "perch.exe"
if (-not (Test-Path $bin)) { throw "missing $bin -- run the build first" }

New-Item -ItemType Directory -Force $dist | Out-Null

# Clean artifacts from the old zip-style package for this version. The user
# package is now one exe; the directory and zip must not linger.
foreach ($old in @(
  (Join-Path $dist $name),
  (Join-Path $dist "$name.zip"),
  (Join-Path $dist "$name.zip.sha256")
)) {
  if (Test-Path $old) { Remove-Item -Recurse -Force $old }
}

Copy-Item $bin $exe -Force
$h = Get-FileHash $exe -Algorithm SHA256
"{0}  {1:N1} MB" -f $exe, ((Get-Item $exe).Length / 1MB)
"SHA256  " + $h.Hash

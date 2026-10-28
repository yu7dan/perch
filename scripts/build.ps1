#Requires -Version 5.1
<#
.SYNOPSIS
  构建 Perch 的两个产物到 build\：主程序与 hook 接收器。

.DESCRIPTION
  仓库根不是程序入口，主程序在 cmd\perch。hook 接收器的文件名写死在代码里
  （hookExeName），两个 exe 必须并排放在同一目录。

.PARAMETER Version
  可选版本号，通过 -ldflags "-X main.buildVersion=..." 写进日志。

.PARAMETER Release
  可选：去掉符号表和调试信息（-s -w），产物更小。
#>
param(
  [string]$Version = "",
  [switch]$Release
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = Split-Path $PSScriptRoot -Parent
$outDir = Join-Path $repo "build"

$go = Get-Command go -ErrorAction SilentlyContinue
if (-not $go) {
  throw "找不到 go.exe。请先安装 Go 1.27+，或把 Go 的 bin 目录加进 PATH。"
}

New-Item -ItemType Directory -Force $outDir | Out-Null

$ldflags = @()
if ($Version) {
  $ldflags += "-X main.buildVersion=$Version"
}
if ($Release) {
  $ldflags += "-s"
  $ldflags += "-w"
  # GUI subsystem: double-clicking the release exe must not create a console
  # window (and must not look like a script). Logs still go to perch.log via
  # teeLogToFile. Keep the dev build as a console app for diagnostics.
  $ldflags += "-H"
  $ldflags += "windowsgui"
}

$common = @("build", "-trimpath")
if ($ldflags.Count -gt 0) {
  $common += @("-ldflags", ($ldflags -join " "))
}

Push-Location $repo
try {
  $env:CGO_ENABLED = "0"

  # Build the hook receiver first and embed it in the main executable. The
  # release is then one file; the receiver is extracted to
  # %LOCALAPPDATA%\Perch\bin on first run.
  & go @common -o (Join-Path $outDir "perch-hook.exe") ./cmd/perch-hook
  if ($LASTEXITCODE -ne 0) { throw "构建 cmd/perch-hook 失败（exit $LASTEXITCODE）" }

  $embedDir = Join-Path $repo "cmd\perch\hookbin"
  New-Item -ItemType Directory -Force $embedDir | Out-Null
  Copy-Item (Join-Path $outDir "perch-hook.exe") (Join-Path $embedDir "perch-hook.exe") -Force

  # Bot Group 的派活命令 perch-bg：agent 在自己的终端里跑它、读它的输出，所以它必须是
  # 控制台程序 —— 不能带 -H windowsgui（那样输出没有地方去）。和 hook 接收器一起内嵌。
  $bgFlags = @($ldflags | Where-Object { $_ -ne "-H" -and $_ -ne "windowsgui" })
  $bgArgs = @("build", "-trimpath")
  if ($bgFlags.Count -gt 0) { $bgArgs += @("-ldflags", ($bgFlags -join " ")) }
  & go @bgArgs -o (Join-Path $outDir "perch-bg.exe") ./cmd/perch-bg
  if ($LASTEXITCODE -ne 0) { throw "构建 cmd/perch-bg 失败（exit $LASTEXITCODE）" }
  Copy-Item (Join-Path $outDir "perch-bg.exe") (Join-Path $embedDir "perch-bg.exe") -Force

  & go @common -tags perch_embedded_hook -o (Join-Path $outDir "perch.exe") ./cmd/perch
  if ($LASTEXITCODE -ne 0) { throw "构建 cmd/perch 失败（exit $LASTEXITCODE）" }
}
finally {
  Pop-Location
}

Get-ChildItem $outDir -Filter *.exe |
  Sort-Object Name |
  ForEach-Object { "{0}  {1:N1} MB" -f $_.Name, ($_.Length / 1MB) }

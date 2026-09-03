# DSH 角色扮演插件 · 一键安装/卸载脚本
# 用法:
#   pwsh install.ps1                     # 安装(可选 -Default 设为默认预设, -Workspace <路径> 指定 DSH 工作区)
#   pwsh install.ps1 -Uninstall          # 卸载(撤销本脚本加的东西; -Presets 一并删除预设目录, -Pet 一并删除桌宠数据)
# 说明: 所有修改先备份(.bak), patch 合并失败自动回滚。DSH 请安装后重启。
[CmdletBinding()]
param(
  [switch]$Default,
  [switch]$Uninstall,
  [string]$Workspace = '',
  [switch]$Presets,
  [switch]$Pet
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$presetRoot = Join-Path $dshHome '.agent-presets'
$profileDir = Join-Path $dshHome 'profiles\web'
$clientDir = Join-Path $profileDir 'node_modules\@ajuwm\dsh-roleplay-plugin'
$legacyClient = Join-Path $profileDir 'node_modules\@dsh-user\roleplay-client'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$settingsFile = Join-Path $dshHome 'settings.yaml'

function Write-Step($msg) { Write-Host ("[roleplay] " + $msg) }

# ── 1. 放置预设 ─────────────────────────────────────────────────────────
function Install-Presets {
  Write-Step '放置角色扮演预设 (恋爱向/朋友向/OC 原创向)...'
  New-Item -ItemType Directory -Force -Path $presetRoot | Out-Null
  foreach ($p in @('roleplay', 'roleplay-friend', 'roleplay-oc')) {
    $src = Join-Path $root "agent-presets\$p"
    if (Test-Path $src) {
      $dst = Join-Path $presetRoot $p
      if (Test-Path $dst) { Write-Step "  已存在: $p (跳过, 不覆盖)" }
      else { Copy-Item $src $dst -Recurse -Force; Write-Step "  已放置: $p" }
    }
  }
}

# ── 2. 放置桌宠资源 ─────────────────────────────────────────────────────
function Install-Pet {
  $src = Join-Path $root 'pet'
  if (-not (Test-Path $src)) { Write-Step 'skip: 包内无 pet/ 目录'; return }
  $petDir = if ($env:DSH_PET_DIR) { $env:DSH_PET_DIR } else {
    $ws = $Workspace
    if (-not $ws) { $ws = Read-Host '请输入 DSH 工作区目录(角色/桌宠数据存放处; 回车 = 跳过桌宠资源)' }
    if (-not $ws.Trim()) { Write-Step 'skip: 未指定工作区, 桌宠资源未放置(可设环境变量 DSH_PET_DIR 后重跑)'; return }
    Join-Path $ws 'pet'
  }
  New-Item -ItemType Directory -Force -Path $petDir | Out-Null
  Copy-Item (Join-Path $src '*') $petDir -Recurse -Force
  Write-Step "桌宠资源已放置: $petDir"
}

# ── 3. 放置侧栏桥接 + 安全合并 patch ───────────────────────────────────
function Install-Client {
  if (-not (Test-Path (Join-Path $root 'lib'))) { Write-Step 'skip: 包内无 lib/'; return }
  # 兼容清理: 旧手动布局(@dsh-user/roleplay-client)一并迁移
  if (Test-Path $legacyClient) {
    Copy-Item $legacyClient ($legacyClient + '.bak') -Recurse -Force
    Remove-Item $legacyClient -Recurse -Force
    Write-Step '  已清理旧版 @dsh-user/roleplay-client (备份 .bak)'
    if (Test-Path $patchFile) {
      $cur = Get-Content $patchFile -Raw
      $cur = $cur -replace '(?s)\r?\n?- insert:\s*\r?\n\s*- id: roleplay-client\s*\r?\n\s*name: ''@dsh-user/roleplay-client''\s*', ''
      Set-Content -Path $patchFile -Value ($cur.TrimEnd()) -Encoding UTF8
      Write-Step '  已移除旧 patch 行'
    }
  }
  Write-Step '放置侧栏桥接 (@ajuwm/dsh-roleplay-plugin)...'
  New-Item -ItemType Directory -Force -Path $clientDir | Out-Null
  if (Test-Path (Join-Path $clientDir 'package.json')) { Copy-Item $clientDir ($clientDir + '.bak') -Recurse -Force }
  Copy-Item (Join-Path $root 'lib') (Join-Path $clientDir 'lib') -Recurse -Force
  Copy-Item (Join-Path $root 'package.json') (Join-Path $clientDir 'package.json') -Force
  Write-Step '合并 cordis.patch.yml...'
  $block = @'
- insert:
    - id: roleplay-client
      name: '@ajuwm/dsh-roleplay-plugin'
'@
  if (-not (Test-Path $patchFile)) {
    Set-Content -Path $patchFile -Value $block -Encoding UTF8
    Write-Step "  patch 已新建: $patchFile"
    return
  }
  $cur = Get-Content $patchFile -Raw
  if ($cur -match '@ajuwm/dsh-roleplay-plugin') { Write-Step '  patch 已包含新包, 跳过'; return }
  # 备份 + 追加 + 立即回滚检查(确保文件仍可被 DSH 读: 至少是以 - 开头的列表或空)
  Copy-Item $patchFile ($patchFile + '.bak') -Force
  try {
    if ($cur.Trim() -ne '' -and -not ($cur -match '(?m)^\s*-\s')) {
      throw "现有 $patchFile 不是条目列表, 请手动合并(内容已备份为 .bak)。"
    }
    $new = $cur.TrimEnd() + "`r`n" + $block
    Set-Content -Path $patchFile -Value $new -Encoding UTF8
    Write-Step '  patch 合并完成 (原文件已备份 .bak)'
  } catch {
    Copy-Item ($patchFile + '.bak') $patchFile -Force
    Write-Step ("patch 合并失败, 已回滚: " + $_.Exception.Message)
    throw
  }
}

# ── 4. 可选默认预设 ─────────────────────────────────────────────────────
function Set-DefaultPreset {
  Write-Step '设置默认预设为 roleplay...'
  $entry = "agent-presets:`r`n  default: roleplay"
  if (-not (Test-Path $settingsFile)) {
    Set-Content -Path $settingsFile -Value $entry -Encoding UTF8
    Write-Step "  settings.yaml 已创建"
    return
  }
  $cur = Get-Content $settingsFile -Raw
  if ($cur -match '(?m)^agent-presets:') {
    if ($cur -match '(?s)agent-presets:\r?\n\s+default: roleplay') { Write-Step '  已是 roleplay, 跳过'; return }
    if ($cur -match '(?m)^\s+default:') { $cur = $cur -replace '(?m)^(\s+default:\s*).*$', ('$1roleplay') }
    else { $cur = $cur + "`r`n" + $entry }
    Copy-Item $settingsFile ($settingsFile + '.bak') -Force
    Set-Content -Path $settingsFile -Value $cur -Encoding UTF8
    Write-Step '  settings.yaml 已更新 (备份 .bak)'
  } else {
    Copy-Item $settingsFile ($settingsFile + '.bak') -Force
    Set-Content -Path $settingsFile -Value ($cur.TrimEnd() + "`r`n" + $entry) -Encoding UTF8
    Write-Step '  settings.yaml 已追加 agent-presets.default (备份 .bak)'
  }
}

# ── 卸载 ────────────────────────────────────────────────────────────────
function Uninstall-All {
  Write-Step '卸载...'
  if ((Test-Path ($patchFile + '.bak')) -and (Test-Path $patchFile)) {
    $cur = Get-Content $patchFile -Raw
    $cur = $cur -replace '(?s)\r?\n?- insert:\s*\r?\n\s*- id: roleplay-client\s*\r?\n\s*name: ''(@dsh-user/roleplay-client|@ajuwm/dsh-roleplay-plugin)''\s*', ''
    $cur = $cur.TrimEnd()
    Set-Content -Path $patchFile -Value $cur -Encoding UTF8
    Write-Step '  patch 行已移除'
  }
  if (Test-Path $clientDir) { Remove-Item $clientDir -Recurse -Force; Write-Step '  roleplay-client 已删除' }
  if ($Presets) {
    foreach ($p in @('roleplay', 'roleplay-friend', 'roleplay-oc')) {
      $dst = Join-Path $presetRoot $p
      if (Test-Path $dst) { Remove-Item $dst -Recurse -Force; Write-Step "  预设 $p 已删除" }
    }
  }
  if ($Pet) {
    foreach ($base in @((Join-Path $Workspace 'pet'), (Join-Path $dshHome 'pet'))) {
      if (Test-Path $base) { Remove-Item $base -Recurse -Force; Write-Step "  桌宠资源已删除: $base" }
    }
  }
  Write-Step '完成。重启 DSH 生效。'
}

# ── main ────────────────────────────────────────────────────────────────
try {
  if ($Uninstall) { Uninstall-All }
  else {
    Write-Host '== DSH 角色扮演插件 安装器 =='
    Install-Presets
    Install-Pet
    Install-Client
    if ($Default) { Set-DefaultPreset }
    Write-Host ''
    Write-Host '安装完成! 请重启 DSH 后刷新页面。如果 DSH 启动异常, 运行: pwsh install.ps1 -Uninstall 一键回滚。'
  }
} catch {
  Write-Host ("[roleplay] 失败: " + $_.Exception.Message) -ForegroundColor Red
  exit 1
}

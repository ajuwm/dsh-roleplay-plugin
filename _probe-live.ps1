# DSH roleplay 插件 · 真机只读探测 (不修改任何数据)
# 覆盖 v1.5.18(记忆/反思) v1.5.19(ST生态/祛魅) v1.5.20(chat修复) 的 host 半接线
$ErrorActionPreference = 'Continue'
$BASE = 'http://127.0.0.1:3080/roleplay'

function Invoke-Roleplay($ep, $body) {
  $json = if ($body) { $body | ConvertTo-Json -Compress -Depth 8 } else { '{}' }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  try {
    return Invoke-RestMethod -Uri "$BASE/$ep" -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
  } catch {
    return [pscustomobject]@{ ok = $false; error = @{ message = $_.Exception.Message } }
  }
}
$script:pass = 0; $script:fail = 0
function Check($name, $cond, $detail) {
  if ($cond) { $script:pass++; Write-Output "  [PASS] $name" }
  else { $script:fail++; Write-Output "  [FAIL] $name $(if ($detail) { '-> ' + $detail })" }
}

# ── 0. 会话发现 ────────────────────────────────────────────────
Write-Output "== 0. 会话发现 =="
$targets = Invoke-Roleplay 'chat-targets'
Check 'bridge /roleplay 可达' ($targets.ok -eq $true) ([string]$targets.error.message)
Check 'chat-targets 返回数组' ($targets.value -is [array]) ($targets.value | Out-String)
$sess = $null
if ($targets.value -and $targets.value.Count -gt 0) {
  $t = $targets.value[0]
  $sess = $t.sessionId
  Check 'peek 返回角色名(非 null)' ([bool]$t.name) "name=$($t.name)"
  Check 'peek enabled=true' ($t.enabled -eq $true) "enabled=$($t.enabled)"
  Write-Output "  -> session=$sess name=$($t.name) lastSeq=$($t.lastSeq)"
}
if (-not $sess) { Write-Output '没有活跃扮演会话,后续检查跳过'; exit 1 }

# ── 1. get-state 字段(v1.5.18/19 新增视图) ─────────────────────
Write-Output "== 1. get-state 新视图 =="
$st = (Invoke-Roleplay 'get-state' @{ sessionId = $sess }).value
Check 'get-state 可用' ([bool]$st)
if ($st) {
  Check 'presets 数组(v1.5.19)' ($st.presets -is [array]) ($st.presets | Out-String)
  Check 'portrait 数组(祛魅画像)' ($st.portrait -is [array]) ($st.portrait | Out-String)
  Check 'memoryView.reflections 数组(v1.5.18)' ($st.memoryView.reflections -is [array])
  Check 'memoryView.long 存在' ($st.memoryView.long -is [array])
  Check 'tierInfo.axes 存在(档内进度)' ($st.tierInfo.axes -is [array])
  Check 'backupInfo 存在' ([bool]$st.backupInfo)
  Check 'character 存在' ([bool]$st.character)
  Write-Output "  -> 角色=$($st.character.name) 关系=$($st.relationStage) 记忆(长驻/长期)=$($st.memoryView.long.Count) 反思=$($st.memoryView.reflections.Count) 画像=$($st.portrait.Count) 预设=$($st.presets.Count)"
  if ($st.portrait.Count -gt 0) {
    $p0 = $st.portrait[0]
    Check '画像条目含 kind/text' ([bool]$p0.kind -and [bool]$p0.text) ($p0 | ConvertTo-Json -Compress)
  }
  if ($st.memoryView.long.Count -gt 0) {
    Write-Output "  -> 长期记忆样例: $($st.memoryView.long[0])"
  }
}

# ── 2. ST 生态端点(v1.5.19) ────────────────────────────────────
Write-Output "== 2. ST 生态端点 =="
$lore = Invoke-Roleplay 'lore-list' @{ sessionId = $sess }
Check 'lore-list 可用(1.5.19 新增端点)' ($lore.ok -eq $true) ([string]$lore.error.message)
if ($lore.ok) {
  Check 'lore-list 返回数组' ($lore.value -is [array])
  $consts = @($lore.value | Where-Object { $_.constant -eq $true })
  Write-Output "  -> 世界书 $($lore.value.Count) 条, 其中常驻(constant) $($consts.Count) 条"
  if ($lore.value.Count -gt 0) { Write-Output "  -> 样例: keys=[$($lore.value[0].keywords -join ',')] constant=$($lore.value[0].constant)" }
}
$pl = Invoke-Roleplay 'preset-list' @{ sessionId = $sess }
Check 'preset-list 可用' ($pl.ok -eq $true) ([string]$pl.error.message)
if ($pl.ok) { Write-Output "  -> 外部预设 $($pl.value.Count) 个$(
  if ($pl.value.Count -gt 0) { '(启用 ' + @($pl.value | Where-Object { $_.enabled }).Count + ')' } else { '' })" }
$po = Invoke-Roleplay 'portrait-list' @{ sessionId = $sess }
Check 'portrait-list 可用' ($po.ok -eq $true) ([string]$po.error.message)
if ($po.ok) { Write-Output "  -> 画像 $($po.value.Count) 条" }
$cl = Invoke-Roleplay 'cards-list' @{ sessionId = $sess }
Check 'cards-list 可用' ($cl.ok -eq $true)
if ($cl.ok -and $cl.value.cards) { Write-Output "  -> 角色卡 $($cl.value.cards.Count) 张" }
$sr = Invoke-Roleplay 'settings-read' $null
Check 'settings-read 可用(DSH设置命名空间)' ($sr.ok -eq $true)
if ($sr.ok -and $sr.value) { Write-Output "  -> 心跳=$($sr.value.heartbeatMinutes)min 叙述=$($sr.value.narrationMode) 难度=$($sr.value.difficulty)" }

# ── 3. PNG 导出往返(v1.5.19,只读:不改卡库) ─────────────────────
Write-Output "== 3. PNG 角色卡导出 =="
$cardName = if ($cl.ok -and $cl.value.cards.Count -gt 0) { $cl.value.cards[0].name } else { $null }
if ($cardName) {
  $png = Invoke-Roleplay 'card-export-png' @{ sessionId = $sess; card = $cardName }
  Check "导出 PNG 成功(卡: $cardName)" ($png.ok -eq $true -and [bool]$png.value.base64) ([string]$png.error.message)
  if ($png.ok -and $png.value.base64) {
    $b = [Convert]::FromBase64String($png.value.base64)
    $sig = ($b[0..7] | ForEach-Object { $_.ToString('x2') }) -join ''
    Check 'PNG 魔数正确' ($sig -eq '89504e470d0a1a0a') "sig=$sig"
    $ascii = [System.Text.Encoding]::Latin1.GetString($b)
    Check 'PNG 内含 chara 块(chara_card_v2)' ($ascii.Contains('chara')) ''
    Check 'PNG 内含角色名' ($ascii.Contains($cardName)) ''
    Write-Output "  -> PNG 大小 $([math]::Round($b.Length/1024,1)) KB"
  }
} else { Write-Output '  (无角色卡,跳过)' }

# ── 4. chat 端点多会话行为(v1.5.20 修复点) ─────────────────────
Write-Output "== 4. chat 端点(v1.5.20) =="
$h = Invoke-Roleplay 'chat-history' @{ target = $sess; limit = 60 }
Check 'chat-history 可用' ($h.ok -eq $true) ([string]$h.error.message)
if ($h.ok) {
  Check 'chat-history 返回 messages 数组' ($h.value.messages -is [array])
  Check 'chat-history 返回 lastSeq' ($null -ne $h.value.lastSeq)
  $roles = @($h.value.messages | Group-Object role | ForEach-Object { "$($_.Name):$($_.Count)" })
  Write-Output "  -> 历史 $($h.value.messages.Count) 条 [$($roles -join ' ')] lastSeq=$($h.value.lastSeq)"
}
$p = Invoke-Roleplay 'chat-poll' @{ target = $sess; since = 0 }
Check 'chat-poll 可用' ($p.ok -eq $true)
if ($p.ok) { Check 'chat-poll 与 chat-history 一致(同会话同 seq)' ($p.value.lastSeq -eq $h.value.lastSeq) "poll=$($p.value.lastSeq) hist=$($h.value.lastSeq)" }

Write-Output ''
Write-Output "======== 真机只读探测: $script:pass 通过 / $script:fail 失败 ========"

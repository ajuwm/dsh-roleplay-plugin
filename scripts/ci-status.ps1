# 查询指定 commit 的 GitHub Actions check-runs（需要 git credential 中有 token）
# 用法: pwsh scripts/ci-status.ps1 [commit-sha]  默认查 origin/main 最新
param([string]$Sha = 'origin/main')
$ErrorActionPreference = 'Stop'
$inputStr = "protocol=https`nhost=github.com`n`n"
$cred = $inputStr | git credential fill 2>$null
$p = $null
foreach ($l in ($cred -split "`n")) { if ($l -match '^password=(.+)$') { $p = $matches[1] } }
if (-not $p) { Write-Error '无法从 git credential 获取 token'; exit 1 }
if ($Sha -eq 'origin/main') { $Sha = (git rev-parse origin/main) }
$h = @{ Authorization = "Bearer $p"; 'User-Agent' = 'dsh-agent'; Accept = 'application/vnd.github+json' }
$runs = Invoke-RestMethod -Uri "https://api.github.com/repos/ajuwm/dsh-roleplay-plugin/commits/$Sha/check-runs" -Headers $h
if (-not $runs.check_runs) { Write-Output "无 check-runs（可能未触发或仍在排队）"; exit 0 }
$anyFail = $false
foreach ($r in $runs.check_runs) {
  $bad = ($r.conclusion -in @('failure', 'cancelled', 'timed_out'))
  $line = "{0} | {1} | {2}" -f $r.name, $r.status, ($r.conclusion -join '')
  if ($bad) { Write-Host $line -ForegroundColor Red; $anyFail = $true } else { Write-Host $line -ForegroundColor Green }
}
if ($anyFail) { Write-Output 'CI FAILED'; exit 1 }
Write-Output 'CI OK'

# roleplay note window (WPF) - sticky-note windows pinned to the desktop at any position.
# Architecture: polls the DSH bridge /roleplay/notes-list (POST), keeps one frameless
# paper window per visible note, reports drag positions via /roleplay/notes-ack pos.
# 视觉: 奶油便利贴 + 顶部胶带 + 深色文字(不用 emoji, 避免 PS5.1 渲染乱码)。
# Usage: powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File note-window.ps1 -Port <dsh-port>
param(
  [int]$Port = 3080,
  [string]$Name = '便签'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

# 单实例互斥: 防止 DSH 重启后旧窗口进程(孤儿)与新进程并存 → 重复便签窗口
$mutex = New-Object System.Threading.Mutex($false, 'Local\DSHRoleplayNoteWindow')
$hasLock = $false
try { $hasLock = $mutex.WaitOne(0) } catch { $hasLock = $true }
if (-not $hasLock) { exit }
$script:failCount = 0
# 版本自检: deskpet 每次启动前写 window-version.txt; 本脚本版本比标记旧 → 自退让位(防旧进程永久霸占)
$script:windowVersion = '1.5.10'
$verTimer = New-Object System.Windows.Threading.DispatcherTimer
$verTimer.Interval = [TimeSpan]::FromSeconds(10)
$verTimer.Add_Tick({
  try {
    $vf = Join-Path $PSScriptRoot 'window-version.txt'
    if (Test-Path -LiteralPath $vf) {
      $v = (Get-Content -LiteralPath $vf -Raw -Encoding UTF8).Trim()
      if ($v -and $v -ne $script:windowVersion) {
        try { $mutex.ReleaseMutex() } catch { }
        exit
      }
    }
  } catch { }
})
$verTimer.Start()

$base = "http://127.0.0.1:$Port/roleplay"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Post-Json([string]$path, $obj) {
  try {
    $body = $obj | ConvertTo-Json -Compress
    return Invoke-RestMethod -Uri ($base + $path) -Method Post -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 5
  } catch {
    return $null
  }
}

function New-Solid([string]$hex) {
  $c = [System.Windows.Media.ColorConverter]::ConvertFromString($hex)
  return New-Object System.Windows.Media.SolidColorBrush($c)
}

$script:wins = New-Object 'System.Collections.Generic.Dictionary[string,object]'
$script:noteRefs = New-Object 'System.Collections.Generic.Dictionary[string,object]'
$script:emptyWin = $null
$script:emptyDismissed = $false

# ---------- note window (便利贴) ----------
function New-NoteWin($note) {
  if ($script:wins.ContainsKey([string]$note.id)) { return }
  # 已读/收起过的便签不再自动弹出(侧栏便签区可查看)
  if ([bool]$note.read) { return }

  $win = New-Object System.Windows.Window
  $win.WindowStyle = [System.Windows.WindowStyle]::None
  $win.AllowsTransparency = $true
  $win.Background = [System.Windows.Media.Brushes]::Transparent
  $win.Topmost = $true
  $win.ShowInTaskbar = $false
  $win.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $win.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
  $win.Width = 300
  $win.Height = 172
  $win.Opacity = 0.98

  $hostGrid = New-Object System.Windows.Controls.Grid

  # 纸张: 奶油色圆角 + 淡棕描边 + 纸影
  $paper = New-Object System.Windows.Controls.Border
  $paper.CornerRadius = New-Object System.Windows.CornerRadius(10)
  $paper.BorderThickness = New-Object System.Windows.Thickness(1)
  $paper.Background = New-Solid '#FFF6D8'
  $paper.BorderBrush = New-Solid '#E6D9AE'
  $shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
  $shadow.BlurRadius = 16
  $shadow.ShadowDepth = 3
  $shadow.Opacity = 0.35
  $shadow.Color = [System.Windows.Media.Colors]::Black
  $paper.Effect = $shadow
  $null = $hostGrid.Children.Add($paper)

  # 顶部胶带(半透明, 微微倾斜)
  $tape = New-Object System.Windows.Controls.Border
  $tape.Width = 132
  $tape.Height = 24
  $tape.CornerRadius = New-Object System.Windows.CornerRadius(3)
  $tape.Background = New-Solid '#F2C978'
  $tape.Opacity = 0.75
  $tape.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Center
  $tape.VerticalAlignment = [System.Windows.VerticalAlignment]::Top
  $tape.Margin = New-Object System.Windows.Thickness(0, -10, 0, 0)
  $tapeRotate = New-Object System.Windows.Media.RotateTransform
  $tapeRotate.Angle = -3
  $tape.RenderTransform = $tapeRotate
  $null = $hostGrid.Children.Add($tape)

  # 内容区
  $content = New-Object System.Windows.Controls.StackPanel
  $content.Margin = New-Object System.Windows.Thickness(18, 26, 18, 14)

  # 标题行: 便签 + 置顶标记 + 右上操作按钮
  $head = New-Object System.Windows.Controls.Grid
  $colT = New-Object System.Windows.Controls.ColumnDefinition
  $colB = New-Object System.Windows.Controls.ColumnDefinition
  $colB.Width = [System.Windows.GridLength]::Auto
  $null = $head.ColumnDefinitions.Add($colT)
  $null = $head.ColumnDefinitions.Add($colB)

  $title = New-Object System.Windows.Controls.TextBlock
  $title.Text = '便签'
  $title.Foreground = New-Solid '#8A7B52'
  $title.FontSize = 11
  $title.FontWeight = [System.Windows.FontWeights]::Medium
  $title.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
  $null = $head.Children.Add($title)

  $btns = New-Object System.Windows.Controls.StackPanel
  $btns.Orientation = [System.Windows.Controls.Orientation]::Horizontal
  $btnClose = New-Object System.Windows.Controls.Button
  $btnClose.Content = '-'
  $btnClose.Width = 24; $btnClose.Height = 24
  $btnClose.Background = [System.Windows.Media.Brushes]::Transparent
  $btnClose.BorderThickness = New-Object System.Windows.Thickness(0)
  $btnClose.Foreground = New-Solid '#8A7B52'
  $btnClose.FontSize = 16
  $btnClose.ToolTip = '关闭(收起,不再自动显示)'
  $null = $btns.Children.Add($btnClose)

  $btnRead = New-Object System.Windows.Controls.Button
  $btnRead.Content = [char]0x2713
  $btnRead.Width = 24; $btnRead.Height = 24
  $btnRead.Background = [System.Windows.Media.Brushes]::Transparent
  $btnRead.BorderThickness = New-Object System.Windows.Thickness(0)
  $btnRead.Foreground = New-Solid '#6F8F6F'
  $btnRead.FontSize = 14
  $btnRead.ToolTip = '已读'
  $null = $btns.Children.Add($btnRead)

  $btnDel = New-Object System.Windows.Controls.Button
  $btnDel.Content = [char]0x00D7
  $btnDel.Width = 24; $btnDel.Height = 24
  $btnDel.Background = [System.Windows.Media.Brushes]::Transparent
  $btnDel.BorderThickness = New-Object System.Windows.Thickness(0)
  $btnDel.Foreground = New-Solid '#C07969'
  $btnDel.FontSize = 15
  $btnDel.Margin = New-Object System.Windows.Thickness(2, 0, 0, 0)
  $btnDel.ToolTip = '删除'
  $null = $btns.Children.Add($btnDel)

  [System.Windows.Controls.Grid]::SetColumn($btns, 1)
  $null = $head.Children.Add($btns)
  $null = $content.Children.Add($head)

  # 正文
  $txt = New-Object System.Windows.Controls.TextBlock
  $txt.Text = [string]$note.text
  $txt.Foreground = New-Solid '#4A3F28'
  $txt.FontSize = 14
  $txt.TextWrapping = [System.Windows.TextWrapping]::Wrap
  $txt.Margin = New-Object System.Windows.Thickness(0, 6, 0, 4)
  $txt.MaxHeight = 66
  $null = $content.Children.Add($txt)

  # 底部: 时间 + 到期
  $meta = New-Object System.Windows.Controls.TextBlock
  $meta.Text = ([string]$note.at).Substring(0, [Math]::Min(16, ([string]$note.at).Length))
  if ($note.expiresAt) { $meta.Text += '  ·  到期提醒' }
  $meta.Foreground = New-Solid '#A0916C'
  $meta.FontSize = 10
  $meta.Margin = New-Object System.Windows.Thickness(0, 4, 0, 0)
  $null = $content.Children.Add($meta)

  $null = $hostGrid.Children.Add($content)
  $win.Content = $hostGrid

  # 置顶: 胶带换粉 + 标题加标记; 已读/到期在轮询里更新
  if ([bool]$note.pinned) {
    $tape.Background = New-Solid '#EFAFCE'
    $title.Text = '便签 · 置顶'
  }
  if ([bool]$note.read) {
    $hostGrid.Opacity = 0.55
  }
  $isDue = $false
  if ($note.expiresAt -and [long]$note.expiresAt -gt 0 -and [long]$note.expiresAt -le [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())) {
    $isDue = $true
  }
  if ($isDue) {
    $paper.BorderBrush = New-Solid '#E0A050'
    $paper.Background = New-Solid '#FFF0CE'
    $tape.Background = New-Solid '#E8B060'
  }

  # initial position: saved pos, else scatter along the right edge
  $work = [System.Windows.SystemParameters]::WorkArea
  if ($note.pos -and $null -ne $note.pos.x -and $null -ne $note.pos.y) {
    $win.Left = [double]$note.pos.x
    $win.Top = [double]$note.pos.y
  } else {
    $i = $script:wins.Count
    $win.Left = $work.Right - $win.Width - 24 - ([Math]::Floor($i / 2) * 14)
    $win.Top = $work.Top + 60 + ($i % 5) * 46
  }

  # drag / actions: 事件处理器只引用脚本级状态($this.Tag + $script:noteRefs), 不引用函数局部变量
  $id = [string]$note.id
  $win.Tag = $id
  $btnRead.Tag = $id
  $btnDel.Tag = $id
  $btnClose.Tag = $id
  $win.Add_LocationChanged({
    if (-not $script:locBusy) {
      $script:locBusy = $true
      $script:locTimer = New-Object System.Windows.Threading.DispatcherTimer
      $script:locTimer.Interval = [TimeSpan]::FromMilliseconds(600)
      $script:locTimer.Add_Tick({
        $script:locTimer.Stop()
        $script:locBusy = $false
        $null = Post-Json '/notes-ack' @{ id = $script:lastNoteWin.Tag; action = 'pos'; value = @{ x = [int]$script:lastNoteWin.Left; y = [int]$script:lastNoteWin.Top } }
      })
      $script:lastNoteWin = $this
      $script:locTimer.Start()
    }
  })

  $btnRead.Add_Click({
    $rid = $this.Tag
    $null = Post-Json '/notes-ack' @{ id = $rid; action = 'read' }
    $ref = $script:noteRefs[$rid]
    if ($ref) { $ref.host.Opacity = 0.55 }
  })
  $btnClose.Add_Click({
    $cid2 = $this.Tag
    $null = Post-Json '/notes-ack' @{ id = $cid2; action = 'read' }
    $ref2 = $script:noteRefs[$cid2]
    if ($ref2 -and -not $ref2.win.IsClosed) { $ref2.win.Close() }
  })
  $btnDel.Add_Click({
    $did = $this.Tag
    $null = Post-Json '/notes-ack' @{ id = $did; action = 'delete' }
    $ref = $script:noteRefs[$did]
    if ($ref -and -not $ref.win.IsClosed) { $ref.win.Close() }
  })

  $win.Add_MouseLeftButtonDown({ $this.DragMove() })

  $win.Add_Closed({
    $cid = $this.Tag
    $script:wins.Remove($cid)
    $script:noteRefs.Remove($cid)
  })

  $script:wins[$id] = @{ win = $win; paper = $paper; host = $hostGrid; txt = $txt; note = $note; read = [bool]$note.read }
  $script:noteRefs[$id] = @{ win = $win; paper = $paper; txt = $txt; host = $hostGrid; title = $title }
  $win.Show()
}

function Remove-NoteWin([string]$id) {
  if ($script:wins.ContainsKey($id)) {
    $o = $script:wins[$id]
    if (-not $o.win.IsClosed) { $o.win.Close() }
    $script:wins.Remove($id)
    $script:noteRefs.Remove($id)
  }
}

# ---------- empty placeholder (no notes yet, 可关闭且关闭后不再自动弹出) ----------
function Show-EmptyWin {
  if ($script:emptyDismissed) { return }
  if ($script:emptyWin -and -not $script:emptyWin.IsClosed) { return }
  $win = New-Object System.Windows.Window
  $win.WindowStyle = [System.Windows.WindowStyle]::None
  $win.AllowsTransparency = $true
  $win.Background = [System.Windows.Media.Brushes]::Transparent
  $win.Topmost = $true
  $win.ShowInTaskbar = $false
  $win.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $win.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
  $win.Width = 230
  $win.Height = 104
  $win.Opacity = 0.95
  $work = [System.Windows.SystemParameters]::WorkArea
  $win.Left = $work.Right - $win.Width - 24
  $win.Top = $work.Top + 24
  $b = New-Object System.Windows.Controls.Border
  $b.CornerRadius = New-Object System.Windows.CornerRadius(10)
  $b.BorderThickness = New-Object System.Windows.Thickness(1)
  $b.Background = New-Solid '#FFF6D8'
  $b.BorderBrush = New-Solid '#E6D9AE'
  $shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
  $shadow.BlurRadius = 14
  $shadow.ShadowDepth = 2
  $shadow.Opacity = 0.3
  $shadow.Color = [System.Windows.Media.Colors]::Black
  $b.Effect = $shadow
  $st = New-Object System.Windows.Controls.StackPanel
  $st.Margin = New-Object System.Windows.Thickness(14)
  $t1 = New-Object System.Windows.Controls.TextBlock
  $t1.Text = '便签'
  $t1.Foreground = New-Solid '#8A7B52'
  $t1.FontSize = 12
  $t1.FontWeight = [System.Windows.FontWeights]::Medium
  $null = $st.Children.Add($t1)
  $t2 = New-Object System.Windows.Controls.TextBlock
  $t2.Text = '暂无便签 - 她会在想你时给你留纸条'
  $t2.Foreground = New-Solid '#A0916C'
  $t2.FontSize = 10
  $t2.Margin = New-Object System.Windows.Thickness(0, 5, 0, 0)
  $t2.TextWrapping = [System.Windows.TextWrapping]::Wrap
  $null = $st.Children.Add($t2)
  # 右上角小关闭(事件只引用脚本级状态, 不引用函数局部变量)
  $btnX = New-Object System.Windows.Controls.Button
  $btnX.Content = [char]0x00D7
  $btnX.Width = 22; $btnX.Height = 22
  $btnX.Background = [System.Windows.Media.Brushes]::Transparent
  $btnX.BorderThickness = New-Object System.Windows.Thickness(0)
  $btnX.Foreground = New-Solid '#C07969'
  $btnX.FontSize = 14
  $btnX.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Right
  $btnX.VerticalAlignment = [System.Windows.VerticalAlignment]::Top
  $btnX.Margin = New-Object System.Windows.Thickness(0, 6, 8, 0)
  $btnX.ToolTip = '关闭'
  $btnX.Add_Click({
    $script:emptyDismissed = $true
    if ($script:emptyWin -and -not $script:emptyWin.IsClosed) { $script:emptyWin.Close() }
    $script:emptyWin = $null
  })
  $g2 = New-Object System.Windows.Controls.Grid
  $null = $g2.Children.Add($st)
  $null = $g2.Children.Add($btnX)
  $b.Child = $g2
  $win.Content = $b
  $win.Add_MouseLeftButtonDown({ $this.DragMove() })
  $script:emptyWin = $win
  $win.Show()
}

function Hide-EmptyWin {
  if ($script:emptyWin -and -not $script:emptyWin.IsClosed) { $script:emptyWin.Close() }
  $script:emptyWin = $null
}

# ---------- poll: notes-list (POST per bridge protocol) ----------
$pollTimer = New-Object System.Windows.Threading.DispatcherTimer
$pollTimer.Interval = [TimeSpan]::FromSeconds(5)
$pollTimer.Add_Tick({
  $resp = Post-Json '/notes-list' @{}
  if (-not $resp -or -not $resp.ok) {
    # 孤儿自检: DSH 不在(重启/关闭)时连续失败 5 次 → 自我退出, 让新进程接管(防双实例)
    $script:failCount++
    if ($script:failCount -gt 5) { try { $mutex.ReleaseMutex() } catch {}; exit }
    return
  }
  $script:failCount = 0
  $list = @($resp.value)
  if ($list.Count -eq 0) {
    foreach ($k in @($script:wins.Keys)) { Remove-NoteWin $k }
    Show-EmptyWin
    return
  }
  Hide-EmptyWin
  $seen = @{}
  foreach ($n in $list) {
    $id = [string]$n.id
    $seen[$id] = $true
    if (-not $script:wins.ContainsKey($id)) { New-NoteWin $n; continue }
    $o = $script:wins[$id]
    $o.note = $n
    $o.txt.Text = [string]$n.text
    if ([bool]$n.read -and -not $o.read) {
      $o.read = $true
      $o.host.Opacity = 0.55
    }
    if ([bool]$n.reminded) {
      $o.paper.BorderBrush = New-Solid '#E0A050'
      $o.paper.Background = New-Solid '#FFF0CE'
    }
  }
  foreach ($k in @($script:wins.Keys)) {
    if (-not $seen.ContainsKey($k)) { Remove-NoteWin $k }
  }
})
$pollTimer.Start()

# ---------- main loop (与 pet-window 同款消息泵) ----------
$app = New-Object System.Windows.Application
Show-EmptyWin
$app.Run()

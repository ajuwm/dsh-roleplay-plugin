# roleplay note window (WPF) - sticky-note windows pinned to the desktop at any position.
# Architecture: polls the DSH bridge /roleplay/notes-list (POST), keeps one frameless
# paper window per visible note, reports drag positions via /roleplay/notes-ack pos.
# Usage: powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File note-window.ps1 -Port <dsh-port>
param(
  [int]$Port = 3080,
  [string]$Name = '便签'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

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
$script:emptyWin = $null

# ---------- note window ----------
function New-NoteWin($note) {
  if ($script:wins.ContainsKey([string]$note.id)) { return }

  $win = New-Object System.Windows.Window
  $win.WindowStyle = [System.Windows.WindowStyle]::None
  $win.AllowsTransparency = $true
  $win.Background = [System.Windows.Media.Brushes]::Transparent
  $win.Topmost = $true
  $win.ShowInTaskbar = $false
  $win.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $win.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
  $win.Width = 280
  $win.Height = 150
  $win.Opacity = 0.97

  $border = New-Object System.Windows.Controls.Border
  $border.CornerRadius = New-Object System.Windows.CornerRadius(12)
  $border.BorderThickness = New-Object System.Windows.Thickness(1)
  $border.Background = New-Solid '#1F232CEB'
  $border.BorderBrush = New-Solid '#2A3140AA'
  $border.Margin = New-Object System.Windows.Thickness(0)

  $grid = New-Object System.Windows.Controls.Grid
  $grid.Margin = New-Object System.Windows.Thickness(12, 10, 10, 8)

  # header row: pin glyph + title + buttons
  $head = New-Object System.Windows.Controls.StackPanel
  $head.Orientation = [System.Windows.Controls.Orientation]::Horizontal
  $head.Margin = New-Object System.Windows.Thickness(0, 0, 0, 6)
  $null = $grid.RowDefinitions.Add((New-Object System.Windows.Controls.RowDefinition))
  $null = $grid.RowDefinitions.Add((New-Object System.Windows.Controls.RowDefinition))
  $null = $grid.RowDefinitions.Add((New-Object System.Windows.Controls.RowDefinition))

  $title = New-Object System.Windows.Controls.TextBlock
  $title.Text = '📝 '
  if ([bool]$note.pinned) { $title.Text = '📌 ' }
  $title.Text += '便利贴'
  $title.Foreground = New-Solid '#9AA1B0'
  $title.FontSize = 11
  $title.Margin = New-Object System.Windows.Thickness(0, 0, 8, 0)
  $title.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
  $null = $head.Children.Add($title)

  $btnRead = New-Object System.Windows.Controls.Button
  $btnRead.Content = [char]0x2714
  $btnRead.Width = 24; $btnRead.Height = 22
  $btnRead.Background = [System.Windows.Media.Brushes]::Transparent
  $btnRead.BorderThickness = New-Object System.Windows.Thickness(0)
  $btnRead.Foreground = New-Solid '#8FA8C8'
  $btnRead.FontSize = 12
  $null = $head.Children.Add($btnRead)

  $btnDel = New-Object System.Windows.Controls.Button
  $btnDel.Content = [char]0x2715
  $btnDel.Width = 24; $btnDel.Height = 22
  $btnDel.Background = [System.Windows.Media.Brushes]::Transparent
  $btnDel.BorderThickness = New-Object System.Windows.Thickness(0)
  $btnDel.Foreground = New-Solid '#C87F7F'
  $btnDel.FontSize = 12
  $btnDel.Margin = New-Object System.Windows.Thickness(4, 0, 0, 0)
  $null = $head.Children.Add($btnDel)

  $null = $grid.Children.Add($head)

  $txt = New-Object System.Windows.Controls.TextBlock
  $txt.Text = [string]$note.text
  $txt.Foreground = New-Solid '#F0F1F4'
  $txt.FontSize = 13
  $txt.TextWrapping = [System.Windows.TextWrapping]::Wrap
  $txt.Margin = New-Object System.Windows.Thickness(0, 2, 0, 4)
  [System.Windows.Controls.Grid]::SetRow($txt, 1)
  $null = $grid.Children.Add($txt)

  $meta = New-Object System.Windows.Controls.TextBlock
  $meta.Text = ([string]$note.at).Substring(0, [Math]::Min(16, ([string]$note.at).Length))
  if ($note.expiresAt) { $meta.Text += ' · ⏰ 到期提醒' }
  $meta.Foreground = New-Solid '#8A92A2'
  $meta.FontSize = 10
  $meta.Margin = New-Object System.Windows.Thickness(0, 2, 0, 0)
  [System.Windows.Controls.Grid]::SetRow($meta, 2)
  $null = $grid.Children.Add($meta)

  $border.Child = $grid
  $win.Content = $border

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

  # drag: report position (throttled)
  $dragId = [string]$note.id
  $win.Add_LocationChanged({
    if (-not $script:locBusy) {
      $script:locBusy = $true
      $script:locTimer = New-Object System.Windows.Threading.DispatcherTimer
      $script:locTimer.Interval = [TimeSpan]::FromMilliseconds(600)
      $script:locTimer.Add_Tick({
        $script:locTimer.Stop()
        $script:locBusy = $false
        $null = Post-Json '/notes-ack' @{ id = $dragId; action = 'pos'; value = @{ x = [int]$script:lastNoteWin.Left; y = [int]$script:lastNoteWin.Top } }
      })
      $script:lastNoteWin = $win
      $script:locTimer.Start()
    }
  })

  $btnRead.Add_Click({
    $null = Post-Json '/notes-ack' @{ id = $dragId; action = 'read' }
    $border.Background = New-Solid '#1E232B88'
    $txt.Foreground = New-Solid '#9AA1B0'
  })
  $btnDel.Add_Click({
    $null = Post-Json '/notes-ack' @{ id = $dragId; action = 'delete' }
    $win.Close()
  })

  $win.Add_MouseLeftButtonDown({ $win.DragMove() })

  $win.Add_Closed({ $script:wins.Remove($dragId) })

  $script:wins[[string]$note.id] = @{ win = $win; border = $border; txt = $txt; meta = $meta; note = $note; read = [bool]$note.read }
  $win.Show()
}

function Remove-NoteWin([string]$id) {
  if ($script:wins.ContainsKey($id)) {
    $o = $script:wins[$id]
    if (-not $o.win.IsClosed) { $o.win.Close() }
    $script:wins.Remove($id)
  }
}

# ---------- empty placeholder (no notes yet) ----------
function Show-EmptyWin {
  if ($script:emptyWin -and -not $script:emptyWin.IsClosed) { return }
  $win = New-Object System.Windows.Window
  $win.WindowStyle = [System.Windows.WindowStyle]::None
  $win.AllowsTransparency = $true
  $win.Background = [System.Windows.Media.Brushes]::Transparent
  $win.Topmost = $true
  $win.ShowInTaskbar = $false
  $win.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $win.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
  $win.Width = 220
  $win.Height = 96
  $win.Opacity = 0.92
  $work = [System.Windows.SystemParameters]::WorkArea
  $win.Left = $work.Right - $win.Width - 24
  $win.Top = $work.Top + 24
  $b = New-Object System.Windows.Controls.Border
  $b.CornerRadius = New-Object System.Windows.CornerRadius(12)
  $b.BorderThickness = New-Object System.Windows.Thickness(1)
  $b.Background = New-Solid '#1F232CAA'
  $b.BorderBrush = New-Solid '#2A314088'
  $st = New-Object System.Windows.Controls.StackPanel
  $st.Margin = New-Object System.Windows.Thickness(12)
  $t1 = New-Object System.Windows.Controls.TextBlock
  $t1.Text = '📝 便利贴'
  $t1.Foreground = New-Solid '#9AA1B0'
  $t1.FontSize = 12
  $null = $st.Children.Add($t1)
  $t2 = New-Object System.Windows.Controls.TextBlock
  $t2.Text = '暂无便签 · 她会在想你时给你留纸条'
  $t2.Foreground = New-Solid '#7A8290'
  $t2.FontSize = 10
  $t2.Margin = New-Object System.Windows.Thickness(0, 4, 0, 0)
  $null = $st.Children.Add($t2)
  $b.Child = $st
  $win.Content = $b
  $win.Add_MouseLeftButtonDown({ $win.DragMove() })
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
  if (-not $resp -or -not $resp.ok) { return }
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
    $o.meta.Text = ([string]$n.at).Substring(0, [Math]::Min(16, ([string]$n.at).Length))
    if ($n.expiresAt) { $o.meta.Text += ' · ⏰ 到期提醒' }
    if ([bool]$n.read -and -not $o.read) {
      $o.read = $true
      $o.border.Background = New-Solid '#1E232B88'
      $o.txt.Foreground = New-Solid '#9AA1B0'
    }
    if ([bool]$n.reminded) {
      $o.border.BorderBrush = New-Solid '#C8934AE6'
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

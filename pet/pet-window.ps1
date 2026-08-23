# Desktop pet window (WPF) - HTTP architecture + floating bubble strip above character
# Usage: powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File pet-window.ps1 -Image <png> -Name <name> -Port <dsh-port> [-Config <json>]
param(
  [string]$Image = (Join-Path $PSScriptRoot 'lihui.png'),
  [string]$Name = '桌宠',
  [int]$Port = 3080,
  [string]$Config = (Join-Path $PSScriptRoot 'config.json')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$base = "http://127.0.0.1:$Port/pet"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$script:cfg = $null
$script:cfgWin = $null

function Post-Json([string]$path, $obj) {
  try {
    $body = $obj | ConvertTo-Json -Compress
    return Invoke-RestMethod -Uri ($base + $path) -Method Post -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 5
  } catch {
    return $null
  }
}
function Get-Json([string]$path) {
  try {
    return Invoke-RestMethod -Uri ($base + $path) -Method Get -TimeoutSec 4
  } catch {
    return $null
  }
}

# ---------- config ----------
function Read-Config {
  $def = @{
    enabled = $true
    scale = 0.4
    opacity = 0.95
    topmost = $true
    animate = $true
    position = 'bottom-right'
  }
  try {
    if (Test-Path -LiteralPath $Config) {
      $raw = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($raw) {
        if ($null -ne $raw.enabled) { $def.enabled = [bool]$raw.enabled }
        if ($null -ne $raw.scale) { $def.scale = [double]$raw.scale }
        if ($null -ne $raw.opacity) { $def.opacity = [double]$raw.opacity }
        if ($null -ne $raw.topmost) { $def.topmost = [bool]$raw.topmost }
        if ($null -ne $raw.animate) { $def.animate = [bool]$raw.animate }
        if ($raw.position) { $def.position = [string]$raw.position }
      }
    }
  } catch { }
  return $def
}
function Save-Config {
  try {
    [System.IO.File]::WriteAllText($Config, ($script:cfg | ConvertTo-Json -Compress), $utf8)
  } catch { }
}

$script:cfg = Read-Config

# ---------- window ----------
$win = New-Object System.Windows.Window
$win.Title = $Name
$win.WindowStyle = [System.Windows.WindowStyle]::None
$win.AllowsTransparency = $true
$win.Background = [System.Windows.Media.Brushes]::Transparent
$win.Topmost = [bool]$script:cfg.topmost
$win.ShowInTaskbar = $false
$win.ResizeMode = [System.Windows.ResizeMode]::NoResize
$win.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
$win.Opacity = [double]$script:cfg.opacity

$bmp = New-Object System.Windows.Media.Imaging.BitmapImage
$bmp.BeginInit()
$bmp.UriSource = New-Object System.Uri($Image)
$bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
$bmp.EndInit()

$work = [System.Windows.SystemParameters]::WorkArea
$script:stripH = 110

function Apply-Scale {
  $imgH = [int]($work.Height * [double]$script:cfg.scale)
  $ratio = $imgH / $bmp.PixelHeight
  $win.Width = [int]($bmp.PixelWidth * $ratio)
  $win.Height = $imgH + $script:stripH
  $inputBox.Width = [Math]::Max(120, $win.Width - 96)
  Apply-Position
}
function Apply-Position {
  $m = 12
  switch ([string]$script:cfg.position) {
    'bottom-left' { $win.Left = $work.Left + $m; $win.Top = $work.Bottom - $win.Height - $m }
    'top-right' { $win.Left = $work.Right - $win.Width - $m; $win.Top = $work.Top + $m }
    'top-left' { $win.Left = $work.Left + $m; $win.Top = $work.Top + $m }
    default { $win.Left = $work.Right - $win.Width - $m; $win.Top = $work.Bottom - $win.Height - $m }
  }
}
function Apply-Opacity { $win.Opacity = [double]$script:cfg.opacity }
function Apply-Topmost { $win.Topmost = [bool]$script:cfg.topmost }
function Apply-Animate {
  if ([bool]$script:cfg.animate) { if (-not $bobTimer.IsEnabled) { $bobTimer.Start() } }
  else { $bobTimer.Stop() }
}

# ---------- layout: bubble strip / character / input ----------
$grid = New-Object System.Windows.Controls.Grid
$rowBubble = New-Object System.Windows.Controls.RowDefinition
$rowBubble.Height = [System.Windows.GridLength]::new($script:stripH, [System.Windows.GridUnitType]::Pixel)
$rowImg = New-Object System.Windows.Controls.RowDefinition
$rowImg.Height = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
$rowInput = New-Object System.Windows.Controls.RowDefinition
$rowInput.Height = [System.Windows.GridLength]::Auto
$null = $grid.RowDefinitions.Add($rowBubble)
$null = $grid.RowDefinitions.Add($rowImg)
$null = $grid.RowDefinitions.Add($rowInput)

# bubble: anchored to the BOTTOM of the strip, right side -> floats just above the head
$bubbleBorder = New-Object System.Windows.Controls.Border
$bubbleBorder.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(240, 255, 255, 255))
$bubbleBorder.CornerRadius = New-Object System.Windows.CornerRadius(12)
$bubbleBorder.Padding = New-Object System.Windows.Thickness(10, 6, 10, 6)
$bubbleBorder.Margin = New-Object System.Windows.Thickness(10, 0, 46, 4)
$bubbleBorder.MaxWidth = 270
$bubbleBorder.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Right
$bubbleBorder.VerticalAlignment = [System.Windows.VerticalAlignment]::Bottom
$bubbleBorder.Visibility = [System.Windows.Visibility]::Collapsed
$bubbleText = New-Object System.Windows.Controls.TextBlock
$bubbleText.TextWrapping = [System.Windows.TextWrapping]::Wrap
$bubbleText.FontSize = 13
$bubbleText.Foreground = [System.Windows.Media.Brushes]::Black
$bubbleScroll = New-Object System.Windows.Controls.ScrollViewer
$bubbleScroll.VerticalScrollBarVisibility = [System.Windows.Controls.ScrollBarVisibility]::Auto
$bubbleScroll.HorizontalScrollBarVisibility = [System.Windows.Controls.ScrollBarVisibility]::Disabled
$bubbleScroll.MaxHeight = $script:stripH - 14
$bubbleScroll.Content = $bubbleText
$bubbleBorder.Child = $bubbleScroll
[System.Windows.Controls.Grid]::SetRow($bubbleBorder, 0)
$null = $grid.Children.Add($bubbleBorder)

$img = New-Object System.Windows.Controls.Image
$img.Source = $bmp
$img.Stretch = [System.Windows.Media.Stretch]::Uniform
$eff = New-Object System.Windows.Media.Effects.DropShadowEffect
$eff.BlurRadius = 18
$eff.ShadowDepth = 3
$eff.Opacity = 0.45
$eff.Color = [System.Windows.Media.Colors]::Black
$img.Effect = $eff
[System.Windows.Controls.Grid]::SetRow($img, 1)
$null = $grid.Children.Add($img)

$inputPanel = New-Object System.Windows.Controls.StackPanel
$inputPanel.Orientation = [System.Windows.Controls.Orientation]::Horizontal
$inputPanel.Visibility = [System.Windows.Visibility]::Collapsed
$inputPanel.Margin = New-Object System.Windows.Thickness(6, 2, 6, 8)
$inputBox = New-Object System.Windows.Controls.TextBox
$inputBox.Width = 200
$inputBox.Height = 24
$inputBox.FontSize = 13
$inputBox.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(235, 255, 255, 255))
$sendBtn = New-Object System.Windows.Controls.Button
$sendBtn.Content = '说'
$sendBtn.Width = 46
$sendBtn.Height = 24
$sendBtn.Margin = New-Object System.Windows.Thickness(4, 0, 0, 0)
$null = $inputPanel.Children.Add($inputBox)
$null = $inputPanel.Children.Add($sendBtn)
[System.Windows.Controls.Grid]::SetRow($inputPanel, 2)
$null = $grid.Children.Add($inputPanel)

$win.Content = $grid

# ---------- animations ----------
$translate = New-Object System.Windows.Media.TranslateTransform
$scale = New-Object System.Windows.Media.ScaleTransform
$rotate = New-Object System.Windows.Media.RotateTransform
$tgroup = New-Object System.Windows.Media.TransformGroup
$null = $tgroup.Children.Add($scale)
$null = $tgroup.Children.Add($rotate)
$null = $tgroup.Children.Add($translate)
$grid.RenderTransform = $tgroup
$grid.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 1.0)

$bobTimer = New-Object System.Windows.Threading.DispatcherTimer
$bobTimer.Interval = [TimeSpan]::FromMilliseconds(50)
$script:bobPhase = 0
$bobTimer.Add_Tick({
  $script:bobPhase += 0.055
  $translate.Y = [Math]::Sin($script:bobPhase) * 7
})

# ---------- interaction state ----------
$script:reqSeq = 0
$script:dragging = $false
$script:downPos = $null
$script:winPos = $null
$script:moved = $false
$script:lastTouch = 0
$script:pollId = $null
$script:thinking = $false
$script:reqTime = 0
$script:lastUserText = $null
$script:hideTimer = $null

function New-ReqId {
  $script:reqSeq++
  return ('r' + [DateTime]::UtcNow.Ticks.ToString() + '-' + $script:reqSeq)
}

function Show-Bubble([string]$text) {
  $bubbleText.Text = $text
  $bubbleBorder.Visibility = [System.Windows.Visibility]::Visible
  if ($script:hideTimer) { $script:hideTimer.Stop() }
  $script:hideTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:hideTimer.Interval = [TimeSpan]::FromSeconds(16)
  $script:hideTimer.Add_Tick({
    $bubbleBorder.Visibility = [System.Windows.Visibility]::Collapsed
    $script:hideTimer.Stop()
  })
  $script:hideTimer.Start()
}

function Start-Request([string]$id) {
  $script:pollId = $id
  $script:thinking = $true
  $script:reqTime = [DateTime]::UtcNow.Ticks
}

function Send-Touch([string]$kind) {
  $now = [DateTime]::UtcNow.Ticks
  if (($now - $script:lastTouch) -lt 9000000) { return }
  $script:lastTouch = $now
  $anim = New-Object System.Windows.Media.Animation.DoubleAnimation(1.12, (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(140))))
  $anim.AutoReverse = $true
  $scale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $anim)
  $scale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $anim)
  $rot = New-Object System.Windows.Media.Animation.DoubleAnimation(-3, (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(160))))
  $rot.AutoReverse = $true
  $rotate.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $rot)
  Show-Bubble '……'
  $id = New-ReqId
  $resp = Post-Json '/touch' @{ kind = $kind; id = $id }
  if ($resp -and $resp.ok) {
    Start-Request $id
  } else {
    Show-Bubble '（连不上桌宠服务，戳不动啦）'
  }
}

function Send-Chat {
  $text = $inputBox.Text.Trim()
  if ($text.Length -eq 0) { return }
  $script:lastUserText = $text
  $inputBox.Text = ''
  $inputPanel.Visibility = [System.Windows.Visibility]::Collapsed
  Show-Bubble ("你：$text`n……")
  $id = New-ReqId
  $resp = Post-Json '/chat' @{ text = $text; id = $id }
  if ($resp -and $resp.ok) {
    Start-Request $id
  } else {
    Show-Bubble '（连不上桌宠服务，发不出去）'
  }
}

# ---------- events (window-level drag in screen coords; click-on-image = touch) ----------
$script:downPos = $null
$script:winPos = $null
$script:downOnImage = $false

$win.Add_MouseLeftButtonDown({
  param($s, $e)
  $script:dragging = $true
  $script:moved = $false
  $script:downPos = $win.PointToScreen($e.GetPosition($win))
  $script:winPos = New-Object System.Windows.Point($win.Left, $win.Top)
  $p = $e.GetPosition($img)
  $script:downOnImage = ($p.X -ge 0 -and $p.Y -ge 0 -and $p.X -le $img.ActualWidth -and $p.Y -le $img.ActualHeight)
  $null = $win.CaptureMouse()
})
$win.Add_MouseMove({
  param($s, $e)
  if ($script:dragging) {
    $scr = $win.PointToScreen($e.GetPosition($win))
    $dx = $scr.X - $script:downPos.X
    $dy = $scr.Y - $script:downPos.Y
    if ([Math]::Abs($dx) -gt 4 -or [Math]::Abs($dy) -gt 4) { $script:moved = $true }
    $win.Left = $script:winPos.X + $dx
    $win.Top = $script:winPos.Y + $dy
  }
})
$win.Add_MouseLeftButtonUp({
  param($s, $e)
  $script:dragging = $false
  $win.ReleaseMouseCapture()
  if (-not $script:moved -and $script:downOnImage -and $e.ClickCount -lt 2) { Send-Touch 'pat' }
})
$img.Add_MouseRightButtonUp({
  param($s, $e)
  $ctxMenu.IsOpen = $true
})
$img.Add_MouseLeftButtonDown({
  param($s, $e)
  if ($e.ClickCount -ge 2) {
    if ($inputPanel.Visibility -eq [System.Windows.Visibility]::Visible) {
      $inputPanel.Visibility = [System.Windows.Visibility]::Collapsed
    } else {
      $inputPanel.Visibility = [System.Windows.Visibility]::Visible
      $null = $inputBox.Focus()
    }
  }
})

$sendBtn.Add_Click({ Send-Chat })
$inputBox.Add_KeyDown({
  param($s, $e)
  if ($e.Key -eq [System.Windows.Input.Key]::Enter) { Send-Chat }
})

# ---------- settings window ----------
function Open-Settings {
  if ($script:cfgWin -and $script:cfgWin.IsVisible) {
    $script:cfgWin.Activate()
    return
  }
  $cw = New-Object System.Windows.Window
  $cw.Title = '桌宠设置'
  $cw.Width = 340
  $cw.Height = 330
  $cw.WindowStyle = [System.Windows.WindowStyle]::ToolWindow
  $cw.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $cw.Topmost = $true
  $cw.WindowStartupLocation = [System.Windows.WindowStartupLocation]::CenterOwner
  $cw.Owner = $win
  $cw.ShowInTaskbar = $false

  $panel = New-Object System.Windows.Controls.StackPanel
  $panel.Margin = New-Object System.Windows.Thickness(14)
  $panel.VerticalAlignment = [System.Windows.VerticalAlignment]::Top

  $chkEnabled = New-Object System.Windows.Controls.CheckBox
  $chkEnabled.Content = '启用桌宠'
  $chkEnabled.IsChecked = [bool]$script:cfg.enabled
  $chkEnabled.FontSize = 13
  $chkEnabled.Margin = New-Object System.Windows.Thickness(0, 0, 0, 10)
  $null = $panel.Children.Add($chkEnabled)

  $lblScale = New-Object System.Windows.Controls.TextBlock
  $lblScale.Text = '大小'
  $lblScale.Margin = New-Object System.Windows.Thickness(0, 4, 0, 2)
  $null = $panel.Children.Add($lblScale)
  $sldScale = New-Object System.Windows.Controls.Slider
  $sldScale.Minimum = 0.3
  $sldScale.Maximum = 0.8
  $sldScale.TickFrequency = 0.05
  $sldScale.IsSnapToTickEnabled = $true
  $sldScale.Value = [double]$script:cfg.scale
  $null = $panel.Children.Add($sldScale)

  $lblOpacity = New-Object System.Windows.Controls.TextBlock
  $lblOpacity.Text = '透明度'
  $lblOpacity.Margin = New-Object System.Windows.Thickness(0, 8, 0, 2)
  $null = $panel.Children.Add($lblOpacity)
  $sldOpacity = New-Object System.Windows.Controls.Slider
  $sldOpacity.Minimum = 0.5
  $sldOpacity.Maximum = 1.0
  $sldOpacity.TickFrequency = 0.05
  $sldOpacity.IsSnapToTickEnabled = $true
  $sldOpacity.Value = [double]$script:cfg.opacity
  $null = $panel.Children.Add($sldOpacity)

  $chkTop = New-Object System.Windows.Controls.CheckBox
  $chkTop.Content = '窗口置顶'
  $chkTop.IsChecked = [bool]$script:cfg.topmost
  $chkTop.Margin = New-Object System.Windows.Thickness(0, 10, 0, 0)
  $null = $panel.Children.Add($chkTop)

  $chkAnim = New-Object System.Windows.Controls.CheckBox
  $chkAnim.Content = '待机动画（呼吸浮动）'
  $chkAnim.IsChecked = [bool]$script:cfg.animate
  $chkAnim.Margin = New-Object System.Windows.Thickness(0, 4, 0, 0)
  $null = $panel.Children.Add($chkAnim)

  $lblPos = New-Object System.Windows.Controls.TextBlock
  $lblPos.Text = '初始位置'
  $lblPos.Margin = New-Object System.Windows.Thickness(0, 10, 0, 2)
  $null = $panel.Children.Add($lblPos)
  $cmbPos = New-Object System.Windows.Controls.ComboBox
  $cmbPos.Width = 160
  $cmbPos.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
  $items = @(
    @{ Key = 'bottom-right'; Label = '右下角' },
    @{ Key = 'bottom-left'; Label = '左下角' },
    @{ Key = 'top-right'; Label = '右上角' },
    @{ Key = 'top-left'; Label = '左上角' }
  )
  foreach ($it in $items) {
    $null = $cmbPos.Items.Add($it.Label)
  }
  $sel = -1
  for ($i = 0; $i -lt $items.Count; $i++) { if ($items[$i].Key -eq [string]$script:cfg.position) { $sel = $i } }
  if ($sel -lt 0) { $sel = 0 }
  $cmbPos.SelectedIndex = $sel
  $null = $panel.Children.Add($cmbPos)

  $btnSave = New-Object System.Windows.Controls.Button
  $btnSave.Content = '保存设置'
  $btnSave.Width = 100
  $btnSave.Height = 28
  $btnSave.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
  $btnSave.Margin = New-Object System.Windows.Thickness(0, 16, 0, 0)
  $null = $panel.Children.Add($btnSave)

  $cw.Content = $panel

  $btnSave.Add_Click({
    $wasEnabled = [bool]$script:cfg.enabled
    $script:cfg.enabled = [bool]$chkEnabled.IsChecked
    $script:cfg.scale = [double]$sldScale.Value
    $script:cfg.opacity = [double]$sldOpacity.Value
    $script:cfg.topmost = [bool]$chkTop.IsChecked
    $script:cfg.animate = [bool]$chkAnim.IsChecked
    if ($cmbPos.SelectedIndex -ge 0 -and $cmbPos.SelectedIndex -lt $items.Count) {
      $script:cfg.position = $items[$cmbPos.SelectedIndex].Key
    }
    Save-Config
    Apply-Scale
    Apply-Opacity
    Apply-Topmost
    Apply-Animate
    $cw.Close()
    if (-not [bool]$script:cfg.enabled -and $wasEnabled) {
      $win.Close()
    }
  })

  $script:cfgWin = $cw
  $cw.Add_Closed({ $script:cfgWin = $null })
  $cw.ShowDialog() | Out-Null
}

# ---------- context menu ----------
$ctxMenu = New-Object System.Windows.Controls.ContextMenu
function Add-Menu([string]$header, [scriptblock]$action) {
  $mi = New-Object System.Windows.Controls.MenuItem
  $mi.Header = $header
  $mi.Add_Click($action)
  $null = $ctxMenu.Items.Add($mi)
}
Add-Menu '聊天' { $inputPanel.Visibility = [System.Windows.Visibility]::Visible; $null = $inputBox.Focus() }
Add-Menu '投喂' { try { $null = Post-Json '/feed' (@{} | ConvertTo-Json); Show-Bubble '（你喂她吃了点东西……）' } catch { Show-Bubble '（投喂失败，再试一次？）' } }
Add-Menu '摸头' { Send-Touch 'pat' }
Add-Menu '挠痒痒' { Send-Touch 'tickle' }
Add-Menu '戳一戳' { Send-Touch 'poke' }
Add-Menu '设置' { Open-Settings }
Add-Menu '退出（并停用桌宠）' {
  $script:cfg.enabled = $false
  Save-Config
  $win.Close()
}
$img.ContextMenu = $ctxMenu

# ---------- reply poll (HTTP) ----------
$pollTimer = New-Object System.Windows.Threading.DispatcherTimer
$pollTimer.Interval = [TimeSpan]::FromMilliseconds(600)
$pollTimer.Add_Tick({
  if (-not $script:thinking -or -not $script:pollId) { return }
  $resp = Get-Json ('/poll?id=' + [uri]::EscapeDataString([string]$script:pollId))
  if ($resp -and $resp.status -eq 'done') {
    $script:thinking = $false
    $script:pollId = $null
    if ($script:lastUserText) {
      Show-Bubble ("你：$($script:lastUserText)`n$($resp.text)")
      $script:lastUserText = $null
    } else {
      Show-Bubble ([string]$resp.text)
    }
  } elseif ($resp -and $resp.status -eq 'none') {
    # request was lost (plugin restarted / pending cleared): give up after a short grace
    $elapsed = ([DateTime]::UtcNow.Ticks - $script:reqTime) / 10000000
    if ($elapsed -gt 20) {
      $script:thinking = $false
      $script:pollId = $null
      Show-Bubble '（请求丢失，再试一次？）'
    }
  } else {
    $elapsed = ([DateTime]::UtcNow.Ticks - $script:reqTime) / 10000000
    if ($elapsed -gt 300) {
      $script:thinking = $false
      $script:pollId = $null
      Show-Bubble '（她好像睡着了……）'
    }
  }
})
$pollTimer.Start()

# ---------- bubble murmur poll（角色没来得及说出口的念头） ----------
$bubblePollTimer = New-Object System.Windows.Threading.DispatcherTimer
$bubblePollTimer.Interval = [TimeSpan]::FromSeconds(20)
$bubblePollTimer.Add_Tick({
  if ($script:thinking) { return }
  try {
    $resp = Get-Json '/bubble'
    if ($resp -and $resp.text) { Show-Bubble ([string]$resp.text) }
  } catch { }
})
$bubblePollTimer.Start()

$win.Add_Closed({
  $bobTimer.Stop()
  $pollTimer.Stop()
  $bubblePollTimer.Stop()
})

Apply-Scale
Apply-Animate
$win.ShowDialog() | Out-Null

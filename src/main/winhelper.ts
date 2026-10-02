import { spawn, type ChildProcess } from 'node:child_process'
import { killTree } from './agents'

/**
 * One long-lived PowerShell process shared by the foreground-window watcher, the media controls and the on-device OCR.
 * Each powershell.exe costs ~60–80 MB, so running one instead of three is the single biggest memory saving.
 *
 * stdin commands:  "fg 1|0", "media 1|0", "bt 1|0", "mc toggle|next|prev", "ocr <png path>", "ocr 0"
 * stdout lines:    "F:<process>\x1f<title>\x1f<pid>\x1f<l,t,r,b>"  foreground window changed
 *                  "R:<l,t,r,b>"                                    same window, moved/resized
 *                  "M:<json>"                                       media state
 *                  "O:OK:<base64>" | "O:ERR:<message>"              OCR result (one per "ocr <path>")
 *                  "B:<json>"                                       connected Bluetooth devices + battery (on change)
 */
const SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class IslandFG {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
# Physical pixels, so the main process can map the window onto a screen capture.
[void][IslandFG]::SetProcessDPIAware()
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IInputStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
function Emit($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }

# Connected Bluetooth devices and their battery. The battery lives on a sibling node (e.g. "Hands-Free AG") that shares
# the device's address; "connected" only on the device node itself (other nodes keep stale values).
function Bt {
  $all = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'BTHENUM\\*' -or $_.InstanceId -like 'BTHLE*' })
  $out = @()
  foreach ($d in $all) {
    if ($d.InstanceId -notmatch '^(BTHENUM|BTHLE)\\\\DEV_([0-9A-F]{12})') { continue }
    $mac = $Matches[2]
    $c = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName '{83DA6326-97A6-4088-9453-A1923F573B29} 15' -ErrorAction SilentlyContinue).Data
    if ($c -ne $true) { continue }
    $rel = @($all | Where-Object { $_.InstanceId -like ('*' + $mac + '*') })
    $bat = $null
    foreach ($r in $rel) {
      $b = (Get-PnpDeviceProperty -InstanceId $r.InstanceId -KeyName '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2' -ErrorAction SilentlyContinue).Data
      if ($b -ne $null) { $bat = [int]$b; break }
    }
    $audio = [bool]($rel | Where-Object { $_.InstanceId -match '\\{0000(110B|111E|1108|110D|1203)-' })
    $out += [ordered]@{ name = [string]$d.FriendlyName; battery = $bat; audio = $audio }
  }
  ConvertTo-Json -Compress @($out)
}

# Console.In.ReadLineAsync blocks in Windows PowerShell — a StreamReader on stdin is truly async.
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$pending = $in.ReadLineAsync()

$fgOn = $false; $fgKey = ''; $fgRect = ''; $fgNext = [DateTime]::MinValue; $fgPid = 0; $fgName = ''
$mediaOn = $false; $mgr = $null; $toStream = $null; $mKey = ''; $mTrack = ''; $thumb = $null; $mSent = [DateTime]::MinValue; $mNext = [DateTime]::MinValue
$engine = $null
$btOn = $false; $btNext = [DateTime]::MinValue; $btLast = ''

while ($true) {
  while ($pending.IsCompleted) {
    $cmd = $pending.Result
    if ($cmd -eq $null) { exit }
    $pending = $in.ReadLineAsync()
    if ($cmd -eq 'fg 1') { $fgOn = $true; $fgKey = ''; $fgNext = [DateTime]::MinValue }
    elseif ($cmd -eq 'fg 0') { $fgOn = $false }
    elseif ($cmd -eq 'media 1') { $mediaOn = $true; $mKey = ''; $mTrack = ''; $mNext = [DateTime]::MinValue }
    elseif ($cmd -eq 'media 0') { $mediaOn = $false; $thumb = $null }
    elseif ($cmd -eq 'ocr 0') { $engine = $null; [GC]::Collect() }
    elseif ($cmd -eq 'bt 1') { $btOn = $true; $btNext = [DateTime]::MinValue; $btLast = '' }
    elseif ($cmd -eq 'bt 0') { $btOn = $false }
    elseif ($cmd.StartsWith('mc ')) {
      try {
        if ($mediaOn -and $mgr) {
          $s = $mgr.GetCurrentSession()
          if ($s) {
            $c = $cmd.Substring(3)
            if ($c -eq 'toggle') { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
            elseif ($c -eq 'next') { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
            elseif ($c -eq 'prev') { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
          }
          $mKey = ''; $mNext = [DateTime]::UtcNow.AddMilliseconds(150)
        }
      } catch {}
    }
    elseif ($cmd.StartsWith('ocr ')) {
      # Always answer exactly one line per request so the caller's queue stays in step.
      try {
        if (-not $engine) {
          $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
          $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]
          $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        }
        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($cmd.Substring(4))) ([Windows.Storage.StorageFile])
        $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        try {
          $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
          $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
          $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
          $bitmap.Dispose()
        } finally { $stream.Dispose() }
        $text = ($result.Lines | ForEach-Object { $_.Text }) -join "\`n"
        Emit ('O:OK:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)))
      } catch { Emit ('O:ERR:' + $_.Exception.Message) }
    }
  }

  $now = [DateTime]::UtcNow
  if ($fgOn -and $now -ge $fgNext) {
    $fgNext = $now.AddMilliseconds(1500)
    try {
      $h = [IslandFG]::GetForegroundWindow()
      $sb = New-Object System.Text.StringBuilder 512
      [void][IslandFG]::GetWindowText($h, $sb, 512)
      $procId = 0
      [void][IslandFG]::GetWindowThreadProcessId($h, [ref]$procId)
      if ($procId -ne $fgPid) {
        $fgPid = $procId; $fgName = ''
        try { $fgName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
      }
      $r = New-Object IslandFG+RECT
      $rect = ''
      if ([IslandFG]::GetWindowRect($h, [ref]$r)) { $rect = '' + $r.Left + ',' + $r.Top + ',' + $r.Right + ',' + $r.Bottom }
      $key = $fgName + [char]31 + $sb.ToString() + [char]31 + $procId
      if ($key -ne $fgKey) { $fgKey = $key; $fgRect = $rect; Emit ('F:' + $key + [char]31 + $rect) }
      elseif ($rect -ne $fgRect) { $fgRect = $rect; Emit ('R:' + $rect) }
    } catch {}
  }

  if ($mediaOn -and $now -ge $mNext) {
    $mNext = $now.AddMilliseconds(700)
    try {
      if (-not $mgr) {
        $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
        $toStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [type[]]@([Windows.Storage.Streams.IInputStream]))
        $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
      }
      $s = $mgr.GetCurrentSession()
      if (-not $s) {
        if ($mKey -ne 'none') { $mKey = 'none'; Emit 'M:{"none":true}' }
      } else {
        $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $info = $s.GetPlaybackInfo()
        $tl = $s.GetTimelineProperties()
        $status = [string]$info.PlaybackStatus
        $track = $s.SourceAppUserModelId + '|' + $p.Title + '|' + $p.Artist
        if ($track -ne $mTrack) {
          $mTrack = $track
          $thumb = $null
          if ($p.Thumbnail) {
            try {
              $st = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
              # PowerShell 5.1 can't call the WinRT stream directly — bridge it to a .NET stream via reflection.
              $net = $toStream.Invoke($null, @($st))
              $ms = New-Object System.IO.MemoryStream
              $net.CopyTo($ms)
              $bytes = $ms.ToArray()
              $net.Dispose(); $ms.Dispose()
              if ($bytes.Length -gt 0 -and $bytes.Length -lt 600000) {
                $type = if ($bytes[0] -eq 0xFF) { 'image/jpeg' } elseif ($bytes[0] -eq 0x52) { 'image/webp' } else { 'image/png' }
                $thumb = 'data:' + $type + ';base64,' + [Convert]::ToBase64String($bytes)
              }
            } catch { $thumb = $null }
          }
        }
        $key = $track + '|' + $status + '|' + $info.Controls.IsNextEnabled + '|' + $info.Controls.IsPreviousEnabled
        if ($key -ne $mKey -or ($status -eq 'Playing' -and ($now - $mSent).TotalSeconds -ge 5)) {
          # The thumbnail only travels when the track changes — not every 5 s while playing.
          $sendThumb = $key -ne $mKey -and ($mKey -eq '' -or -not $mKey.StartsWith($track + '|'))
          $mKey = $key
          $mSent = $now
          $o = [ordered]@{
            app = [string]$s.SourceAppUserModelId
            title = [string]$p.Title
            artist = [string]$p.Artist
            album = [string]$p.AlbumTitle
            status = $status
            canToggle = [bool]$info.Controls.IsPlayPauseToggleEnabled
            canNext = [bool]$info.Controls.IsNextEnabled
            canPrev = [bool]$info.Controls.IsPreviousEnabled
            position = [double]$tl.Position.TotalSeconds
            duration = [double]$tl.EndTime.TotalSeconds
            sameThumb = -not $sendThumb
            thumbnail = $(if ($sendThumb) { $thumb } else { $null })
          }
          Emit ('M:' + ($o | ConvertTo-Json -Compress))
        }
      }
    } catch {
      Emit ('M:{"error":' + (ConvertTo-Json ([string]$_.Exception.Message)) + '}')
      $mKey = ''
    }
  }

  if ($btOn -and $now -ge $btNext) {
    # Every 45 s: the device query takes ~1-2 s, so it must not run often.
    $btNext = $now.AddSeconds(45)
    try { $j = Bt; if ($j -ne $btLast) { $btLast = $j; Emit ('B:' + $j) } } catch {}
  }

  Start-Sleep -Milliseconds 120
}
`

type Feature = 'fg' | 'media' | 'ocr' | 'bt'

class WinHelper {
  onForeground: (line: string) => void = () => {}
  onRect: (rect: string) => void = () => {}
  onMedia: (json: string) => void = () => {}
  onBluetooth: (json: string) => void = () => {}
  private proc: ChildProcess | null = null
  private features = new Set<Feature>()
  private restart: NodeJS.Timeout | null = null
  private ocrQueue: ((line: string) => void)[] = []

  enable(f: Feature): void {
    if (this.features.has(f)) return
    this.features.add(f)
    if (this.proc) this.toggle(f, true)
    else this.spawn()
  }

  disable(f: Feature): void {
    if (!this.features.delete(f)) return
    if (!this.features.size) this.kill()
    else this.toggle(f, false)
  }

  /** Media transport command (play/pause, next, previous). */
  mediaControl(cmd: 'toggle' | 'next' | 'prev'): void {
    if (this.features.has('media')) this.write(`mc ${cmd}`)
  }

  /** Recognize text in a PNG on disk. Resolves "OK:<base64>" or "ERR:<message>". */
  ocr(path: string, timeoutMs = 20_000): Promise<string> {
    this.enable('ocr')
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('OCR timed out')), timeoutMs)
      // A late answer still consumes its slot, so later requests stay matched to their own answers.
      this.ocrQueue.push(line => {
        clearTimeout(t)
        res(line)
      })
      this.write(`ocr ${path}`)
    })
  }

  private toggle(f: Feature, on: boolean): void {
    if (f === 'ocr') {
      if (!on) this.write('ocr 0')
    } else this.write(`${f} ${on ? 1 : 0}`)
  }

  private write(cmd: string): void {
    const stdin = this.proc?.stdin
    if (stdin && !stdin.destroyed) stdin.write(cmd + '\n')
  }

  private spawn(): void {
    if (this.restart) clearTimeout(this.restart)
    this.restart = null
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true
    })
    this.proc = p
    p.stdin.on('error', () => {
      /* process went away — 'close' handles it */
    })
    for (const f of this.features) this.toggle(f, true)
    let buf = ''
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (d: string) => {
      buf += d
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('F:')) this.onForeground(line.slice(2))
        else if (line.startsWith('R:')) this.onRect(line.slice(2))
        else if (line.startsWith('M:')) this.onMedia(line.slice(2))
        else if (line.startsWith('B:')) this.onBluetooth(line.slice(2))
        else if (line.startsWith('O:')) this.ocrQueue.shift()?.(line.slice(2))
      }
    })
    p.on('close', () => {
      if (this.proc !== p) return
      this.proc = null
      this.flushOcr('OCR stopped')
      // Restart if it died while something still needs it.
      if (this.features.size) this.restart = setTimeout(() => this.spawn(), 10_000)
    })
  }

  private kill(): void {
    if (this.restart) clearTimeout(this.restart)
    this.restart = null
    const p = this.proc
    this.proc = null
    if (p) killTree(p.pid)
    this.flushOcr('OCR stopped')
  }

  private flushOcr(reason: string): void {
    for (const q of this.ocrQueue.splice(0)) q(`ERR:${reason}`)
  }
}

export const winHelper = new WinHelper()

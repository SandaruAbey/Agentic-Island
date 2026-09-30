import { spawn, type ChildProcess } from 'node:child_process'
import type { MediaState } from '@shared/types'
import { killTree } from './agents'

/**
 * Now-playing info + controls via Windows' system media controls (GlobalSystemMediaTransportControls).
 * Works for any app that shows in the Windows media flyout: YouTube in Chrome/Edge/Firefox, Spotify, Media Player, VLC…
 * One long-lived PowerShell process: prints JSON when something changes, takes "toggle" / "next" / "prev" on stdin.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IInputStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$toStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [type[]]@([Windows.Storage.Streams.IInputStream]))
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
# Console.In.ReadLineAsync blocks in Windows PowerShell — a StreamReader on stdin is truly async.
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$pending = $in.ReadLineAsync()
$lastKey = ''
$lastTrack = ''
$thumb = $null
$lastSent = [DateTime]::MinValue
while ($true) {
  try {
    $s = $mgr.GetCurrentSession()
    if ($pending.IsCompleted) {
      $cmd = $pending.Result
      if ($cmd -eq $null) { break }
      if ($s) {
        if ($cmd -eq 'toggle') { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
        elseif ($cmd -eq 'next') { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
        elseif ($cmd -eq 'prev') { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
      }
      $pending = $in.ReadLineAsync()
      Start-Sleep -Milliseconds 150
      $s = $mgr.GetCurrentSession()
      $lastKey = ''
    }
    if (-not $s) {
      if ($lastKey -ne 'none') { $lastKey = 'none'; [Console]::Out.WriteLine('{"none":true}'); [Console]::Out.Flush() }
    } else {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $info = $s.GetPlaybackInfo()
      $tl = $s.GetTimelineProperties()
      $status = [string]$info.PlaybackStatus
      $track = $s.SourceAppUserModelId + '|' + $p.Title + '|' + $p.Artist
      if ($track -ne $lastTrack) {
        $lastTrack = $track
        $thumb = $null
        if ($p.Thumbnail) {
          try {
            $st = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
            # PowerShell 5.1 can't call the WinRT stream directly — bridge it to a .NET stream via reflection.
            $net = $toStream.Invoke($null, @($st))
            $ms = New-Object System.IO.MemoryStream
            $net.CopyTo($ms)
            $bytes = $ms.ToArray()
            $net.Dispose()
            if ($bytes.Length -gt 0 -and $bytes.Length -lt 600000) {
              $type = if ($bytes[0] -eq 0xFF) { 'image/jpeg' } elseif ($bytes[0] -eq 0x52) { 'image/webp' } else { 'image/png' }
              $thumb = 'data:' + $type + ';base64,' + [Convert]::ToBase64String($bytes)
            }
          } catch { $thumb = $null }
        }
      }
      $key = $track + '|' + $status + '|' + $info.Controls.IsNextEnabled + '|' + $info.Controls.IsPreviousEnabled
      $now = [DateTime]::UtcNow
      if ($key -ne $lastKey -or ($status -eq 'Playing' -and ($now - $lastSent).TotalSeconds -ge 5)) {
        $lastKey = $key
        $lastSent = $now
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
          thumbnail = $thumb
        }
        [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
      }
    }
  } catch {
    [Console]::Out.WriteLine('{"error":' + (ConvertTo-Json ([string]$_.Exception.Message)) + '}')
    [Console]::Out.Flush()
    $lastKey = ''
  }
  Start-Sleep -Milliseconds 700
}
`

const APP_NAMES: [RegExp, string][] = [
  [/spotify/i, 'Spotify'],
  [/chrome/i, 'Chrome'],
  [/msedge|edge/i, 'Edge'],
  [/firefox|308046B0AF4A39CB/i, 'Firefox'],
  [/brave/i, 'Brave'],
  [/opera/i, 'Opera'],
  [/zunemusic|media ?player/i, 'Media Player'],
  [/vlc/i, 'VLC'],
  [/itunes|applemusic/i, 'Apple Music'],
  [/teams/i, 'Teams']
]

export function friendlyApp(aumid: string): string {
  for (const [re, name] of APP_NAMES) if (re.test(aumid)) return name
  return aumid.replace(/\.exe$/i, '').split(/[!_\\]/)[0] || 'Media'
}

export class MediaWatcher {
  state: MediaState | null = null
  private proc: ChildProcess | null = null
  private restart: NodeJS.Timeout | null = null

  constructor(private onChange: (m: MediaState | null) => void) {}

  start(): void {
    if (this.proc) return
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true
    })
    this.proc = p
    let buf = ''
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (d: string) => {
      buf += d
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('{')) continue
        let j: any
        try {
          j = JSON.parse(line)
        } catch {
          continue
        }
        if (j.error) continue
        if (j.none || !j.title) {
          if (this.state) {
            this.state = null
            this.onChange(null)
          }
          continue
        }
        this.state = {
          app: j.app,
          appName: friendlyApp(j.app ?? ''),
          title: String(j.title).slice(0, 300),
          artist: String(j.artist ?? '').slice(0, 200),
          album: String(j.album ?? '').slice(0, 200),
          status: j.status,
          canToggle: !!j.canToggle,
          canNext: !!j.canNext,
          canPrev: !!j.canPrev,
          position: Number(j.position) || 0,
          duration: Number(j.duration) || 0,
          receivedAt: Date.now(),
          thumbnail: typeof j.thumbnail === 'string' && j.thumbnail.startsWith('data:image/') ? j.thumbnail : null
        }
        this.onChange(this.state)
      }
    })
    p.on('close', () => {
      if (this.proc !== p) return
      this.proc = null
      this.restart = setTimeout(() => this.start(), 10_000)
    })
  }

  control(cmd: 'toggle' | 'next' | 'prev'): void {
    this.proc?.stdin?.write(cmd + '\n')
  }

  stop(): void {
    if (this.restart) clearTimeout(this.restart)
    this.restart = null
    const p = this.proc
    this.proc = null
    if (p) killTree(p.pid)
    if (this.state) {
      this.state = null
      this.onChange(null)
    }
  }
}

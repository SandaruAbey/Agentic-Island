import { desktopCapturer, screen as eScreen } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActivityContext, AppPermission } from '@shared/types'
import { killTree } from './agents'

/**
 * Reads the window in front using Windows' built-in OCR (Windows.Media.Ocr) — fully on-device, zero tokens.
 * Screenshots are written to one private file that is overwritten each time and deleted on kill switch/quit.
 */
const OCR_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while ($true) {
  $path = [Console]::In.ReadLine()
  if ($path -eq $null) { break }
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $text = ($result.Lines | ForEach-Object { $_.Text }) -join "\`n"
    $stream.Dispose()
    [Console]::Out.WriteLine('OK:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)))
  } catch { [Console]::Out.WriteLine('ERR:' + $_.Exception.Message) }
  [Console]::Out.Flush()
}
`

/** Never look at these — the capture is skipped entirely. */
const PRIVATE = /(1password|bitwarden|keepass|lastpass|dashlane|nordpass|password|passwort|credential|bank|banking|paypal|wallet|incognito|inprivate|private browsing|authenticator|recovery code|seed phrase)/i

export class ScreenReader {
  private ocr: ChildProcess | null = null
  private ready: Promise<void> | null = null
  private queue: ((line: string) => void)[] = []
  private file: string

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'screen.png')
  }

  private startOcr(): Promise<void> {
    if (this.ready) return this.ready
    const encoded = Buffer.from(OCR_SCRIPT, 'utf16le').toString('base64')
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true
    })
    this.ocr = p
    let buf = ''
    this.ready = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('OCR engine did not start')), 20_000)
      p.stdout.setEncoding('utf8')
      p.stdout.on('data', (d: string) => {
        buf += d
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line === 'READY') {
            clearTimeout(t)
            res()
          } else if (line.startsWith('OK:') || line.startsWith('ERR:')) this.queue.shift()?.(line)
        }
      })
      p.on('close', () => {
        this.ocr = null
        this.ready = null
        for (const q of this.queue.splice(0)) q('ERR:OCR stopped')
      })
    })
    return this.ready
  }

  /** Capture the foreground window and return its text, or a skip reason. */
  async read(activity: ActivityContext, permissions?: AppPermission[]): Promise<{ text: string; skipped: string | null }> {
    if (PRIVATE.test(activity.title) || PRIVATE.test(activity.process)) return { text: '', skipped: 'Private window — not read' }
    // Check per-app permissions: if the user has explicitly blocked this app, skip it.
    if (permissions) {
      const proc = activity.process.toLowerCase()
      const perm = permissions.find(p => p.process === proc)
      if (perm && !perm.allowed) return { text: '', skipped: `Blocked by your app permissions — ${perm.name || activity.app} is not allowed` }
    }
    const { width, height } = eScreen.getPrimaryDisplay().size
    let sources: Electron.DesktopCapturerSource[] = []
    try {
      sources = await Promise.race([
        desktopCapturer.getSources({
          types: ['window', 'screen'],
          thumbnailSize: { width: Math.min(width, 2200), height: Math.min(height, 1400) },
          fetchWindowIcons: false
        }),
        new Promise<Electron.DesktopCapturerSource[]>((_, rej) => setTimeout(() => rej(new Error('Capture timed out')), 4000))
      ])
    } catch {
      try {
        sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: Math.min(width, 2200), height: Math.min(height, 1400) },
          fetchWindowIcons: false
        })
      } catch {
        return { text: '', skipped: 'Window could not be captured' }
      }
    }
    const winSrc = sources.find(s => s.id.startsWith('window:') && (s.name === activity.title || (activity.title && s.name.startsWith(activity.title.slice(0, 30)))))
    const screenSrc = sources.find(s => s.id.startsWith('screen:'))
    const src = (winSrc && !winSrc.thumbnail.isEmpty()) ? winSrc : screenSrc
    if (!src || src.thumbnail.isEmpty()) return { text: '', skipped: 'Window could not be captured' }
    writeFileSync(this.file, src.thumbnail.toPNG())
    await this.startOcr()
    const line = await new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error('OCR timed out')), 20_000)
      this.queue.push(l => {
        clearTimeout(t)
        res(l)
      })
      this.ocr?.stdin?.write(this.file + '\n')
    })
    if (line.startsWith('ERR:')) throw new Error(line.slice(4))
    return { text: Buffer.from(line.slice(3), 'base64').toString('utf8'), skipped: null }
  }

  /** Delete the screenshot and stop the OCR process. */
  wipe(): void {
    try {
      rmSync(this.file, { force: true })
    } catch {
      /* ignore */
    }
    if (this.ocr) killTree(this.ocr.pid)
    this.ocr = null
    this.ready = null
  }
}

import { spawn, type ChildProcess } from 'node:child_process'
import { killTree } from '../agents'

/**
 * Desktop control for computer-use tasks, through Windows UI Automation — so Isla can read and press things in other
 * apps WITHOUT moving your mouse or stealing focus. One PowerShell process lives only while a computer task runs.
 * The real-input ops (focus / click_at / keys) exist as a last resort and are always confirmed by the user first.
 *
 * Protocol: one base64(JSON {op, args}) line in → one JSON line {ok, result | error} out. Requests are serialized.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class IslaDesk {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
}
"@
[void][IslaDesk]::SetProcessDPIAware()
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Win($a) {
  $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$a.hwnd)
  if ($el -eq $null) { throw 'Window not found - list the windows again' }
  $el
}

function Resolve($a) {
  $el = Win $a
  if ($a.ref) {
    foreach ($i in ([string]$a.ref).Split('.')) {
      $ch = $walker.GetFirstChild($el)
      for ($k = 0; $k -lt [int]$i -and $ch -ne $null; $k++) { $ch = $walker.GetNextSibling($ch) }
      if ($ch -eq $null) { throw ('Element ' + $a.ref + ' not found - read the window again') }
      $el = $ch
    }
  }
  $el
}

function Center($el) {
  $r = $el.Current.BoundingRectangle
  if ($r.IsEmpty) { return $null }
  [ordered]@{ x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2) }
}

function Op-windows($a) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $out = @()
  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $c = $w.Current
    if (-not $c.Name) { continue }
    $h = [IntPtr][int64]$c.NativeWindowHandle
    if (-not [IslaDesk]::IsWindowVisible($h)) { continue }
    $p = ''
    try { $p = (Get-Process -Id $c.ProcessId).ProcessName } catch {}
    $out += [ordered]@{ hwnd = [int64]$c.NativeWindowHandle; title = $c.Name; process = $p; minimized = [IslaDesk]::IsIconic($h) }
  }
  ,$out
}

function Walk($el, $path, $depth) {
  if ($script:n -ge $script:max -or $depth -gt 40 -or [DateTime]::UtcNow -gt $script:deadline) { return }
  $c = $el.Current
  $type = $c.ControlType.ProgrammaticName -replace '^ControlType\\.', ''
  $val = $null
  $o = $null
  if (-not $c.IsPassword -and $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$o)) { $val = $o.Current.Value }
  $name = [string]$c.Name
  if ($name.Length -gt 200) { $name = $name.Substring(0, 200) }
  if ($val -ne $null -and $val.Length -gt 500) { $val = $val.Substring(0, 500) }
  if ($name -or $val -or $c.IsPassword) {
    [void]$script:items.Add([ordered]@{ ref = $path; type = $type; name = $name; value = $val; password = $c.IsPassword; enabled = $c.IsEnabled })
    $script:n++
  }
  $i = 0
  $ch = $walker.GetFirstChild($el)
  while ($ch -ne $null -and $script:n -lt $script:max) {
    $p = if ($path) { $path + '.' + $i } else { [string]$i }
    Walk $ch $p ($depth + 1)
    $i++
    $ch = $walker.GetNextSibling($ch)
  }
}

function Op-read($a) {
  $script:items = New-Object System.Collections.ArrayList
  $script:n = 0
  $script:max = 400
  $script:deadline = [DateTime]::UtcNow.AddSeconds(12)
  Walk (Win $a) '' 0
  ,$script:items.ToArray()
}

function Op-click($a) {
  $el = Resolve $a
  $o = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$o)) { $o.Invoke(); return 'pressed' }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$o)) { $o.Toggle(); return 'toggled' }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$o)) { $o.Select(); return 'selected' }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$o)) {
    if ($o.Current.ExpandCollapseState -eq 'Expanded') { $o.Collapse(); return 'collapsed' } else { $o.Expand(); return 'expanded' }
  }
  $c = Center $el
  throw ('This element cannot be pressed in the background' + $(if ($c) { ' (it is at screen x=' + $c.x + ', y=' + $c.y + ')' } else { '' }))
}

function Op-settext($a) {
  $el = Resolve $a
  if ($el.Current.IsPassword) { throw 'Refusing to type into a password field' }
  $o = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$o) -and -not $o.Current.IsReadOnly) { $o.SetValue([string]$a.text); return 'typed' }
  throw 'This field cannot be filled in the background'
}

function Png($bmp, $maxW) {
  $scale = [Math]::Min(1.0, $maxW / [double]$bmp.Width)
  $w = [int]($bmp.Width * $scale); $h = [int]($bmp.Height * $scale)
  $out = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.DrawImage($bmp, 0, 0, $w, $h)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $out.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  [ordered]@{ png = [Convert]::ToBase64String($ms.ToArray()); width = $w; height = $h; scale = $scale }
}

function Op-shot($a) {
  $h = [IntPtr][int64]$a.hwnd
  if ([IslaDesk]::IsIconic($h)) { throw 'The window is minimized - it cannot be captured in the background' }
  $r = New-Object IslaDesk+RECT
  [void][IslaDesk]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  if ($w -le 0 -or $hh -le 0) { throw 'The window has no size' }
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  [void][IslaDesk]::PrintWindow($h, $dc, 2)
  $g.ReleaseHdc($dc); $g.Dispose()
  $res = Png $bmp 1400
  $bmp.Dispose()
  $res
}

function Op-screen($a) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $g.Dispose()
  $res = Png $bmp 1400
  $bmp.Dispose()
  $res['originX'] = $b.X; $res['originY'] = $b.Y
  $res
}

function Op-focus($a) {
  $h = [IntPtr][int64]$a.hwnd
  if ([IslaDesk]::IsIconic($h)) { [void][IslaDesk]::ShowWindow($h, 9) }
  [void][IslaDesk]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 250
  'focused'
}

function Op-clickat($a) {
  [void][IslaDesk]::SetCursorPos([int]$a.x, [int]$a.y)
  Start-Sleep -Milliseconds 60
  $down = 0x2; $up = 0x4
  if ($a.button -eq 'right') { $down = 0x8; $up = 0x10 }
  $times = if ($a.double) { 2 } else { 1 }
  for ($i = 0; $i -lt $times; $i++) {
    [IslaDesk]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero)
    [IslaDesk]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 80
  }
  'clicked'
}

function Op-keys($a) {
  [System.Windows.Forms.SendKeys]::SendWait([string]$a.keys)
  'sent'
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $req = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
    $res = & ('Op-' + $req.op) $req.args
    $out = [ordered]@{ ok = $true; result = $res }
  } catch {
    $out = [ordered]@{ ok = $false; error = [string]$_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
`

export interface DeskWindow {
  hwnd: number
  title: string
  process: string
  minimized: boolean
}

export interface DeskElement {
  ref: string
  type: string
  name: string
  value: string | null
  password: boolean
  enabled: boolean
}

export interface DeskImage {
  png: string
  width: number
  height: number
  /** image pixels per physical screen pixel */
  scale: number
  originX?: number
  originY?: number
}

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? v : v ? [v as T] : [])

export class Desktop {
  private proc: ChildProcess | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private waiting: ((line: string) => void) | null = null
  private idle: NodeJS.Timeout | null = null

  windows = async (): Promise<DeskWindow[]> => asArray<DeskWindow>(await this.call('windows', {}))
  read = async (hwnd: number): Promise<DeskElement[]> => asArray<DeskElement>(await this.call('read', { hwnd }, 30_000))
  click = (hwnd: number, ref: string) => this.call('click', { hwnd, ref }) as Promise<string>
  setText = (hwnd: number, ref: string, text: string) => this.call('settext', { hwnd, ref, text }) as Promise<string>
  shot = (hwnd: number) => this.call('shot', { hwnd }) as Promise<DeskImage>
  screen = () => this.call('screen', {}) as Promise<DeskImage>
  focus = (hwnd: number) => this.call('focus', { hwnd }) as Promise<string>
  clickAt = (x: number, y: number, button: 'left' | 'right', double: boolean) => this.call('clickat', { x, y, button, double }) as Promise<string>
  keys = (keys: string) => this.call('keys', { keys }) as Promise<string>

  /** Stop the worker (end of the last computer task, kill switch, quit). */
  stop(): void {
    const p = this.proc
    this.proc = null
    if (p) killTree(p.pid)
    this.waiting?.('{"ok":false,"error":"Desktop control stopped"}')
    this.waiting = null
  }

  private call(op: string, args: unknown, timeoutMs = 20_000): Promise<unknown> {
    // Free its ~80 MB when PC control hasn't been used for 2 minutes; the next action starts it again.
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      this.idle = null
      if (!this.waiting) this.stop()
    }, 120_000)
    const run = async () => {
      const p = this.ensure()
      const line = await new Promise<string>((res, rej) => {
        const t = setTimeout(() => {
          // A stuck UI Automation call can't be cancelled — restart the worker so later calls aren't blocked.
          this.waiting = null
          this.stop()
          rej(new Error('The app did not answer in time'))
        }, timeoutMs)
        this.waiting = l => {
          clearTimeout(t)
          res(l)
        }
        p.stdin!.write(Buffer.from(JSON.stringify({ op, args }), 'utf8').toString('base64') + '\n')
      })
      const j = JSON.parse(line)
      if (!j.ok) throw new Error(String(j.error || 'failed'))
      return j.result
    }
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => undefined)
    return next
  }

  private ensure(): ChildProcess {
    if (this.proc) return this.proc
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true })
    this.proc = p
    p.stdin.on('error', () => {})
    let buf = ''
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (d: string) => {
      buf += d
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const l of lines) {
        if (!l.startsWith('{')) continue
        const w = this.waiting
        this.waiting = null
        w?.(l)
      }
    })
    p.on('close', () => {
      if (this.proc !== p) return
      this.proc = null
      this.waiting?.('{"ok":false,"error":"Desktop control stopped"}')
      this.waiting = null
    })
    return p
  }
}

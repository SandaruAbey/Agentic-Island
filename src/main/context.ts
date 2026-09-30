import { spawn, type ChildProcess } from 'node:child_process'
import type { ActivityContext } from '@shared/types'
import { killTree } from './agents'

/**
 * Watches which window is in front so Isla can offer relevant help.
 * One long-lived PowerShell process polls GetForegroundWindow and prints only when it changes.
 * Window titles stay on this PC: they drive local rules and are never logged or sent to an AI.
 */
const SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class IslandFG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
"@
$last = ''
while ($true) {
  $h = [IslandFG]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][IslandFG]::GetWindowText($h, $sb, 512)
  $procId = 0
  [void][IslandFG]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = ''
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  $line = $name + [char]31 + $sb.ToString()
  if ($line -ne $last) { $last = $line; [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
  Start-Sleep -Milliseconds 1500
}
`

const BROWSERS = /^(chrome|msedge|firefox|brave|opera|vivaldi|arc|zen)$/i
const MAIL_APPS = /^(outlook|olk|hxoutlook|thunderbird|mailbird|em ?client)$/i
const IDES = /^(code|code - insiders|cursor|windsurf|antigravity|antigravity ide|kiro|idea64|pycharm64|webstorm64|rider64|devenv|sublime_text|zed)$/i
const OFFICE = /^(winword|excel|powerpnt|onenote|acrord32|acrobat)$/i
const CHAT = /^(teams|ms-teams|slack|discord|whatsapp|telegram|signal|zoom)$/i
const TERMINALS = /^(windowsterminal|powershell|pwsh|cmd|wt|alacritty|wezterm-gui)$/i
const IDE_NAMES = /^(visual studio code( - insiders)?|visual studio|cursor|antigravity( ide)?|windsurf|kiro|zed|intellij idea|pycharm|webstorm|rider|sublime text)$/i
const SIGN_IN = /(sign[ -]?in|log[ -]?in|verify|verification|2-step|two[- ]factor|authenticat|one[- ]time|\botp\b|security code|confirm your)/i
const MAIL_TITLE = /(gmail|outlook|inbox|yahoo mail|proton mail|mail -)/i
const CHAT_TITLE = /(microsoft teams|slack|discord|whatsapp|messenger|telegram)/i

export function classify(process: string, title: string): ActivityContext | null {
  if (!process || /^(agentic island|electron|explorer|searchhost|shellexperiencehost|lockapp)$/i.test(process)) return null
  let kind: ActivityContext['kind'] = 'other'
  if (MAIL_APPS.test(process)) kind = 'mail'
  else if (BROWSERS.test(process)) kind = CHAT_TITLE.test(title) ? 'chat' : MAIL_TITLE.test(title) ? 'mail' : 'browser'
  else if (IDES.test(process)) kind = 'ide'
  else if (OFFICE.test(process)) kind = 'office'
  else if (CHAT.test(process)) kind = 'chat'
  else if (TERMINALS.test(process)) kind = 'terminal'

  // "file.ts - my-project - Visual Studio Code" → "my-project"
  let project: string | null = null
  if (kind === 'ide') {
    // Drop the app-name segments, then the project is the last remaining part ("file - project").
    const parts = title
      .split(/ [-—] /)
      .map(s => s.trim().replace(/^[●•*]\s*/, ''))
      .filter(s => s && !IDE_NAMES.test(s))
    const last = parts[parts.length - 1]
    project = last ? last.replace(/^\[.*?\]\s*/, '').replace(/\s*\(.*\)$/, '') || null : null
    if (project && /^(welcome|get started|settings|extensions|untitled.*)$/i.test(project)) project = null
  }
  const segments = title.split(/ [-—|] /)
  const app = kind === 'browser' || kind === 'mail' ? segments[segments.length - 1] || process : process
  return {
    app: app.slice(0, 40),
    process,
    title: title.slice(0, 200),
    kind,
    signIn: (kind === 'browser' || kind === 'mail') && SIGN_IN.test(title),
    project
  }
}

export class ContextWatcher {
  current: ActivityContext | null = null
  private proc: ChildProcess | null = null
  private restart: NodeJS.Timeout | null = null

  constructor(private onChange: (a: ActivityContext | null) => void) {}

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
        const [proc, title = ''] = line.split('\x1f')
        const next = classify(proc?.trim() ?? '', title.trim())
        // Ignore our own window so the context stays on the app the user was really using.
        if (!next) continue
        this.current = next
        this.onChange(next)
      }
    })
    p.on('close', () => {
      if (this.proc !== p) return
      this.proc = null
      // Restart if it died unexpectedly.
      this.restart = setTimeout(() => this.start(), 10_000)
    })
  }

  stop(): void {
    if (this.restart) clearTimeout(this.restart)
    this.restart = null
    const p = this.proc
    this.proc = null
    if (p) killTree(p.pid)
    if (this.current) {
      this.current = null
      this.onChange(null)
    }
  }

  get running(): boolean {
    return this.proc !== null
  }
}

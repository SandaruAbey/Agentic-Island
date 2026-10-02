import type { ActivityContext } from '@shared/types'
import { winHelper } from './winhelper'

/**
 * Watches which window is in front so Isla can offer relevant help.
 * The shared Windows helper polls GetForegroundWindow and prints only when it changes.
 * Window titles stay on this PC: they drive local rules and are never logged or sent to an AI.
 */

const BROWSERS = /^(chrome|msedge|firefox|brave|opera|vivaldi|arc|zen)$/i
const MAIL_APPS = /^(outlook|olk|hxoutlook|thunderbird|mailbird|em ?client)$/i
const IDES = /^(code|code - insiders|cursor|windsurf|antigravity|antigravity ide|kiro|idea64|pycharm64|webstorm64|rider64|devenv|sublime_text|zed)$/i
const OFFICE = /^(winword|excel|powerpnt|onenote|acrord32|acrobat)$/i
const CHAT = /^(teams|ms-teams|slack|discord|whatsapp|whatsapp\.root|telegram|signal|zoom|messenger|viber)$/i
const TERMINALS = /^(windowsterminal|powershell|pwsh|cmd|wt|alacritty|wezterm-gui)$/i
const IDE_NAMES = /^(visual studio code( - insiders)?|visual studio|cursor|antigravity( ide)?|windsurf|kiro|zed|intellij idea|pycharm|webstorm|rider|sublime text)$/i
const SIGN_IN = /(sign[ -]?in|log[ -]?in|verify|verification|2-step|two[- ]factor|authenticat|one[- ]time|\botp\b|security code|confirm your)/i
const MAIL_TITLE = /(gmail|outlook|inbox|yahoo mail|proton mail|mail -)/i
const CHAT_TITLE = /(microsoft teams|slack|discord|whatsapp|messenger|telegram)/i
const CHAT_NAMES: [RegExp, string][] = [
  [/microsoft teams/i, 'Teams'],
  [/slack/i, 'Slack'],
  [/discord/i, 'Discord'],
  [/whatsapp/i, 'WhatsApp'],
  [/messenger/i, 'Messenger'],
  [/telegram/i, 'Telegram']
]

export function classify(process: string, title: string, pid = 0): ActivityContext | null {
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
  const chatApp = kind === 'chat' && BROWSERS.test(process) ? CHAT_NAMES.find(([re]) => re.test(title))?.[1] : undefined
  const app = chatApp ?? (kind === 'browser' || kind === 'mail' ? segments[segments.length - 1] || process : process)
  return {
    app: app.slice(0, 40),
    process,
    title: title.slice(0, 200),
    kind,
    signIn: (kind === 'browser' || kind === 'mail') && SIGN_IN.test(title),
    project,
    pid
  }
}

/** Foreground window bounds in physical screen pixels. */
export interface WinRect {
  x: number
  y: number
  width: number
  height: number
}

function parseRect(v: string | undefined): WinRect | null {
  const n = (v ?? '').split(',').map(Number)
  if (n.length !== 4 || n.some(x => !Number.isFinite(x))) return null
  const [l, t, r, b] = n
  return r - l > 0 && b - t > 0 ? { x: l, y: t, width: r - l, height: b - t } : null
}

export class ContextWatcher {
  current: ActivityContext | null = null
  /** Bounds of the window in front (including ones we ignore, like our own) — used to crop screen captures. */
  rect: WinRect | null = null
  private started = false
  /** An ignored window (ours, the taskbar…) is in front — its moves must not replace the user's window bounds. */
  private ignoring = false

  constructor(private onChange: (a: ActivityContext | null) => void) {}

  start(): void {
    if (this.started) return
    this.started = true
    winHelper.onRect = r => {
      if (!this.ignoring) this.rect = parseRect(r)
    }
    winHelper.onForeground = line => {
      const [proc, title = '', pid = '0', rect] = line.split('')
      const next = classify(proc?.trim() ?? '', title.trim(), Number(pid) || 0)
      // Ignore our own window so the context stays on the app the user was really using.
      this.ignoring = !next
      if (!next) return
      this.rect = parseRect(rect)
      this.current = next
      this.onChange(next)
    }
    winHelper.enable('fg')
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    winHelper.disable('fg')
    this.rect = null
    if (this.current) {
      this.current = null
      this.onChange(null)
    }
  }

  get running(): boolean {
    return this.started
  }
}

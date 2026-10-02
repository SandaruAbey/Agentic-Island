import { basename } from 'node:path'
import { createHash } from 'node:crypto'
import type { ActivityContext, BackgroundStats, CommitProposal, GitState, IslandEvent, ScreenStatus, Settings, Suggestion } from '@shared/types'
import type { AgentManager } from './agents'
import type { ScreenReader } from './screen'
import { diffForReview, scanSecrets } from './git'
import { redactCodes } from './mail'

const SCREEN_EVERY_MS = 20_000
const STABLE_BEFORE_AI_MS = 12_000
const CHANGES_SETTLE_MS = 90_000 // 1.5 minutes
const PEEK_COOLDOWN_MS = 4 * 60_000

const ERROR_LINE =
  /(Traceback \(most recent call last\)|\b\w*(Error|Exception)\b:|\bERR!|\bFATAL\b|Uncaught |failed to compile|Build failed|is not recognized as|command not found|Cannot find module|Module not found|segmentation fault|npm ERR|error\[E\d+\]|error TS\d+|✖ \d+ problem)/i

/** Mask anything that looks like a secret before screen text goes anywhere near a model. */
export function redactScreen(text: string): string {
  return redactCodes('', text)
    .replace(/((password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi, '$1[hidden]')
    .replace(/\b(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(ant-)?[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g, '[secret hidden]')
    .replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, '[card hidden]')
}

/** Same window as when the screen was read (same app process and title). */
function sameWindow(a: ActivityContext, b: ActivityContext | null): boolean {
  return !!b && a.pid === b.pid && a.title === b.title
}

/** An open conversation: a message box, or several message timestamps. */
function looksLikeConversation(text: string): boolean {
  if (/(type a (new )?message|write a message|send a message|message @|message #|reply in thread|type your message|write a reply)/i.test(text)) return true
  return (text.match(/\b\d{1,2}[:.]\d{2}\s?(am|pm|AM|PM)?\b/g) ?? []).length >= 3
}

function parseJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

const short = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10)

interface Deps {
  reader: ScreenReader
  agents: AgentManager
  getSettings: () => Settings
  getActivity: () => ActivityContext | null
  getGit: () => GitState | null
  isLocked: () => boolean
  onChange: () => void
  notify: (e: Extract<IslandEvent, { type: 'notify' }>) => void
  log: (kind: string, detail: string) => void
}

export class InsightEngine {
  /** Latest OCR text of the window in front. Memory only. */
  screenText = ''
  screenApp: ActivityContext | null = null
  status: ScreenStatus | null = null
  suggestions: Suggestion[] = []
  proposal: CommitProposal | null = null
  private calls: number[] = []
  private day = new Date().toDateString()
  private tokensToday = 0
  private costToday = 0
  private timer: NodeJS.Timeout | null = null
  private nudge: NodeJS.Timeout | null = null
  private stable: NodeJS.Timeout | null = null
  private settle: NodeJS.Timeout | null = null
  private busy = false
  private lastHash = ''
  private lastAiHash = ''
  private lastPeek = 0
  private reviewing = false

  constructor(private d: Deps) {}

  start(): void {
    this.stop()
    this.timer = setInterval(() => void this.tick(), SCREEN_EVERY_MS)
    void this.tick()
  }

  stop(): void {
    for (const t of [this.nudge, this.stable, this.settle]) if (t) clearTimeout(t)
    if (this.timer) clearInterval(this.timer)
    this.timer = this.nudge = this.stable = this.settle = null
    this.d.reader.wipe()
    this.screenText = ''
    this.suggestions = []
    this.status = null
    this.lastHash = ''
  }

  /** Window focus changed — read it soon (debounced so alt-tabbing is free). */
  onActivity(): void {
    if (!this.timer) return
    // Suggestions were made for the previous window/tab — never offer them on another page.
    if (this.stable) clearTimeout(this.stable)
    this.stable = null
    this.lastHash = ''
    if (this.suggestions.length) {
      this.suggestions = []
      this.d.onChange()
    }
    if (this.nudge) clearTimeout(this.nudge)
    this.nudge = setTimeout(() => void this.tick(), 2500)
  }

  stats(): BackgroundStats {
    this.rollDay()
    const hourAgo = Date.now() - 3_600_000
    this.calls = this.calls.filter(t => t > hourAgo)
    return {
      callsLastHour: this.calls.length,
      limitPerHour: this.d.getSettings().assistant.aiChecksPerHour,
      tokensToday: this.tokensToday,
      costToday: this.costToday
    }
  }

  private rollDay(): void {
    const today = new Date().toDateString()
    if (today !== this.day) {
      this.day = today
      this.tokensToday = 0
      this.costToday = 0
    }
  }

  private budgetOk(): boolean {
    const a = this.d.getSettings().assistant
    return a.aiInsights && this.stats().callsLastHour < a.aiChecksPerHour && !!this.d.agents.assistantProvider()
  }

  private async cheapAsk(system: string, prompt: string): Promise<string> {
    const a = this.d.getSettings().assistant
    this.calls.push(Date.now())
    const r = await this.d.agents.quickAsk(system, prompt, a.backgroundModel.trim())
    this.rollDay()
    this.tokensToday += r.tokens
    this.costToday += r.cost
    this.d.onChange()
    return r.text
  }

  // ------------------------------------------------------------ screen

  async tick(): Promise<void> {
    const s = this.d.getSettings().assistant
    const activity = this.d.getActivity()
    if (!s.screenWatch || !activity || this.busy || this.d.isLocked()) return
    this.busy = true
    try {
      const { text, skipped } = await this.d.reader.read(activity, this.d.getSettings().appPermissions)
      this.status = { app: activity.app, capturedAt: Date.now(), chars: text.length, skipped }
      if (skipped) {
        this.screenText = ''
        this.suggestions = []
        this.d.onChange()
        return
      }
      // The user moved to another window or tab while the screen was being read: this text is stale.
      if (!sameWindow(activity, this.d.getActivity())) return
      const hash = short(activity.title + '|' + text.replace(/\s+/g, ' ').slice(0, 4000))
      if (hash === this.lastHash) return
      this.lastHash = hash
      this.screenText = text.slice(0, 8000)
      this.screenApp = activity
      this.suggestions = this.localRules(activity, text)
      this.d.onChange()
      // Only spend tokens once the screen has stayed the same for a moment.
      if (this.stable) clearTimeout(this.stable)
      this.stable = setTimeout(() => void this.aiCheck(hash, activity), STABLE_BEFORE_AI_MS)
    } catch (e) {
      this.status = { app: activity.app, capturedAt: Date.now(), chars: 0, skipped: (e as Error).message.slice(0, 80) }
    } finally {
      this.busy = false
    }
  }

  /** Zero-token suggestions from simple patterns. The action only runs when the user clicks it. */
  private localRules(a: ActivityContext, text: string): Suggestion[] {
    const out: Suggestion[] = []
    const now = Date.now()
    const lines = text.split('\n')
    const errIdx = lines.findIndex(l => ERROR_LINE.test(l))
    if (errIdx >= 0 && (a.kind === 'ide' || a.kind === 'terminal' || a.kind === 'browser' || a.kind === 'other')) {
      const line = lines[errIdx].trim()
      out.push({
        id: `err:${short(line)}`,
        title: 'Explain & fix this error',
        detail: line.slice(0, 100),
        icon: 'warn',
        action: {
          type: 'do',
          title: `Fix: ${line.slice(0, 60)}`,
          prompt: 'Explain the error shown on my screen in plain words and tell me exactly how to fix it. If it points to files in my project, read them and propose the change.'
        },
        createdAt: now
      })
    }
    if (a.kind === 'mail' && text.length > 400) {
      out.push({
        id: `mail-screen:${short(text.slice(0, 600))}`,
        title: 'Summarize this email',
        detail: 'From what is open on your screen — no inbox setup needed.',
        icon: 'mail',
        action: { type: 'do', title: `Summarize email in ${a.app}`, prompt: 'Summarize the email that is open on my screen in 3 bullets and list anything I need to do.' },
        createdAt: now
      })
      out.push({
        id: `reply-screen:${short(text.slice(0, 600))}`,
        title: 'Draft a reply',
        detail: 'A short, ready-to-paste reply.',
        icon: 'mail',
        action: { type: 'do', title: 'Draft reply', prompt: 'Draft a short, polite reply to the email open on my screen, in the same language. Output only the reply text.' },
        createdAt: now
      })
    }
    if (a.kind === 'browser' && !a.signIn && text.length > 2500) {
      out.push({
        id: `page:${short(a.title)}`,
        title: 'Summarize this page',
        detail: a.title.slice(0, 90),
        icon: 'eye',
        action: { type: 'do', title: `Summarize: ${a.title.slice(0, 50)}`, prompt: 'Summarize the page on my screen in 5 short bullets. Keep numbers and names exact.' },
        createdAt: now
      })
    }
    // Teams / WhatsApp / Slack… (app or browser): suggest a reply — only when a conversation is really open
    // (a message box or several message timestamps), not on a chat app's home, search or settings page.
    if (a.kind === 'chat' && text.length > 120 && looksLikeConversation(text)) {
      out.push({
        id: `chat-reply:${short(text.slice(-600))}`,
        title: `Suggest a reply in ${a.app}`,
        detail: 'A short, natural reply to the latest message — paste it with one click.',
        icon: 'chat',
        action: {
          type: 'do',
          title: `Reply in ${a.app}`,
          prompt:
            'This is a chat conversation on my screen. Write ONE short, natural reply I could send to the latest message, in the same language and tone as the conversation. Output only the reply text.'
        },
        createdAt: now
      })
    }
    // Lots of non-English text (Sinhala, Tamil, Hindi, Arabic, CJK, Cyrillic…) → offer a translation.
    const foreign = (text.match(/[\u0D80-\u0DFF\u0B80-\u0BFF\u0900-\u097F\u0600-\u06FF\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u0E00-\u0E7F]/g) ?? []).length
    const letters = (text.match(/\p{L}/gu) ?? []).length
    if (letters > 40 && foreign / letters > 0.25) {
      out.push({
        id: `translate:${short(text.slice(0, 600))}`,
        title: 'Translate this to English',
        detail: `Non-English text in ${a.app}`,
        icon: 'translate',
        action: { type: 'do', title: `Translate (${a.app})`, prompt: 'Translate the main non-English text on my screen into natural English. Keep names as they are. Output only the translation.' },
        createdAt: now
      })
    }
    if (a.kind === 'office' && text.length > 500) {
      out.push({
        id: `doc:${short(a.title)}`,
        title: 'Proofread what’s on screen',
        detail: 'Spelling, grammar and clarity — suggestions only.',
        icon: 'review',
        action: { type: 'do', title: 'Proofread document', prompt: 'Proofread the document text on my screen. List only real mistakes as "wrong → right" and 2 clarity tips.' },
        createdAt: now
      })
    }
    // Always offer help when a browser is in focus — proactive web assistance.
    if (a.kind === 'browser' && !a.signIn && text.length > 200 && text.length <= 2500) {
      out.push({
        id: `browser-help:${short(a.title)}`,
        title: 'Need help with this page?',
        detail: 'Tell Isla what you need — it reads the page and does it.',
        icon: 'eye',
        action: {
          type: 'do',
          title: `Help with: ${a.title.slice(0, 50)}`,
          askUser: 'What do you want help with on this page?',
          prompt: 'Use the page on my screen to do what I ask below. Be concise and practical; if I ask for text (a reply, a summary, a translation), output only that text.'
        },
        createdAt: now
      })
    }
    return out.slice(0, 4)
  }

  private async aiCheck(hash: string, activity: ActivityContext): Promise<void> {
    if (hash !== this.lastHash || hash === this.lastAiHash || this.d.isLocked() || !this.budgetOk()) return
    if (this.screenText.replace(/\s/g, '').length < 80) return
    this.lastAiHash = hash
    try {
      const reply = await this.cheapAsk(
        'You are Isla, a proactive desktop assistant. From OCR text of the user screen, propose at most ONE concrete, clearly useful action you (a text AI that cannot click) can do for them now. Reply with compact JSON only: {"title":"max 8 words, imperative","why":"max 15 words","prompt":"full instruction to yourself"} or {"none":true} when nothing is clearly useful. Never suggest actions about passwords or payments.',
        `App: ${activity.app} (${activity.kind})\nWindow: ${activity.title}\nScreen text:\n${redactScreen(this.screenText).slice(0, 1500)}`
      )
      const j = parseJson(reply)
      if (!j || j.none || typeof j.title !== 'string' || typeof j.prompt !== 'string') return
      if (hash !== this.lastHash || !sameWindow(activity, this.d.getActivity())) return // screen moved on
      const sug: Suggestion = {
        id: `ai:${hash}`,
        title: j.title.slice(0, 80),
        detail: typeof j.why === 'string' ? j.why.slice(0, 120) : 'Suggested from your screen',
        icon: 'spark',
        action: { type: 'do', title: j.title.slice(0, 80), prompt: j.prompt.slice(0, 1000) },
        createdAt: Date.now()
      }
      this.suggestions = [sug, ...this.suggestions.filter(x => !x.id.startsWith('ai:'))].slice(0, 4)
      this.d.log('insight.suggested', `${activity.app}: ${sug.title}`)
      this.d.onChange()
    } catch (e) {
      this.d.log('insight.error', (e as Error).message)
    }
  }

  // ------------------------------------------------------------ commits

  /** Git state changed — once edits settle, review them and offer Commit & push. */
  onGit(g: GitState | null): void {
    const a = this.d.getSettings().assistant
    const changed = g?.isRepo ? g.staged + g.modified + g.untracked : 0
    if (!changed) {
      if (this.proposal) {
        this.proposal = null
        this.d.onChange()
      }
      return
    }
    if (!a.autoReviewCommits || g!.conflicted) return
    if (this.settle) clearTimeout(this.settle)
    this.settle = setTimeout(() => void this.review(false), CHANGES_SETTLE_MS)
  }

  async review(force: boolean): Promise<CommitProposal | null> {
    const ws = this.d.getSettings().activeWorkspace
    if (!ws || this.reviewing || this.d.isLocked()) return this.proposal
    this.reviewing = true
    try {
      const diff = await diffForReview(ws)
      if (!diff) {
        this.proposal = null
        return null
      }
      if (!force && this.proposal?.diffHash === diff.hash && this.proposal.workspace === ws) return this.proposal
      const secrets = scanSecrets(diff.added, diff.files)
      const names = diff.files.slice(0, 3).map(f => basename(f))
      let message = `Update ${names.join(', ')}${diff.files.length > 3 ? ` and ${diff.files.length - 3} more` : ''}`
      let ok = secrets.length === 0
      let issues: string[] = []
      let source: CommitProposal['source'] = 'local'
      if (this.budgetOk()) {
        try {
          const reply = await this.cheapAsk(
            'You are a senior engineer doing a quick pre-commit check. Reply with compact JSON only: {"message":"conventional commit subject, max 72 chars","ok":true|false,"issues":["max 3 short items, only real problems: obvious bugs, broken syntax, leftover debug code, unfinished TODO in new code"]}. ok=false only for real problems.',
            `Files:\n${diff.files.join('\n')}\n\nDiff:\n${redactScreen(diff.text)}`
          )
          const j = parseJson(reply)
          if (j && typeof j.message === 'string' && j.message.trim()) {
            message = j.message.trim().split('\n')[0].slice(0, 100)
            ok = j.ok !== false && secrets.length === 0
            issues = Array.isArray(j.issues) ? j.issues.filter((x): x is string => typeof x === 'string').slice(0, 3) : []
            source = 'ai'
          }
        } catch (e) {
          this.d.log('insight.error', (e as Error).message)
        }
      }
      this.proposal = { workspace: ws, diffHash: diff.hash, files: diff.files, message, ok, issues, secrets, source, createdAt: Date.now() }
      this.d.log('commit.reviewed', `${diff.files.length} files · ${ok ? 'ok' : 'check'} · ${message}`)
      this.d.notify({
        type: 'notify',
        kind: 'commit',
        title: secrets.length ? 'Possible secret in your changes' : ok ? 'Changes look good' : 'Check before committing',
        body: message
      })
      return this.proposal
    } finally {
      this.reviewing = false
      this.d.onChange()
    }
  }
}

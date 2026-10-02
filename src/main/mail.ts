import type { ImapFlow } from 'imapflow'
import type { ParsedMail } from 'mailparser'

// The mail libraries are loaded only when an inbox is actually connected, so they cost no memory otherwise.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadImap = async (): Promise<typeof ImapFlow> => {
  const m: any = await import('imapflow')
  return m.ImapFlow ?? m.default?.ImapFlow
}
const simpleParser = async (src: Buffer): Promise<ParsedMail> => {
  const m: any = await import('mailparser')
  return (m.simpleParser ?? m.default?.simpleParser)(src)
}
import { randomUUID } from 'node:crypto'
import type { MailConfig, MailMessage, MailSummary, OtpCode } from '@shared/types'

const OTP_TTL_MS = 10 * 60_000
const MAX_AGE_MS = 15 * 60_000
const KEYWORDS = /(verification|verify|one[- ]?time|otp|passcode|security code|login code|launch code|device code|sign[- ]?in code|2fa|two[- ]factor|confirmation code|auth(entication)? code|your code|code is|access code|pin)/i
/** Marketing mails also say "code" — never treat those as one-time codes. */
const PROMO = /(promo|coupon|discount|voucher|referral|gift ?card)\s*code/i
const CODE = String.raw`\d{3}[ -]?\d{3}|[A-Z0-9]{3}-[A-Z0-9]{3,4}|\d{4,8}|[A-Z0-9]{6,8}`

/** Pull a one-time code out of an email. Returns null when the mail doesn't look like an OTP mail. */
export function extractCode(subject: string, body: string): string | null {
  const text = `${subject}\n${body}`.replace(/ /g, ' ')
  if (!KEYWORDS.test(text) || PROMO.test(text)) return null

  const candidates: { code: string; score: number }[] = []
  const add = (raw: string, score: number) => {
    const code = raw.replace(/[\s-]/g, '')
    if (code.length < 4 || code.length > 10) return
    if (!/\d/.test(code)) return
    if (/^(19|20)\d\d$/.test(code)) score -= 5 // looks like a year
    if (code.length === 6) score += 2
    candidates.push({ code, score })
  }

  // 1. Code right after a keyword: "Your verification code is 482 913"
  const near = new RegExp(String.raw`(code|otp|passcode|pin|verification)[^\n]{0,60}?\b(${CODE})\b`, 'gi')
  for (const m of text.matchAll(near)) add(m[2], 6)
  // 2. Code before a keyword: "482913 is your Google verification code"
  const before = /\b(\d{4,8})\b[^\n]{0,30}?(is your|verification|code|otp)/gi
  for (const m of text.matchAll(before)) add(m[1], 5)
  // 3. A line that is only a code
  for (const line of text.split('\n')) {
    const l = line.trim()
    if (new RegExp(`^(${CODE})$`).test(l)) add(l, 4)
  }
  // 4. Any 6-digit number in the subject
  const subj = subject.match(/\b\d{6}\b/)
  if (subj) add(subj[0], 3)

  if (!candidates.length) return null
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0].code
}

const INBOX_SIZE = 15

/** Crude but safe HTML → text (we never render mail HTML). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

function bodyText(p: ParsedMail): string {
  const t = p.text?.trim() || (typeof p.html === 'string' ? htmlToText(p.html) : '')
  return t.replace(/\r\n/g, '\n')
}

/** Hide one-time codes before any mail text is shown to an AI model. */
export function redactCodes(subject: string, text: string): string {
  const code = extractCode(subject, text)
  if (!code) return text
  const variants = code.length === 6 ? [code, `${code.slice(0, 3)} ${code.slice(3)}`, `${code.slice(0, 3)}-${code.slice(3)}`] : [code]
  let out = text
  for (const c of variants) out = out.split(c).join('[code hidden]')
  return out
}

export class MailWatcher {
  status: 'off' | 'connecting' | 'watching' | 'error' = 'off'
  error: string | null = null
  otps: OtpCode[] = []
  inbox: MailSummary[] = []
  private client: ImapFlow | null = null
  private retry: NodeJS.Timeout | null = null
  private expiry: NodeJS.Timeout | null = null
  private seen = new Set<string>()
  private connectedAt = 0

  constructor(
    private onChange: () => void,
    private onCode: (otp: OtpCode) => void,
    private onNewMail: (m: MailSummary) => void,
    private log: (kind: string, detail: string) => void
  ) {
    this.expiry = setInterval(() => {
      const before = this.otps.length
      this.otps = this.otps.filter(o => o.expiresAt > Date.now())
      if (this.otps.length !== before) this.onChange()
    }, 15_000)
  }

  async start(cfg: MailConfig, password: string | null): Promise<void> {
    await this.stop()
    if (!cfg.enabled || !cfg.user || !password) return
    this.status = 'connecting'
    this.error = null
    this.onChange()
    const client = new (await loadImap())({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: password },
      logger: false,
      tls: { rejectUnauthorized: true },
      emitLogs: false
    })
    this.client = client
    client.on('error', err => this.fail(err))
    client.on('close', () => {
      if (this.client === client && this.status === 'watching') this.fail(new Error('Connection closed'), cfg, password)
    })
    try {
      await client.connect()
      await client.mailboxOpen('INBOX', { readOnly: true })
      client.on('exists', () => void this.onExists())
      this.status = 'watching'
      this.connectedAt = Date.now()
      this.log('mail.connected', `${cfg.user}@${cfg.host}`)
      this.onChange()
      await this.checkRecent()
      await this.loadInbox()
    } catch (e) {
      this.fail(e as Error, cfg, password)
    }
  }

  private async onExists(): Promise<void> {
    await this.checkRecent()
    await this.loadInbox()
  }

  private fail(err: Error, cfg?: MailConfig, password?: string | null): void {
    this.status = 'error'
    this.error = err.message?.slice(0, 200) || 'Mail error'
    this.onChange()
    if (cfg && password && !this.retry) {
      this.retry = setTimeout(() => {
        this.retry = null
        void this.start(cfg, password)
      }, 60_000)
    }
  }

  /** Look at mails that arrived in the last few minutes (read-only, never marks as read). */
  private async checkRecent(): Promise<void> {
    const client = this.client
    if (!client?.usable) return
    const lock = await client.getMailboxLock('INBOX', { readOnly: true })
    try {
      const since = new Date(Date.now() - MAX_AGE_MS)
      const uids = (await client.search({ since }, { uid: true })) || []
      const recent = uids.slice(-10)
      if (!recent.length) return
      for await (const msg of client.fetch(recent, { envelope: true, source: true, internalDate: true, uid: true, flags: true }, { uid: true })) {
        const key = `${msg.uid}`
        if (this.seen.has(key)) continue
        this.seen.add(key)
        const date = msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now()
        if (Date.now() - date > MAX_AGE_MS || !msg.source) continue
        const parsed = await simpleParser(msg.source)
        const body = bodyText(parsed).slice(0, 20_000)
        const code = extractCode(parsed.subject ?? '', body)
        const from = parsed.from?.value?.[0]?.name || parsed.from?.value?.[0]?.address || 'Unknown sender'
        if (!code) {
          // Ordinary new mail — only announce ones that arrived after we connected.
          if (date >= this.connectedAt - 60_000) {
            this.onNewMail({
              uid: String(msg.uid),
              from,
              fromAddress: parsed.from?.value?.[0]?.address ?? '',
              subject: (parsed.subject ?? '(no subject)').slice(0, 160),
              date,
              preview: body.replace(/\s+/g, ' ').slice(0, 160),
              unread: !msg.flags?.has('\\Seen')
            })
          }
          continue
        }
        const otp: OtpCode = {
          id: randomUUID(),
          code,
          from,
          subject: (parsed.subject ?? '').slice(0, 120),
          receivedAt: date,
          expiresAt: date + OTP_TTL_MS
        }
        this.otps.unshift(otp)
        this.otps = this.otps.slice(0, 5)
        // Only metadata is audited — never the code itself.
        this.log('mail.otp', `Code detected from ${from}`)
        this.onCode(otp)
        this.onChange()
      }
    } catch (e) {
      this.error = (e as Error).message
    } finally {
      lock.release()
    }
  }

  /** Refresh the newest INBOX_SIZE messages (headers + short preview). */
  async loadInbox(): Promise<MailSummary[]> {
    const client = this.client
    if (!client?.usable) return this.inbox
    const lock = await client.getMailboxLock('INBOX', { readOnly: true })
    try {
      const exists = typeof client.mailbox === 'object' && client.mailbox ? client.mailbox.exists : 0
      if (!exists) {
        this.inbox = []
        return this.inbox
      }
      const range = `${Math.max(1, exists - INBOX_SIZE + 1)}:*`
      const out: MailSummary[] = []
      for await (const msg of client.fetch(range, { envelope: true, flags: true, internalDate: true, uid: true, source: { start: 0, maxLength: 24_000 } })) {
        let preview = ''
        try {
          if (msg.source) preview = bodyText(await simpleParser(msg.source)).replace(/\s+/g, ' ').slice(0, 180)
        } catch {
          /* partial source may not parse — preview stays empty */
        }
        const from = msg.envelope?.from?.[0]
        out.push({
          uid: String(msg.uid),
          from: from?.name || from?.address || 'Unknown sender',
          fromAddress: from?.address ?? '',
          subject: (msg.envelope?.subject ?? '(no subject)').slice(0, 160),
          date: msg.internalDate ? new Date(msg.internalDate).getTime() : 0,
          preview,
          unread: !msg.flags?.has('\\Seen')
        })
      }
      this.inbox = out.sort((a, b) => b.date - a.date)
      this.onChange()
      return this.inbox
    } catch (e) {
      this.error = (e as Error).message
      return this.inbox
    } finally {
      lock.release()
    }
  }

  /** Full text of one message. Uses BODY.PEEK, so it is never marked as read. */
  async read(uid: string): Promise<MailMessage> {
    const client = this.client
    if (!client?.usable) throw new Error('Inbox is not connected. Set it up in Settings → Inbox.')
    const lock = await client.getMailboxLock('INBOX', { readOnly: true })
    try {
      const msg = await client.fetchOne(uid, { envelope: true, flags: true, internalDate: true, uid: true, source: true }, { uid: true })
      if (!msg || !msg.source) throw new Error('Message not found.')
      const p = await simpleParser(msg.source)
      const text = bodyText(p).slice(0, 40_000)
      const from = p.from?.value?.[0]
      this.log('mail.read', `uid ${uid} from ${from?.address ?? '?'}`)
      return {
        uid,
        from: from?.name || from?.address || 'Unknown sender',
        fromAddress: from?.address ?? '',
        to: p.to ? (Array.isArray(p.to) ? p.to.map(t => t.text).join(', ') : p.to.text) : '',
        subject: p.subject ?? '(no subject)',
        date: msg.internalDate ? new Date(msg.internalDate).getTime() : 0,
        preview: text.replace(/\s+/g, ' ').slice(0, 180),
        unread: !msg.flags?.has('\\Seen'),
        text
      }
    } finally {
      lock.release()
    }
  }

  /** Mail text prepared for an AI prompt: codes hidden, size capped, wrapped as untrusted data. */
  async forAi(uids: string[]): Promise<string> {
    const parts: string[] = []
    for (const uid of uids.slice(0, 8)) {
      const m = await this.read(uid)
      const body = redactCodes(m.subject, m.text).slice(0, 3000)
      parts.push(`<email uid="${uid}">\nFrom: ${m.from} <${m.fromAddress}>\nDate: ${new Date(m.date).toLocaleString()}\nSubject: ${m.subject}\n\n${body}\n</email>`)
    }
    return parts.join('\n\n')
  }

  dismiss(id: string): void {
    this.otps = this.otps.filter(o => o.id !== id)
    this.onChange()
  }

  async stop(): Promise<void> {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const c = this.client
    this.client = null
    if (c) {
      try {
        await c.logout()
      } catch {
        c.close()
      }
    }
    if (this.status !== 'off') {
      this.status = 'off'
      this.onChange()
    }
  }

  wipe(): void {
    this.otps = []
    this.inbox = []
    this.onChange()
  }

  async test(cfg: MailConfig, password: string | null): Promise<{ ok: boolean; message: string }> {
    if (!cfg.user || !password) return { ok: false, message: 'Enter email and app password first.' }
    const c = new (await loadImap())({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: password }, logger: false })
    try {
      await c.connect()
      const st = await c.status('INBOX', { messages: true })
      await c.logout()
      return { ok: true, message: `Connected. INBOX has ${st ? st.messages : '?'} messages.` }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }
}

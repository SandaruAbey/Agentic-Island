import { shell } from 'electron'
import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { MailMessage, MailSummary, OtpCode } from '@shared/types'
import { extractCode, htmlToText, redactCodes } from './mail'

/**
 * "Sign in with Google" for Gmail, the way Google recommends for desktop apps:
 * the user's own browser opens Google's sign-in page (Isla never sees the password),
 * PKCE + a one-time loopback redirect on 127.0.0.1, and only the read-only Gmail scope.
 */
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'openid', 'email']
const OTP_TTL_MS = 10 * 60_000
const MAX_AGE_MS = 15 * 60_000
const POLL_MS = 30_000

export interface GoogleClient {
  clientId: string
  clientSecret: string
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Opens the browser, waits for Google to redirect back, returns the refresh token + account email. */
export function googleSignIn(client: GoogleClient): Promise<{ refreshToken: string; email: string }> {
  return new Promise((resolve, reject) => {
    const verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(16))
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/') {
        res.writeHead(404).end()
        return
      }
      const done = (ok: boolean, msg: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Agentic Island</title><body style="font-family:system-ui;background:#000;color:#f5f5f7;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${ok ? '✅ Gmail connected' : '⚠️ Sign-in failed'}</h2><p style="color:#8e8e93">${msg}</p></div></body>`
        )
        clearTimeout(timer)
        server.close()
      }
      if (url.searchParams.get('state') !== state) {
        done(false, 'Security check failed. Please try again from Isla.')
        return reject(new Error('State mismatch'))
      }
      const code = url.searchParams.get('code')
      if (!code) {
        done(false, url.searchParams.get('error') ?? 'No code received.')
        return reject(new Error(url.searchParams.get('error') ?? 'Sign-in cancelled'))
      }
      try {
        const port = (server.address() as AddressInfo).port
        const tok = await tokenRequest({
          code,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: `http://127.0.0.1:${port}`
        })
        if (!tok.refresh_token) throw new Error('Google did not return a refresh token.')
        const profile = await fetchJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', tok.access_token)
        done(true, 'You can close this tab and go back to Isla.')
        resolve({ refreshToken: tok.refresh_token, email: profile.emailAddress ?? '' })
      } catch (e) {
        done(false, (e as Error).message)
        reject(e)
      }
    })
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('Sign-in timed out.'))
    }, 5 * 60_000)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: `http://127.0.0.1:${port}`,
        response_type: 'code',
        scope: SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent'
      }).toString()
      void shell.openExternal(auth.toString())
    })
  })
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20_000)
  })
  const j = await res.json()
  if (!res.ok) throw new Error(j.error_description || j.error || `Google token error ${res.status}`)
  return j
}

async function fetchJson(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) })
  if (res.status === 401) throw Object.assign(new Error('unauthorized'), { code: 401 })
  if (!res.ok) throw new Error(`Gmail API error ${res.status}`)
  return res.json()
}

export async function revokeGoogle(refreshToken: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' }).catch(() => {})
}

const decode = (data?: string) => (data ? Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : '')

function bodyOf(payload: any): string {
  let plain = ''
  let html = ''
  const walk = (p: any) => {
    if (!p) return
    if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = decode(p.body.data)
    else if (p.mimeType === 'text/html' && p.body?.data && !html) html = decode(p.body.data)
    for (const c of p.parts ?? []) walk(c)
  }
  walk(payload)
  return (plain.trim() || htmlToText(html)).replace(/\r\n/g, '\n')
}

const header = (payload: any, name: string) => payload?.headers?.find((h: any) => h.name?.toLowerCase() === name)?.value ?? ''

function parseFrom(v: string): { name: string; address: string } {
  const m = v.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/)
  return m ? { name: m[1].trim() || m[2], address: m[2] } : { name: v, address: v }
}

/** Same surface as the IMAP MailWatcher, backed by the Gmail API (read-only). */
export class GmailWatcher {
  status: 'off' | 'connecting' | 'watching' | 'error' = 'off'
  error: string | null = null
  otps: OtpCode[] = []
  inbox: MailSummary[] = []
  private client: GoogleClient | null = null
  private refreshToken: string | null = null
  private access: { token: string; exp: number } | null = null
  private timer: NodeJS.Timeout | null = null
  private seen = new Set<string>()
  private connectedAt = 0

  constructor(
    private onChange: () => void,
    private onCode: (otp: OtpCode) => void,
    private onNewMail: (m: MailSummary) => void,
    private log: (kind: string, detail: string) => void
  ) {
    setInterval(() => {
      const n = this.otps.length
      this.otps = this.otps.filter(o => o.expiresAt > Date.now())
      if (this.otps.length !== n) this.onChange()
    }, 15_000)
  }

  async start(client: GoogleClient, refreshToken: string | null): Promise<void> {
    await this.stop()
    if (!client.clientId || !refreshToken) return
    this.client = client
    this.refreshToken = refreshToken
    this.status = 'connecting'
    this.error = null
    this.onChange()
    try {
      await this.loadInbox(true)
      for (const m of this.inbox) this.seen.add(m.uid)
      this.connectedAt = Date.now()
      this.status = 'watching'
      this.log('mail.connected', 'Gmail (read-only API)')
      this.onChange()
      this.timer = setInterval(() => void this.poll(), POLL_MS)
    } catch (e) {
      this.status = 'error'
      this.error = (e as Error).message
      this.onChange()
    }
  }

  private async token(): Promise<string> {
    if (this.access && this.access.exp > Date.now() + 60_000) return this.access.token
    if (!this.client || !this.refreshToken) throw new Error('Not signed in to Google.')
    const t = await tokenRequest({
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token'
    }).catch(e => {
      throw new Error(/invalid_grant/i.test(String(e.message)) ? 'Google sign-in expired — click "Sign in with Google" again.' : e.message)
    })
    this.access = { token: t.access_token, exp: Date.now() + (t.expires_in ?? 3600) * 1000 }
    return this.access.token
  }

  private async api(path: string): Promise<any> {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/${path}`
    try {
      return await fetchJson(url, await this.token())
    } catch (e) {
      if ((e as { code?: number }).code === 401) {
        this.access = null
        return fetchJson(url, await this.token())
      }
      throw e
    }
  }

  private summary(m: any): MailSummary {
    const from = parseFrom(header(m.payload, 'from'))
    return {
      uid: m.id,
      from: from.name || 'Unknown sender',
      fromAddress: from.address,
      subject: (header(m.payload, 'subject') || '(no subject)').slice(0, 160),
      date: Number(m.internalDate) || 0,
      preview: String(m.snippet ?? '')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .slice(0, 180),
      unread: (m.labelIds ?? []).includes('UNREAD')
    }
  }

  async loadInbox(throwOnError = false): Promise<MailSummary[]> {
    try {
      const list = await this.api('messages?labelIds=INBOX&maxResults=15')
      const ids: string[] = (list.messages ?? []).map((m: any) => m.id)
      const out: MailSummary[] = []
      for (const id of ids) {
        const m = await this.api(`messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)
        out.push(this.summary(m))
      }
      this.inbox = out.sort((a, b) => b.date - a.date)
      this.onChange()
    } catch (e) {
      this.error = (e as Error).message
      if (throwOnError) throw e
    }
    return this.inbox
  }

  /** New messages since last poll: detect codes, announce ordinary mail. */
  private async poll(): Promise<void> {
    try {
      const list = await this.api('messages?labelIds=INBOX&maxResults=10')
      const fresh: string[] = (list.messages ?? []).map((m: any) => m.id).filter((id: string) => !this.seen.has(id))
      if (!fresh.length) return
      for (const id of fresh) {
        this.seen.add(id)
        const full = await this.api(`messages/${id}?format=full`)
        const date = Number(full.internalDate) || Date.now()
        if (Date.now() - date > MAX_AGE_MS || date < this.connectedAt - 60_000) continue
        const s = this.summary(full)
        const code = extractCode(s.subject, bodyOf(full.payload).slice(0, 20_000))
        if (code) {
          const otp: OtpCode = { id: randomUUID(), code, from: s.from, subject: s.subject.slice(0, 120), receivedAt: date, expiresAt: date + OTP_TTL_MS }
          this.otps = [otp, ...this.otps].slice(0, 5)
          this.log('mail.otp', `Code detected from ${s.from}`)
          this.onCode(otp)
        } else this.onNewMail(s)
      }
      await this.loadInbox()
    } catch (e) {
      this.error = (e as Error).message
      this.onChange()
    }
  }

  async read(id: string): Promise<MailMessage> {
    const m = await this.api(`messages/${encodeURIComponent(id)}?format=full`)
    const s = this.summary(m)
    const text = bodyOf(m.payload).slice(0, 40_000)
    this.log('mail.read', `gmail ${id} from ${s.fromAddress}`)
    return { ...s, to: header(m.payload, 'to'), text, preview: text.replace(/\s+/g, ' ').slice(0, 180) }
  }

  async forAi(ids: string[]): Promise<string> {
    const parts: string[] = []
    for (const id of ids.slice(0, 8)) {
      const m = await this.read(id)
      const body = redactCodes(m.subject, m.text).slice(0, 3000)
      parts.push(`<email id="${id}">\nFrom: ${m.from} <${m.fromAddress}>\nDate: ${new Date(m.date).toLocaleString()}\nSubject: ${m.subject}\n\n${body}\n</email>`)
    }
    return parts.join('\n\n')
  }

  dismiss(id: string): void {
    this.otps = this.otps.filter(o => o.id !== id)
    this.onChange()
  }

  wipe(): void {
    this.otps = []
    this.inbox = []
    this.onChange()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.access = null
    if (this.status !== 'off') {
      this.status = 'off'
      this.onChange()
    }
  }
}

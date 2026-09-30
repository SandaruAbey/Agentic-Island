import type { MailConfig, MailMessage, MailSummary } from '@shared/types'
import type { MailWatcher } from './mail'
import type { GmailWatcher, GoogleClient } from './google'

/** One mailbox for the rest of the app: Gmail (Sign in with Google) or any IMAP account. */
export class MailHub {
  constructor(
    private imap: MailWatcher,
    private gmail: GmailWatcher,
    private google: () => { client: GoogleClient; refreshToken: string | null }
  ) {}

  private get active(): MailWatcher | GmailWatcher {
    return this.provider === 'google' ? this.gmail : this.imap
  }
  private provider: MailConfig['provider'] = 'imap'

  get status() {
    return this.active.status
  }
  get error() {
    return this.active.error
  }
  get otps() {
    return this.active.otps
  }
  get inbox() {
    return this.active.inbox
  }

  async start(cfg: MailConfig, imapPassword: string | null): Promise<void> {
    this.provider = cfg.provider
    if (cfg.provider === 'google') {
      await this.imap.stop()
      const g = this.google()
      if (cfg.enabled) await this.gmail.start(g.client, g.refreshToken)
      else await this.gmail.stop()
    } else {
      await this.gmail.stop()
      await this.imap.start(cfg, imapPassword)
    }
  }

  async stop(): Promise<void> {
    await Promise.all([this.imap.stop(), this.gmail.stop()])
  }
  loadInbox(): Promise<MailSummary[]> {
    return this.active.loadInbox()
  }
  read(id: string): Promise<MailMessage> {
    return this.active.read(id)
  }
  forAi(ids: string[]): Promise<string> {
    return this.active.forAi(ids)
  }
  dismiss(id: string): void {
    this.active.dismiss(id)
  }
  wipe(): void {
    this.imap.wipe()
    this.gmail.wipe()
  }
  test(cfg: MailConfig, password: string | null) {
    return this.imap.test(cfg, password)
  }
}

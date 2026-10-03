import { useEffect, useState } from 'react'
import type { IslandSnapshot, MailMessage, MailSummary, PanelId } from '@shared/types'
import { Icon, Shimmer, timeAgo, cleanErr } from '../components/ui'

export function MailPanel({ snap, open, initialUid }: { snap: IslandSnapshot; open: (p: PanelId) => void; initialUid?: string | null }) {
  const [copied, setCopied] = useState<string | null>(null)
  const [reading, setReading] = useState<MailMessage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const m = snap.settings.mail

  const openMail = async (uid: string) => {
    setLoading(true)
    setError(null)
    try {
      setReading(await window.island.readMail(uid))
    } catch (e) {
      setError(cleanErr(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (initialUid) void openMail(initialUid)
  }, [initialUid])

  if (reading) return <MailReader message={reading} onBack={() => setReading(null)} open={open} />

  const statusText =
    snap.mailStatus === 'watching'
      ? `Connected · ${m.user}`
      : snap.mailStatus === 'connecting'
        ? 'Connecting…'
        : snap.mailStatus === 'error'
          ? `Error: ${snap.mailError}`
          : 'Inbox not connected'

  return (
    <div className="codes">
      <div className="row-between">
        <span className={`mail-status ${snap.mailStatus}`}>
          <span className="dot" /> {statusText}
        </span>
        <div className="inline">
          {snap.mailStatus === 'watching' && (
            <button className="link" onClick={() => void window.island.refreshInbox()}>
              <Icon name="refresh" size={12} /> Refresh
            </button>
          )}
          <button className="link" onClick={() => open('settings')}>
            Settings
          </button>
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}

      {snap.otps.length > 0 && (
        <>
          <h3 className="label">Verification codes</h3>
          <ul className="otp-list">
            {snap.otps.map(o => (
              <li key={o.id} className="otp">
                <div className="otp-meta">
                  <strong>{o.from}</strong>
                  <span className="muted">{o.subject}</span>
                  <span className="muted small">
                    {timeAgo(o.receivedAt)} · expires in {Math.max(0, Math.round((o.expiresAt - Date.now()) / 60_000))} min
                  </span>
                </div>
                <code className="otp-code">{o.code}</code>
                <button
                  className={`btn ${copied === o.id ? 'green' : 'primary'} round`}
                  onClick={() =>
                    void window.island.copyOtp(o.id).then(() => {
                      setCopied(o.id)
                      setTimeout(() => setCopied(null), 2000)
                    })
                  }
                >
                  <Icon name={copied === o.id ? 'check' : 'copy'} size={14} /> {copied === o.id ? 'Copied' : 'Copy'}
                </button>
                <button className="icon-btn subtle" title="Dismiss" onClick={() => void window.island.dismissOtp(o.id)}>
                  <Icon name="close" size={13} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {snap.mailStatus === 'off' || (snap.mailStatus === 'error' && !snap.inbox.length) ? (
        <div className="empty tall">
          <Icon name="mail" size={28} />
          <p>Connect your inbox and Isla can read your latest mail, summarize it, draft replies and catch sign-in codes.</p>
          <p className="muted small">Read-only: nothing is ever sent, deleted or marked as read. Codes are never shown to an AI.</p>
          <button className="btn primary" onClick={() => open('settings')}>
            Connect inbox
          </button>
        </div>
      ) : (
        <>
          <div className="row-between">
            <h3 className="label">Inbox</h3>
            {snap.inbox.length > 0 && (
              <button
                className="link"
                onClick={() =>
                  void window.island
                    .requestRun({
                      title: 'Summarize my inbox',
                      prompt: 'Summarize these emails. Group them into: needs my reply, FYI, and can ignore. One line each.',
                      context: 'general',
                      mailUids: snap.inbox.slice(0, 8).map(x => x.uid)
                    })
                    .then(() => open('agent'))
                    .catch(e => setError(cleanErr(e)))
                }
              >
                <Icon name="spark" size={12} /> Summarize inbox
              </button>
            )}
          </div>
          <MailList messages={snap.inbox} onOpen={uid => void openMail(uid)} loading={loading} />
        </>
      )}
    </div>
  )
}

export function MailList({ messages, onOpen, loading }: { messages: MailSummary[]; onOpen: (uid: string) => void; loading?: boolean }) {
  if (!messages.length) return <div className="empty">{loading ? <Shimmer>Loading…</Shimmer> : 'No messages yet.'}</div>
  return (
    <ul className="mail-list">
      {messages.map(x => (
        <li key={x.uid}>
          <button className={x.unread ? 'unread' : ''} onClick={() => onOpen(x.uid)}>
            <span className="mail-from">
              {x.unread && <i className="unread-dot" />}
              {x.from}
            </span>
            <span className="mail-date">{x.date ? timeAgo(x.date) : ''}</span>
            <span className="mail-subject">{x.subject}</span>
            <span className="mail-preview">{x.preview}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function MailReader({ message, onBack, open }: { message: MailMessage; onBack?: () => void; open: (p: PanelId) => void }) {
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const ai = (title: string, prompt: string) =>
    window.island
      .requestRun({ title: `${title}: ${message.subject}`.slice(0, 80), prompt, context: 'general', mailUids: [message.uid] })
      .then(() => open('agent'))
      .catch(e => setError(cleanErr(e)))

  return (
    <div className="reader">
      <div className="reader-head">
        {onBack && (
          <button className="icon-btn" title="Back to inbox" onClick={onBack}>
            <Icon name="back" size={15} />
          </button>
        )}
        <div className="reader-meta">
          <strong className="reader-subject">{message.subject}</strong>
          <span className="muted small">
            {message.from} {message.fromAddress && `<${message.fromAddress}>`} · {message.date ? new Date(message.date).toLocaleString() : ''}
          </span>
        </div>
      </div>
      <div className="reader-actions">
        <button className="btn ghost sm" onClick={() => void ai('Summary', 'Summarize this email in 3 short bullets, then list anything I need to do and by when.')}>
          <Icon name="spark" size={12} /> Summarize
        </button>
        <button className="btn ghost sm" onClick={() => void ai('Reply', 'Draft a short, polite reply to this email in the same language. Output only the reply text, ready to paste.')}>
          <Icon name="chat" size={12} /> Draft reply
        </button>
        <button
          className="btn ghost sm"
          onClick={() =>
            void window.island.copyText(message.text).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'Copied' : 'Copy text'}
        </button>
      </div>
      {error && <div className="alert error">{error}</div>}
      <pre className="reader-body">{message.text || '(This email has no text content.)'}</pre>
    </div>
  )
}

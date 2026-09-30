import { useEffect, useState } from 'react'
import type { AppPermission, InstalledApp, IslandSnapshot, ProviderId, ProviderStatus, Settings } from '@shared/types'
import { Icon, Section, Segmented, Toggle, cleanErr } from '../components/ui'

type Tab = 'agents' | 'workspaces' | 'inbox' | 'general' | 'permissions'

export function SettingsPanel({ snap, onTyping }: { snap: IslandSnapshot; onTyping: (v: boolean) => void }) {
  const [tab, setTab] = useState<Tab>('agents')
  const focus = { onFocus: () => onTyping(true), onBlur: () => onTyping(false) }
  return (
    <div className="settings">
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'agents', label: 'Agents & models' },
          { value: 'workspaces', label: 'Workspaces' },
          { value: 'inbox', label: 'Inbox' },
          { value: 'general', label: 'General' },
          { value: 'permissions', label: 'App permissions' }
        ]}
      />
      {tab === 'agents' && <Agents snap={snap} focus={focus} />}
      {tab === 'workspaces' && <Workspaces snap={snap} />}
      {tab === 'inbox' && <Inbox snap={snap} focus={focus} />}
      {tab === 'general' && <General s={snap.settings} snap={snap} />}
      {tab === 'permissions' && <AppPermissions snap={snap} />}
    </div>
  )
}

type Focus = { onFocus: () => void; onBlur: () => void }

function Agents({ snap, focus }: { snap: IslandSnapshot; focus: Focus }) {
  const s = snap.settings
  const [refreshing, setRefreshing] = useState(false)
  return (
    <>
      <div className="row-between">
        <p className="muted small">Isla drives the agents already installed on this PC. Pick the default one and the model it should use.</p>
        <button
          className="link"
          onClick={() => {
            setRefreshing(true)
            void window.island.refreshProviders().finally(() => setRefreshing(false))
          }}
        >
          <Icon name="refresh" size={12} /> {refreshing ? 'Detecting…' : 'Re-detect'}
        </button>
      </div>
      <div className="providers">
        {snap.providers.map(p => (
          <ProviderCard key={p.id} p={p} s={s} active={s.activeProvider === p.id} focus={focus} />
        ))}
      </div>
    </>
  )
}

function ProviderCard({ p, s, active, focus }: { p: ProviderStatus; s: Settings; active: boolean; focus: Focus }) {
  const cfg = s.providers[p.id]
  const [model, setModel] = useState(cfg.model)
  const [command, setCommand] = useState(cfg.command)
  const [args, setArgs] = useState(p.id === 'custom' ? s.providers.custom.args.join(' ') : '')
  useEffect(() => setModel(cfg.model), [cfg.model])

  const patch = (v: Partial<Settings['providers'][ProviderId]> & { args?: string[]; label?: string }) =>
    void window.island.updateSettings({ providers: { [p.id]: v } } as Partial<Settings>)

  return (
    <div className={`provider ${active ? 'active' : ''} ${p.installed ? '' : 'missing'}`}>
      <div className="provider-head">
        <button className={`radio ${active ? 'on' : ''}`} aria-label={`Use ${p.label} by default`} onClick={() => void window.island.updateSettings({ activeProvider: p.id })} />
        <div>
          <strong>{p.label}</strong>
          <span className="muted small">{p.installed ? `${p.version ?? 'installed'} · ${p.path}` : 'Not found on this PC'}</span>
        </div>
        <Toggle label={`Enable ${p.label}`} checked={cfg.enabled} onChange={v => patch({ enabled: v })} />
      </div>

      {p.headless ? (
        <div className="provider-grid">
          <label>
            <span>Model</span>
            <input
              list={`models-${p.id}`}
              value={model}
              placeholder="CLI default"
              spellCheck={false}
              {...focus}
              onChange={e => setModel(e.target.value)}
              onBlur={() => {
                focus.onBlur()
                if (model !== cfg.model) patch({ model: model.trim() })
              }}
              onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <datalist id={`models-${p.id}`}>
              {p.modelSuggestions.map(m => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label>
            <span>Permissions</span>
            <Segmented
              value={cfg.mode}
              onChange={v => {
                if (v === 'edit' && !confirm(`Allow ${p.label} to edit files inside your allowlisted workspaces? You still approve every task.`)) return
                patch({ mode: v })
              }}
              options={[
                { value: 'readonly', label: 'Read-only' },
                { value: 'edit', label: 'Can edit' }
              ]}
            />
          </label>
          <label className="wide">
            <span>Executable override (optional)</span>
            <input
              value={command}
              placeholder={p.id === 'custom' ? 'C:\\path\\to\\agent.exe' : 'Auto-detected'}
              spellCheck={false}
              {...focus}
              onChange={e => setCommand(e.target.value)}
              onBlur={() => {
                focus.onBlur()
                if (command !== cfg.command) patch({ command: command.trim() })
              }}
            />
          </label>
          {p.id === 'custom' && (
            <label className="wide">
              <span>Arguments — use {'{model}'}; the prompt is sent on stdin</span>
              <input
                value={args}
                placeholder="run --model {model}"
                spellCheck={false}
                {...focus}
                onChange={e => setArgs(e.target.value)}
                onBlur={() => {
                  focus.onBlur()
                  patch({ args: args.split(/\s+/).filter(Boolean) })
                }}
              />
            </label>
          )}
        </div>
      ) : (
        <p className="muted small provider-note">
          Antigravity is an IDE, so Isla opens your workspace in it and puts the prompt on your clipboard. Choose the model inside Antigravity's
          agent panel (Gemini, Claude or GPT models).
        </p>
      )}
    </div>
  )
}

function Workspaces({ snap }: { snap: IslandSnapshot }) {
  const s = snap.settings
  return (
    <Section
      title="Allowlisted workspaces"
      right={
        <button className="btn ghost sm" onClick={() => void window.island.addWorkspace()}>
          <Icon name="folder" size={12} /> Add folder
        </button>
      }
    >
      <p className="muted small">Agents and git actions only ever run inside these folders.</p>
      {s.workspaces.length === 0 ? (
        <div className="empty">No folders yet.</div>
      ) : (
        <ul className="ws-list">
          {s.workspaces.map(w => (
            <li key={w} className={w === s.activeWorkspace ? 'active' : ''}>
              <button className={`radio ${w === s.activeWorkspace ? 'on' : ''}`} aria-label="Make active" onClick={() => void window.island.setActiveWorkspace(w)} />
              <span>{w}</span>
              <button className="icon-btn subtle" title="Remove" onClick={() => void window.island.removeWorkspace(w)}>
                <Icon name="close" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

/** Known providers: server settings + where to create an app password. */
const PROVIDERS_BY_DOMAIN: { match: RegExp; name: string; host: string; appPasswordUrl?: string; note?: string }[] = [
  { match: /@(gmail|googlemail)\.com$/i, name: 'Gmail', host: 'imap.gmail.com', appPasswordUrl: 'https://myaccount.google.com/apppasswords' },
  { match: /@yahoo\./i, name: 'Yahoo', host: 'imap.mail.yahoo.com', appPasswordUrl: 'https://login.yahoo.com/account/security' },
  { match: /@(icloud|me|mac)\.com$/i, name: 'iCloud', host: 'imap.mail.me.com', appPasswordUrl: 'https://account.apple.com' },
  {
    match: /@(outlook|hotmail|live|msn)\./i,
    name: 'Outlook.com',
    host: 'outlook.office365.com',
    note: 'Microsoft has turned off app passwords for most Outlook.com accounts, so IMAP may be refused. Screen reading still works: open Outlook in your browser and Isla offers “Summarize this email”.'
  },
  { match: /@(zoho)\./i, name: 'Zoho', host: 'imap.zoho.com' }
]

function Inbox({ snap, focus }: { snap: IslandSnapshot; focus: Focus }) {
  const m = snap.settings.mail
  const [form, setForm] = useState({ host: m.host, port: String(m.port), user: m.user, secure: m.secure, clear: String(m.clipboardClearSeconds) })
  const [pw, setPw] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [showImap, setShowImap] = useState(m.provider === 'imap' && !!m.user)
  const [showClient, setShowClient] = useState(false)
  const [client, setClient] = useState({ id: snap.settings.google.clientId, secret: snap.settings.google.clientSecret })
  const known = PROVIDERS_BY_DOMAIN.find(p => p.match.test(form.user.trim()))
  const googleConnected = m.provider === 'google' && !!m.googleEmail

  const save = () =>
    window.island.updateSettings({
      mail: {
        provider: 'imap',
        host: form.host.trim(),
        port: Number(form.port) || 993,
        user: form.user.trim(),
        secure: form.secure,
        clipboardClearSeconds: Math.max(10, Math.min(600, Number(form.clear) || 45))
      }
    })

  const signIn = async () => {
    setBusy(true)
    setMsg({ ok: true, text: 'Your browser opened Google’s sign-in page — choose your account and allow read-only access…' })
    const r = await window.island.googleSignIn().catch(e => ({ ok: false, message: cleanErr(e), needsSetup: false }))
    setBusy(false)
    if (r.needsSetup) {
      setShowClient(true)
      setMsg({ ok: false, text: 'Google sign-in needs a one-time app registration first (see below).' })
    } else setMsg({ ok: r.ok, text: r.ok ? `${r.message} — Isla can now read your Gmail.` : r.message })
  }

  return (
    <>
      <div className="google-card">
        <div>
          <strong>Gmail</strong>
          <p className="muted small">
            {googleConnected
              ? `Connected as ${m.googleEmail} · read-only · ${snap.mailStatus === 'watching' ? 'watching' : snap.mailStatus}`
              : 'One click: sign in on Google’s own page in your browser. Isla never sees your password and can only read mail — never send, delete or mark as read.'}
          </p>
        </div>
        {googleConnected ? (
          <div className="inline">
            <Toggle label="Watch Gmail" checked={m.enabled} onChange={v => void window.island.updateSettings({ mail: { enabled: v, provider: 'google' } })} />
            <button className="btn ghost sm" onClick={() => void window.island.googleSignOut()}>
              Sign out
            </button>
          </div>
        ) : (
          <button className="btn google" disabled={busy} onClick={() => void signIn()}>
            <GoogleG /> {busy ? 'Waiting for Google…' : 'Sign in with Google'}
          </button>
        )}
      </div>
      {msg && <div className={`alert ${msg.ok ? 'info' : 'error'}`}>{msg.text}</div>}

      {(showClient || !snap.googleReady) && !googleConnected && (
        <details className="client-setup" open={showClient}>
          <summary>One-time setup for “Sign in with Google” (for the person who builds Isla)</summary>
          <ol className="muted small">
            <li>
              Open{' '}
              <button className="link" onClick={() => void window.island.openUrl('https://console.cloud.google.com/apis/library/gmail.googleapis.com')}>
                Google Cloud Console → Gmail API
              </button>{' '}
              and click <b>Enable</b> (create a project if asked).
            </li>
            <li>
              <b>OAuth consent screen</b>: External, app name “Agentic Island”, add your Gmail as a <b>test user</b>.
            </li>
            <li>
              <b>Credentials → Create credentials → OAuth client ID → Desktop app</b>, then paste the ID and secret here (or save the downloaded JSON as{' '}
              <code>build/google-oauth.json</code> before building, so users never see this step).
            </li>
          </ol>
          <div className="provider-grid">
            <label className="wide">
              <span>Client ID</span>
              <input value={client.id} spellCheck={false} {...focus} onChange={e => setClient({ ...client, id: e.target.value.trim() })} />
            </label>
            <label className="wide">
              <span>Client secret</span>
              <input value={client.secret} type="password" spellCheck={false} {...focus} onChange={e => setClient({ ...client, secret: e.target.value.trim() })} />
            </label>
          </div>
          <div className="actions">
            <button
              className="btn primary"
              disabled={!client.id}
              onClick={() => void window.island.updateSettings({ google: { clientId: client.id, clientSecret: client.secret } }).then(signIn)}
            >
              Save & sign in
            </button>
          </div>
        </details>
      )}

      <button className="link other-mail" onClick={() => setShowImap(v => !v)}>
        <Icon name="chevron" size={12} className={showImap ? 'chev-up' : 'chev-down'} /> Other email (Yahoo, iCloud, work mail…)
      </button>
      {showImap && (
        <>
          <div className="provider-grid">
            <label className="wide">
              <span>Email address {known && <em className="ok">· {known.name} detected</em>}</span>
              <input
                value={form.user}
                type="email"
                placeholder="you@example.com"
                {...focus}
                onChange={e => {
                  const user = e.target.value
                  const k = PROVIDERS_BY_DOMAIN.find(p => p.match.test(user.trim()))
                  setForm({ ...form, user, ...(k ? { host: k.host, port: '993', secure: true } : {}) })
                }}
              />
            </label>
            <label className="wide">
              <span>
                App password {m.hasPassword && <em className="ok">· stored encrypted</em>}
                {known?.appPasswordUrl && (
                  <button className="link inline-link" onClick={() => void window.island.openUrl(known.appPasswordUrl!)}>
                    Get an app password for {known.name} ↗
                  </button>
                )}
              </span>
              <div className="inline">
                <input
                  type="password"
                  value={pw}
                  autoComplete="off"
                  placeholder={m.hasPassword ? '••••••••••••' : 'An app password — not your normal password'}
                  {...focus}
                  onChange={e => setPw(e.target.value)}
                />
                <button
                  className="btn primary sm"
                  disabled={!pw || !form.user}
                  onClick={async () => {
                    await save()
                    const ok = await window.island.setMailPassword(pw)
                    setPw('')
                    await window.island.updateSettings({ mail: { enabled: true, provider: 'imap' } })
                    const r = await window.island.testMail().catch(e => ({ ok: false, message: cleanErr(e) }))
                    setMsg({ ok: ok && r.ok, text: ok ? r.message : 'Encryption is not available on this system.' })
                  }}
                >
                  Connect
                </button>
                {m.hasPassword && (
                  <button className="btn ghost sm" onClick={() => void window.island.clearMailPassword()}>
                    Forget
                  </button>
                )}
              </div>
            </label>
            {known?.note && <p className="muted small wide">{known.note}</p>}
          </div>
          <details className="client-setup">
            <summary>Advanced server settings</summary>
            <div className="provider-grid">
              <label>
                <span>IMAP server</span>
                <input value={form.host} {...focus} onChange={e => setForm({ ...form, host: e.target.value })} />
              </label>
              <label>
                <span>Port</span>
                <input value={form.port} inputMode="numeric" {...focus} onChange={e => setForm({ ...form, port: e.target.value })} />
              </label>
              <label>
                <span>TLS</span>
                <Toggle label="Use TLS" checked={form.secure} onChange={v => setForm({ ...form, secure: v })} />
              </label>
              <label>
                <span>Wipe copied codes after (s)</span>
                <input value={form.clear} inputMode="numeric" {...focus} onChange={e => setForm({ ...form, clear: e.target.value })} />
              </label>
            </div>
            <div className="actions">
              <button className="btn ghost" onClick={() => void save().then(() => setMsg({ ok: true, text: 'Saved.' }))}>
                Save
              </button>
            </div>
          </details>
        </>
      )}
      <p className="muted small">
        No setup at all? Just open your mail in the browser — Isla reads the screen and offers “Summarize this email” and “Draft a reply”.
      </p>
    </>
  )
}

function GoogleG() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.3 13.5 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.3 5.7c4.3-4 7-9.9 7-17.1z" />
      <path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.8-6z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2.2 1.5-5 2.3-8.6 2.3-6.3 0-11.7-4-13.5-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z" />
    </svg>
  )
}

function General({ s, snap }: { s: Settings; snap: IslandSnapshot }) {
  const headless = snap.providers.filter(p => p.headless && p.installed)
  const setA = (v: Partial<Settings['assistant']>) => void window.island.updateSettings({ assistant: v })
  return (
    <div className="general">
      <div className="row-between">
        <div>
          <strong>Assistant for everyday questions</strong>
          <p className="muted small">
            Answers General questions (mail, writing, explaining). Antigravity only works inside its IDE, so a background agent is used here.
            {snap.assistantProvider ? '' : ' No background agent found — install Claude Code, Codex CLI or Gemini CLI.'}
          </p>
        </div>
        <select
          className="narrow"
          value={s.assistant.provider}
          aria-label="Assistant agent"
          onChange={e => setA({ provider: e.target.value as Settings['assistant']['provider'] })}
        >
          <option value="auto">Automatic{snap.assistantProvider ? ` (${snap.providers.find(p => p.id === snap.assistantProvider)?.label})` : ''}</option>
          {headless.map(p => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="row-between">
        <div>
          <strong>Now playing</strong>
          <p className="muted small">Show music and videos (YouTube, Spotify, any player in the Windows media flyout) with play/pause, next and previous.</p>
        </div>
        <Toggle label="Now playing" checked={s.mediaControls} onChange={v => void window.island.updateSettings({ mediaControls: v })} />
      </div>
      <div className="row-between">
        <div>
          <strong>Read my screen</strong>
          <p className="muted small">
            Every ~20 s Isla reads the window in front with Windows’ built-in OCR — on this PC, free, no tokens. Password managers, banking and
            private windows are always skipped. Screenshots are never sent to an AI.
          </p>
        </div>
        <Toggle label="Read my screen" checked={s.assistant.screenWatch} onChange={v => setA({ screenWatch: v })} />
      </div>
      <div className="row-between">
        <div>
          <strong>AI next-step ideas</strong>
          <p className="muted small">
            When the screen settles, a small model looks at a short, redacted text snippet (~1k tokens) and suggests one next step. Used today:{' '}
            {snap.background.tokensToday.toLocaleString()} tokens · ${snap.background.costToday.toFixed(3)} · {snap.background.callsLastHour}/
            {snap.background.limitPerHour} checks this hour.
          </p>
        </div>
        <Toggle label="AI next-step ideas" checked={s.assistant.aiInsights} onChange={v => setA({ aiInsights: v })} />
      </div>
      <div className="provider-grid">
        <label>
          <span>Max background AI checks per hour</span>
          <select value={s.assistant.aiChecksPerHour} onChange={e => setA({ aiChecksPerHour: Number(e.target.value) })}>
            {[3, 6, 10, 20, 40].map(n => (
              <option key={n} value={n}>
                {n} per hour
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Background model (cheap is best)</span>
          <input
            defaultValue={s.assistant.backgroundModel}
            placeholder="haiku"
            spellCheck={false}
            onBlur={e => e.target.value.trim() !== s.assistant.backgroundModel && setA({ backgroundModel: e.target.value.trim() })}
          />
        </label>
      </div>
      <div>
        <strong>Usage ring limits</strong>
        <p className="muted small">
          Rings in the island show today (inner) and this week (outer) per AI, with the time until reset in the middle. Codex reports its real
          limits; for Claude Code enter your own token limits, or leave 0 to compare with your busiest day / week.
        </p>
      </div>
      <div className="row-between">
        <div>
          <strong>Real Claude plan usage</strong>
          <p className="muted small">
            Show the same Session (5h) and Weekly numbers as Claude’s /usage, using the sign-in Claude Code already keeps on this PC. It is only
            sent to api.anthropic.com, checked every few minutes, never stored or logged by Isla.
          </p>
        </div>
        <Toggle
          label="Real Claude plan usage"
          checked={s.usageLimits.readPlanUsage}
          onChange={v => void window.island.updateSettings({ usageLimits: { readPlanUsage: v } })}
        />
      </div>
      <div className="provider-grid">
        {(
          [
            ['claudeDaily', 'Claude Code · tokens per day'],
            ['claudeWeekly', 'Claude Code · tokens per week'],
            ['codexDaily', 'Codex · tokens per day'],
            ['codexWeekly', 'Codex · tokens per week']
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            <span>{label}</span>
            <input
              inputMode="numeric"
              defaultValue={String(s.usageLimits[key])}
              onBlur={e => {
                const v = Math.max(0, Math.round(Number(e.target.value.replace(/[^\d.]/g, '')) || 0))
                if (v !== s.usageLimits[key]) void window.island.updateSettings({ usageLimits: { [key]: v } })
              }}
            />
          </label>
        ))}
        {(
          [
            ['antigravityDaily', 'Antigravity · tokens per day'],
            ['antigravityWeekly', 'Antigravity · tokens per week']
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            <span>{label}</span>
            <input
              inputMode="numeric"
              defaultValue={String(s.usageLimits[key])}
              onBlur={e => {
                const v = Math.max(0, Math.round(Number(e.target.value.replace(/[^\d.]/g, '')) || 0))
                if (v !== s.usageLimits[key]) void window.island.updateSettings({ usageLimits: { [key]: v } })
              }}
            />
          </label>
        ))}
        <label>
          <span>Week starts on</span>
          <select value={s.usageLimits.weekStartDay} onChange={e => void window.island.updateSettings({ usageLimits: { weekStartDay: Number(e.target.value) } })}>
            {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row-between">
        <div>
          <strong>Review my changes and offer Commit & push</strong>
          <p className="muted small">When your edits settle, Isla scans them locally for secrets, writes a commit message and pops up a Commit & push button.</p>
        </div>
        <Toggle label="Review changes" checked={s.assistant.autoReviewCommits} onChange={v => setA({ autoReviewCommits: v })} />
      </div>
      <div className="row-between">
        <div>
          <strong>Notice what I’m doing</strong>
          <p className="muted small">
            Isla looks at the app in front (e.g. a sign-in page, your mail, an IDE project) to offer the right help. Window titles never leave this PC.
          </p>
        </div>
        <Toggle label="Context awareness" checked={s.assistant.contextAware} onChange={v => setA({ contextAware: v })} />
      </div>
      <div className="row-between">
        <div>
          <strong>New mail alerts</strong>
          <p className="muted small">Peek from the island when a new email arrives.</p>
        </div>
        <Toggle label="New mail alerts" checked={s.assistant.mailNotifications} onChange={v => setA({ mailNotifications: v })} />
      </div>
      <div className="row-between">
        <div>
          <strong>Skip approval for simple General questions</strong>
          <p className="muted small">
            Read-only questions with no private data run immediately. Anything that includes your emails, or edits files, always asks first.
          </p>
        </div>
        <Toggle label="Skip approval for General questions" checked={s.assistant.autoApproveGeneral} onChange={v => setA({ autoApproveGeneral: v })} />
      </div>
      <div className="row-between">
        <div>
          <strong>Ask permission for web operations</strong>
          <p className="muted small">
            When enabled, any task that uses web access (search, fetch) will always show the approval card first, even for General questions. This ensures you approve before any data leaves this PC.
          </p>
        </div>
        <Toggle label="Web approval" checked={s.assistant.webApprovalRequired} onChange={v => setA({ webApprovalRequired: v })} />
      </div>
      <div className="row-between">
        <div>
          <strong>Proactive suggestions</strong>
          <p className="muted small">Watch git state and the inbox and suggest the next step.</p>
        </div>
        <Toggle label="Proactive suggestions" checked={s.proactive.enabled} onChange={v => void window.island.updateSettings({ proactive: { enabled: v } })} />
      </div>
      <div className="row-between">
        <div>
          <strong>AI predictions</strong>
          <p className="muted small">When your working tree settles, queue a read-only "predict my next steps" task. It waits for your approval, so no tokens are spent until you click.</p>
        </div>
        <Toggle label="AI predictions" checked={s.proactive.llmPredictions} onChange={v => void window.island.updateSettings({ proactive: { llmPredictions: v } })} />
      </div>
      <div className="row-between">
        <div>
          <strong>Launch at Windows login</strong>
        </div>
        <Toggle label="Launch at login" checked={s.launchAtLogin} onChange={v => void window.island.updateSettings({ launchAtLogin: v })} />
      </div>
      <p className="muted small">Shortcuts: Ctrl+Alt+Space shows/hides the island · Ctrl+Alt+Shift+K engages the kill switch.</p>
    </div>
  )
}

function AppPermissions({ snap }: { snap: IslandSnapshot }) {
  const [apps, setApps] = useState<InstalledApp[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const perms = snap.settings.appPermissions

  useEffect(() => {
    void window.island.scanInstalledApps().then(a => { setApps(a); setLoading(false) })
  }, [])

  const getPermission = (proc: string): boolean => {
    const p = perms.find(x => x.process === proc.toLowerCase())
    return p ? p.allowed : true // Default: allowed
  }

  const toggle = (app: InstalledApp, allowed: boolean) => {
    void window.island.setAppPermission(app.process, app.name, allowed)
  }

  const filtered = filter
    ? apps.filter(a => a.name.toLowerCase().includes(filter.toLowerCase()) || a.process.toLowerCase().includes(filter.toLowerCase()))
    : apps

  // Show blocked apps at the top
  const blocked = perms.filter(p => !p.allowed)

  return (
    <div className="general">
      <div>
        <strong>Screen reading permissions</strong>
        <p className="muted small">
          Choose which apps Isla is allowed to read with on-device OCR. Blocked apps will not have their screen content captured.
          Password managers, banking and private windows are always blocked regardless of these settings.
        </p>
      </div>
      {blocked.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <p className="muted small" style={{ marginBottom: 4 }}>Currently blocked ({blocked.length}):</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {blocked.map(p => (
              <button key={p.process} className="btn ghost sm" style={{ color: '#ff453a', borderColor: '#ff453a33', fontSize: 11 }} onClick={() => void window.island.setAppPermission(p.process, p.name, true)}>
                ✕ {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <input
        type="text"
        placeholder="Search apps…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        style={{ width: '100%', marginBottom: 8 }}
      />
      {loading ? (
        <div className="empty">Scanning installed apps…</div>
      ) : filtered.length === 0 ? (
        <div className="empty">No apps found matching "{filter}".</div>
      ) : (
        <ul className="ws-list" style={{ maxHeight: 300, overflowY: 'auto' }}>
          {filtered.slice(0, 100).map(a => {
            const allowed = getPermission(a.process)
            return (
              <li key={a.process} style={{ opacity: allowed ? 1 : 0.6 }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong style={{ fontSize: 12 }}>{a.name}</strong>
                  <span className="muted small" style={{ marginLeft: 6 }}>{a.process}</span>
                </span>
                <Toggle label={`Allow ${a.name}`} checked={allowed} onChange={v => toggle(a, v)} />
              </li>
            )
          })}
        </ul>
      )}
      <p className="muted small" style={{ marginTop: 8 }}>
        {apps.length} apps detected · apps not listed here follow the default (allowed).
      </p>
    </div>
  )
}

import { useEffect, useState } from 'react'
import type { AppPermission, InstalledApp, IslandSnapshot, ProviderId, ProviderStatus, Settings } from '@shared/types'
import { Icon, Section, Segmented, Toggle, cleanErr } from '../components/ui'

type Tab = 'agents' | 'workspaces' | 'general' | 'permissions'

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
          { value: 'general', label: 'General' },
          { value: 'permissions', label: 'App permissions' }
        ]}
      />
      {tab === 'agents' && <Agents snap={snap} focus={focus} />}
      {tab === 'workspaces' && <Workspaces snap={snap} />}
      {tab === 'general' && <General s={snap.settings} snap={snap} />}
      {tab === 'permissions' && <AppPermissions snap={snap} />}
      <p className="about">
        Agentic Island v{snap.version} · © 2026 FiveNeurals. All rights reserved.
      </p>
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
  const [isCustomModel, setIsCustomModel] = useState(() => !!cfg.model && !p.modelSuggestions.includes(cfg.model))
  const [customModelText, setCustomModelText] = useState(cfg.model)

  useEffect(() => {
    setModel(cfg.model)
    if (cfg.model && !p.modelSuggestions.includes(cfg.model)) {
      setIsCustomModel(true)
      setCustomModelText(cfg.model)
    } else {
      setIsCustomModel(false)
      setCustomModelText('')
    }
  }, [cfg.model, p.modelSuggestions])

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
            <select
              value={isCustomModel ? '__custom__' : (model || '')}
              aria-label={`Model for ${p.label}`}
              onChange={e => {
                const val = e.target.value
                if (val === '__custom__') {
                  setIsCustomModel(true)
                } else {
                  setIsCustomModel(false)
                  setModel(val)
                  patch({ model: val })
                }
              }}
            >
              <option value="">CLI default</option>
              {p.modelSuggestions.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {model && !p.modelSuggestions.includes(model) && (
                <option value={model}>{model}</option>
              )}
              <option value="__custom__">Custom model…</option>
            </select>
            {isCustomModel && (
              <input
                style={{ marginTop: 6 }}
                value={customModelText}
                placeholder="Type custom model id"
                spellCheck={false}
                autoFocus
                {...focus}
                onChange={e => setCustomModelText(e.target.value)}
                onBlur={() => {
                  focus.onBlur()
                  const trimmed = customModelText.trim()
                  setModel(trimmed)
                  if (trimmed !== cfg.model) patch({ model: trimmed })
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
            )}
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
          {p.id === 'antigravity'
            ? 'Install Antigravity CLI (agy) to run headlessly and select models directly, or Isla opens your workspace in Antigravity IDE.'
            : `${p.label} cannot run headless.`}
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

function ConnectAgy({ connected }: { connected: boolean }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  return (
    <div className="row-between">
      <div>
        <strong>Use with Antigravity</strong>
        <p className="muted small">
          {connected
            ? 'Connected — Antigravity CLI can run computer tasks with Isla’s tools.'
            : 'Antigravity CLI keeps one global tool list. Connecting adds an “isla” entry there and allows its tools (rule mcp(isla/*)). Your own agy sessions see no Isla tools — they only appear in tasks Isla starts and you approve.'}
        </p>
        {msg && <p className="muted small">{msg}</p>}
      </div>
      {!connected && (
        <button
          className="btn ghost round sm"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void window.island
              .connectAntigravity()
              .then(r => setMsg(r.message))
              .catch(e => setMsg(cleanErr(e)))
              .finally(() => setBusy(false))
          }}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      )}
    </div>
  )
}

function General({ s, snap }: { s: Settings; snap: IslandSnapshot }) {
  const setA = (v: Partial<Settings['assistant']>) => void window.island.updateSettings({ assistant: v })
  return (
    <div className="general">
      <div className="row-between">
        <div>
          <strong>Low-memory mode</strong>
          <p className="muted small">
            Draws Isla without the graphics card — uses about half the memory. Turn off only if animations stutter. Takes effect the next time
            Isla starts.
          </p>
        </div>
        <Toggle label="Low-memory mode" checked={s.lowMemory} onChange={v => void window.island.updateSettings({ lowMemory: v })} />
      </div>
      <div className="row-between">
        <div>
          <strong>Assistant for everyday questions</strong>
          <p className="muted small">
            {snap.assistantProvider
              ? <>Answers General questions (mail, writing, explaining) using your default agent from Agents & models — currently <b>{snap.providers.find(p => p.id === snap.assistantProvider)?.label}</b>.</>
              : 'No background agent found — install Claude Code, Codex CLI, Gemini CLI, or Antigravity CLI (agy).'}
          </p>
        </div>
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
          <strong>Earbuds & headphones</strong>
          <p className="muted small">
            Show connected Bluetooth earbuds or headphones and their battery on the island, with a peek when they connect or run low. Read from
            Windows on this PC — nothing leaves it.
          </p>
        </div>
        <Toggle label="Earbuds and headphones" checked={s.earbuds} onChange={v => void window.island.updateSettings({ earbuds: v })} />
      </div>
      <div className="row-between">
        <div>
          <strong>Link & image previews</strong>
          <p className="muted small">
            Show a title and picture for links and images in answers. Isla fetches them itself (public websites only — never your local network),
            so the sites can see your IP address.
          </p>
        </div>
        <Toggle label="Link and image previews" checked={s.assistant.linkPreviews} onChange={v => setA({ linkPreviews: v })} />
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
          <strong>Computer control</strong>
          <p className="muted small">
            Let Isla do tasks on this PC for you (“go and read my emails”, “find my CV”, “open YouTube and…”). You approve every task first, and Isla
            asks again before anything risky — sending, deleting, buying, submitting or opening programs. It works in the background: your inbox
            connection, its own hidden browser, and Windows UI Automation, so your mouse and keyboard stay yours. Never types passwords. During an
            approved task, what it reads (including screenshots) goes to your AI agent.
          </p>
        </div>
        <Toggle label="Computer control" checked={s.computer.enabled} onChange={v => void window.island.updateSettings({ computer: { enabled: v } })} />
      </div>
      {s.computer.enabled && (
        <>
          <div className="row-between">
            <div>
              <strong>Real mouse & keyboard as a last resort</strong>
              <p className="muted small">For apps that can’t be driven in the background. Every single click or keystroke is confirmed by you on the island.</p>
            </div>
            <Toggle label="Real mouse and keyboard" checked={s.computer.realInput} onChange={v => void window.island.updateSettings({ computer: { realInput: v } })} />
          </div>
          {snap.antigravityComputer !== null && <ConnectAgy connected={snap.antigravityComputer} />}
          <div className="row-between">
            <div>
              <strong>Isla’s browser</strong>
              <p className="muted small">A separate browser profile Isla uses for websites. Open it once to sign in (e.g. to Gmail) — the sign-in is remembered.</p>
            </div>
            <button className="btn ghost round sm" onClick={() => void window.island.showBrowser(!snap.browserOpen)}>
              {snap.browserOpen ? 'Close' : 'Open & sign in'}
            </button>
          </div>
        </>
      )}
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
          <span>Background model for quick checks (empty = same as your agent)</span>
          <input
            defaultValue={s.assistant.backgroundModel}
            placeholder={`Same as your agent${snap.assistantProvider ? ` (${s.providers[snap.assistantProvider].model || 'default'})` : ''}`}
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

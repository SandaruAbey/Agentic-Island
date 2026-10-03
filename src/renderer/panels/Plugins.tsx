import { useEffect, useState } from 'react'
import type { IslandSnapshot, PluginInfo, PluginPermission, PluginRunSummary, PluginSettingDef, PluginToolDef, PluginValue, TaskRecurrence } from '@shared/types'
import { Icon, Segmented, Shimmer, Toggle, cleanErr, timeAgo, timeUntil } from '../components/ui'
import { Markdown } from '../components/Markdown'

const PERMISSION_LABEL: Record<PluginPermission, string> = {
  ai: 'AI text jobs',
  'ai-web': 'AI web research',
  notify: 'Notifications',
  network: 'Visits websites',
  browser: 'Private browser window'
}
const STATUS: Record<PluginRunSummary['status'], string> = { running: 'Running', done: 'Done', error: 'Failed', stopped: 'Stopped' }
const TRIGGER: Record<PluginRunSummary['trigger'], string> = { manual: 'Run now', chat: 'From chat', schedule: 'Scheduled' }
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

type Focus = { onFocus: () => void; onBlur: () => void }

export function PluginsPanel({ snap, onTyping }: { snap: IslandSnapshot; onTyping: (v: boolean) => void }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const focus = { onFocus: () => onTyping(true), onBlur: () => onTyping(false) }

  const install = (from: 'folder' | 'zip') =>
    void window.island
      .installPlugin(from)
      .then(r => r.message !== 'Cancelled.' && setMsg({ ok: r.ok, text: r.message }))
      .catch(e => setMsg({ ok: false, text: cleanErr(e) }))

  return (
    <div className="runs">
      <div className="row-between">
        <h3 className="label">Plugins</h3>
        <span>
          <button className="link" onClick={() => install('folder')}>
            <Icon name="folder" size={12} /> Install folder
          </button>{' '}
          <button className="link" onClick={() => install('zip')}>
            <Icon name="plugin" size={12} /> Install .zip
          </button>{' '}
          <button className="link" title="Open the installed plugins folder" onClick={() => void window.island.openPluginsFolder()}>
            <Icon name="file" size={12} />
          </button>{' '}
          <button className="link" title="Reload plugins (after editing one)" onClick={() => void window.island.reloadPlugins()}>
            <Icon name="refresh" size={12} />
          </button>
        </span>
      </div>
      {msg && <div className={`alert ${msg.ok ? 'info' : 'error'}`}>{msg.text}</div>}
      {!snap.plugins.length ? (
        <div className="empty tall">
          No plugins yet. A plugin is a small tool someone wrote for Isla: a folder with an <code>isla-plugin.json</code> and an <code>index.js</code>.
          Install one from a folder or a .zip someone shared with you.
        </div>
      ) : (
        snap.plugins.map(p => (
          <PluginCard
            key={p.manifest.id}
            p={p}
            locked={snap.security.locked}
            focus={focus}
            open={openId === p.manifest.id}
            onToggle={() => setOpenId(openId === p.manifest.id ? null : p.manifest.id)}
            onMessage={setMsg}
          />
        ))
      )}
    </div>
  )
}

type CardTab = 'run' | 'history' | 'settings'

function PluginCard({
  p,
  locked,
  focus,
  open,
  onToggle,
  onMessage
}: {
  p: PluginInfo
  locked: boolean
  focus: Focus
  open: boolean
  onToggle: () => void
  onMessage: (m: { ok: boolean; text: string }) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  // Tabs keep the card short: what you came for (run it, see the result) is always at the top.
  const [tab, setTab] = useState<CardTab>('run')
  const m = p.manifest
  const fail = (e: unknown) => setError(cleanErr(e))
  const last = p.history[0]
  const pill = p.running ? 'running' : p.error || last?.status === 'error' ? 'error' : p.enabled ? 'done' : 'killed'
  const pillText = p.error ? 'Broken' : p.enabled ? 'On' : 'Off'
  // Starting a run (here or from chat/schedule) brings you back to the Run tab to watch it.
  const runId = p.running?.runId
  useEffect(() => {
    if (runId) setTab('run')
  }, [runId])

  return (
    <article className={`run ${p.error ? 'error' : ''}`}>
      <div className="run-head" role="button" tabIndex={0} onClick={onToggle} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onToggle()}>
        <span className={`status-pill ${pill}`}>{p.running ? <Shimmer tint>Running</Shimmer> : pillText}</span>
        <strong>
          {m.name} <span className="muted small">{m.version}</span>
        </strong>
        <span onClick={e => e.stopPropagation()}>
          {!p.error && (
            <Toggle
              label={p.enabled ? 'Turn off' : 'Turn on'}
              checked={p.enabled}
              onChange={v => void window.island.setPluginEnabled(m.id, v).catch(fail)}
            />
          )}
        </span>
      </div>
      {/* Folded: one line with what is happening now, or the last result. */}
      {!open && p.running && (
        <div className="plugin-fold" onClick={onToggle}>
          <Shimmer icon="terminal">{p.running.log[p.running.log.length - 1] ?? 'Starting…'}</Shimmer>
        </div>
      )}
      {open && (
        <div className="run-body">
          {p.error && <div className="alert error">{p.error}</div>}
          {error && <div className="alert error">{error}</div>}
          {!p.error && (
            <div className="plugin-tabs">
              <Segmented
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'run', label: 'Run' },
                  { value: 'history', label: p.history.length ? `History (${p.history.length})` : 'History' },
                  { value: 'settings', label: 'Settings' }
                ]}
              />
            </div>
          )}

          {!p.error && tab === 'run' && (
            <>
              {p.running && <Live p={p} />}
              {m.tools.map(t => (
                <ToolRow key={t.id} p={p} tool={t} focus={focus} disabled={!p.enabled || locked || !!p.running} onError={fail} />
              ))}
              {!p.enabled && <p className="muted small">Turn the plugin on (switch above) to run it.</p>}
              {!p.running && last && (
                <div className="plugin-latest">
                  <div className="row-between">
                    <h3 className="label">
                      Latest result · {timeAgo(last.startedAt)} · {STATUS[last.status]}
                    </h3>
                    {p.history.length > 1 && (
                      <button className="link" onClick={() => setTab('history')}>
                        All runs
                      </button>
                    )}
                  </div>
                  <RunView p={p} run={last} onError={fail} onMessage={onMessage} />
                </div>
              )}
            </>
          )}

          {!p.error && tab === 'history' &&
            (p.history.length ? <History p={p} onError={fail} onMessage={onMessage} /> : <div className="empty">No runs yet.</div>)}

          {(p.error || tab === 'settings') && (
            <>
              {m.description && <p className="approve-note">{m.description}</p>}
              <div className="meta">
                <span>{p.source === 'builtin' ? 'Built-in' : 'Installed'}</span>
                {m.author && <span>by {m.author}</span>}
                {m.permissions.map(x => (
                  <span key={x} className={x === 'ai-web' ? 'warn' : ''}>
                    {PERMISSION_LABEL[x]}
                  </span>
                ))}
              </div>
              {!p.error && !!m.settings?.length && <SettingsForm p={p} focus={focus} onError={fail} />}
              <div className="actions">
                <button
                  className="btn ghost"
                  title="Pack this plugin into a .zip that anyone can install"
                  onClick={() =>
                    void window.island
                      .exportPlugin(m.id)
                      .then(r => r.message !== 'Cancelled.' && onMessage({ ok: r.ok, text: r.message }))
                      .catch(fail)
                  }
                >
                  <Icon name="push" size={13} /> Share .zip
                </button>
                <span className="spacer" />
                {p.source === 'installed' && (
                  <button
                    className="btn red"
                    onClick={() => {
                      if (!confirmRemove) {
                        setConfirmRemove(true)
                        window.setTimeout(() => setConfirmRemove(false), 3000)
                        return
                      }
                      void window.island.uninstallPlugin(m.id).catch(fail)
                    }}
                  >
                    {confirmRemove ? 'Confirm uninstall?' : 'Uninstall'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </article>
  )
}

/** What a run is doing right now: progress, then its steps — earlier ones fade, the current one shimmers. */
function Live({ p }: { p: PluginInfo }) {
  const r = p.running!
  const steps = r.log.slice(-6)
  return (
    <>
      <div className="meta" style={{ marginTop: 10 }}>
        <span>{p.manifest.tools.find(t => t.id === r.toolId)?.title ?? r.toolId}</span>
        <span>started {timeAgo(r.startedAt)}</span>
        {r.progress !== null && <span>{Math.round(r.progress * 100)}%</span>}
      </div>
      {r.progress !== null && (
        <div className="plugin-progress">
          <i style={{ width: `${Math.round(r.progress * 100)}%` }} />
        </div>
      )}
      <div className="plugin-steps">
        {steps.length ? (
          steps.map((line, i) =>
            i === steps.length - 1 ? (
              <div key={`${r.log.length}-${i}`}>
                <Shimmer icon="terminal">{line}</Shimmer>
              </div>
            ) : (
              <div key={`${r.log.length}-${i}`} style={{ opacity: 0.35 + (0.45 * (i + 1)) / steps.length }}>
                <Icon name="check" size={12} />
                <span>{line}</span>
              </div>
            )
          )
        ) : (
          <div>
            <Shimmer icon="terminal">Starting…</Shimmer>
          </div>
        )}
      </div>
      <div className="actions">
        <button className="btn red" onClick={() => void window.island.stopPlugin(p.manifest.id)}>
          <Icon name="stop" size={12} /> Stop
        </button>
      </div>
    </>
  )
}

function ToolRow({ p, tool, focus, disabled, onError }: { p: PluginInfo; tool: PluginToolDef; focus: Focus; disabled: boolean; onError: (e: unknown) => void }) {
  const sched = p.schedules[tool.id]
  const rec = sched?.recurrence ?? tool.schedule ?? { type: 'daily', hour: 9, minute: 0 }
  const timeOf = (r: TaskRecurrence) => ('hour' in r ? `${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}` : '09:00')
  const [type, setType] = useState<'daily' | 'weekly'>(rec.type === 'weekly' ? 'weekly' : 'daily')
  const [time, setTime] = useState(timeOf(rec))
  const [weekday, setWeekday] = useState(rec.type === 'weekly' ? rec.weekday : 1)

  const save = (enabled: boolean, t = type, tm = time, wd = weekday) => {
    const [h, mi] = tm.split(':').map(Number)
    const recurrence: TaskRecurrence = t === 'weekly' ? { type: 'weekly', weekday: wd, hour: h || 0, minute: mi || 0 } : { type: 'daily', hour: h || 0, minute: mi || 0 }
    void window.island.setPluginSchedule(p.manifest.id, tool.id, { enabled, recurrence }).catch(onError)
  }
  const on = !!sched?.enabled
  const chatHint = tool.chat?.[0]

  return (
    <div className="plugin-tool">
      <div className="row-between">
        <strong>{tool.title}</strong>
        <button className="btn ghost" disabled={disabled} onClick={() => void window.island.runPlugin(p.manifest.id, tool.id).catch(onError)}>
          <Icon name="play" size={13} /> Run now
        </button>
      </div>
      {tool.description && <p className="muted small">{tool.description}</p>}
      {chatHint && <p className="muted small">In chat: “{chatHint}”</p>}
      <div className="inline plugin-schedule">
        <Toggle label="Repeat automatically" checked={on} onChange={v => save(v)} />
        <span className="small">{on && sched?.nextRunAt && p.enabled ? `Next run ${timeUntil(sched.nextRunAt)}` : 'Repeat'}</span>
        <select
          value={type}
          onChange={e => {
            const t = e.target.value as 'daily' | 'weekly'
            setType(t)
            if (on) save(true, t)
          }}
        >
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
        </select>
        {type === 'weekly' && (
          <select
            value={weekday}
            onChange={e => {
              setWeekday(Number(e.target.value))
              if (on) save(true, type, time, Number(e.target.value))
            }}
          >
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        )}
        <input type="time" value={time} {...focus} onChange={e => setTime(e.target.value)} onBlur={() => (focus.onBlur(), on && save(true))} />
      </div>
    </div>
  )
}

function SettingsForm({ p, focus, onError }: { p: PluginInfo; focus: Focus; onError: (e: unknown) => void }) {
  const [values, setValues] = useState<Record<string, PluginValue>>(p.values)
  const [saved, setSaved] = useState(false)
  const dirty = JSON.stringify(values) !== JSON.stringify(p.values)
  const set = (k: string, v: PluginValue) => {
    setSaved(false)
    setValues(x => ({ ...x, [k]: v }))
  }
  const field = (s: PluginSettingDef) => {
    const v = values[s.key]
    switch (s.type) {
      case 'boolean':
        return <Toggle label={s.label} checked={v === true} onChange={x => set(s.key, x)} />
      case 'number':
        return <input type="number" value={Number(v) || 0} {...focus} onChange={e => set(s.key, Number(e.target.value))} />
      case 'textarea':
        return <textarea rows={3} value={String(v ?? '')} spellCheck={false} {...focus} onChange={e => set(s.key, e.target.value)} />
      case 'select':
        return (
          <select value={String(v ?? '')} onChange={e => set(s.key, e.target.value)}>
            {(s.options ?? []).map(o => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        )
      case 'secret': {
        // Saved keys never come back to the UI: type to replace, or clear.
        const has = p.secretsSet.includes(s.key)
        return (
          <div className="inline">
            <input
              type="password"
              autoComplete="off"
              value={String(v ?? '')}
              placeholder={has ? 'Saved (encrypted). Type to replace' : 'Not set'}
              spellCheck={false}
              {...focus}
              onChange={e => set(s.key, e.target.value)}
            />
            {has && (
              <button className="link" type="button" onClick={() => void window.island.setPluginValues(p.manifest.id, { [s.key]: null }).catch(onError)}>
                Clear
              </button>
            )}
          </div>
        )
      }
      default:
        return <input value={String(v ?? '')} spellCheck={false} {...focus} onChange={e => set(s.key, e.target.value)} />
    }
  }
  return (
    <div className="run-body" style={{ paddingTop: 12 }}>
      <h3 className="label">Settings</h3>
      <div className="provider-grid">
        {p.manifest.settings!.map(s => (
          <label key={s.key} className={s.type === 'textarea' || s.type === 'text' || s.type === 'secret' ? 'wide' : ''}>
            <span>{s.label}</span>
            {field(s)}
            {s.help && <em className="muted small">{s.help}</em>}
          </label>
        ))}
      </div>
      <div className="actions">
        <button
          className="btn primary"
          disabled={!dirty}
          onClick={() =>
            void window.island
              .setPluginValues(p.manifest.id, values)
              .then(() => {
                setSaved(true)
                // Typed secrets are saved now; clear them from the form.
                setValues(x => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, p.manifest.settings!.find(d => d.key === k)?.type === 'secret' ? '' : v])))
              })
              .catch(onError)
          }
        >
          {saved && !dirty ? 'Saved' : 'Save settings'}
        </button>
      </div>
    </div>
  )
}

const duration = (h: PluginRunSummary) => {
  if (!h.endedAt) return ''
  const s = Math.round((h.endedAt - h.startedAt) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** Every past run: pick one to see what it found, its log and its report. */
function History({ p, onError, onMessage }: { p: PluginInfo; onError: (e: unknown) => void; onMessage: (m: { ok: boolean; text: string }) => void }) {
  const [showId, setShowId] = useState<string | null>(p.history[0]?.id ?? null)
  const shown = p.history.find(h => h.id === showId)
  return (
    <>
      <div className="row-between" style={{ marginTop: 12 }}>
        <h3 className="label">Run history ({p.history.length})</h3>
        <button className="link" onClick={() => void window.island.openPluginReports(p.manifest.id).catch(onError)}>
          <Icon name="folder" size={12} /> All reports
        </button>
      </div>
      <div className="plugin-history">
        {p.history.map(h => (
          <button key={h.id} className={`plugin-history-row ${h.id === showId ? 'active' : ''} ${h.status === 'error' ? 'warn' : ''}`} onClick={() => setShowId(h.id === showId ? null : h.id)}>
            <span>{new Date(h.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
            <span>{STATUS[h.status]}</span>
            <span className="muted">{TRIGGER[h.trigger]}</span>
            <span className="muted">{duration(h)}</span>
            {h.reportDir && <Icon name="file" size={12} />}
          </button>
        ))}
      </div>
      {shown && <RunView p={p} run={shown} onError={onError} onMessage={onMessage} />}
    </>
  )
}

/** One run's result: summary, log, and its report (open, files, export, delete). */
function RunView({ p, run, onError, onMessage }: { p: PluginInfo; run: PluginRunSummary; onError: (e: unknown) => void; onMessage: (m: { ok: boolean; text: string }) => void }) {
  const [showLog, setShowLog] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const id = p.manifest.id
  return (
    <>
      <div className={`output md prose ${run.status === 'error' ? 'plugin-error' : ''}`}>
        <Markdown text={run.summary || '(no summary)'} />
      </div>
      {showLog && <pre className="prompt-preview">{run.log.length ? run.log.join('\n') : '(no log)'}</pre>}
      <div className="actions">
        {run.reportDir && (
          <button className="btn primary" title="Open the full report in your browser" onClick={() => void window.island.openPluginReport(id, run.id).catch(onError)}>
            <Icon name="file" size={13} /> Open report
          </button>
        )}
        {run.reportDir && (
          <button className="btn ghost" title="Show the report files (CSV, JSON…)" onClick={() => void window.island.openPluginReport(id, run.id, true).catch(onError)}>
            <Icon name="folder" size={13} /> Files ({run.reportFiles.length})
          </button>
        )}
        <button
          className="btn ghost"
          title="Save this run (report, CSVs, summary and log) as a .zip"
          onClick={() =>
            void window.island
              .exportPluginRun(id, run.id)
              .then(r => r.message !== 'Cancelled.' && onMessage({ ok: r.ok, text: r.message }))
              .catch(onError)
          }
        >
          <Icon name="push" size={13} /> Export
        </button>
        <button className="link" onClick={() => setShowLog(v => !v)}>
          {showLog ? 'Hide log' : 'Log'}
        </button>
        <span className="spacer" />
        <button
          className="btn red"
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true)
              window.setTimeout(() => setConfirmDelete(false), 3000)
              return
            }
            void window.island.deletePluginRun(id, run.id).catch(onError)
          }}
        >
          {confirmDelete ? 'Delete run & files?' : 'Delete'}
        </button>
      </div>
    </>
  )
}

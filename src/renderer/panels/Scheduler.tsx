import { useState } from 'react'
import type { AgentMode, IslandSnapshot, ProviderId, RunContext, ScheduledTask, ScheduledTaskInput, TaskRecurrence } from '@shared/types'
import { Icon, Segmented, Toggle, timeAgo, timeUntil, cleanErr } from '../components/ui'

const STATUS_LABEL: Record<NonNullable<ScheduledTask['lastRunStatus']>, string> = {
  'pending-approval': 'Needs approval',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  killed: 'Stopped',
  rejected: 'Rejected'
}

function describeRecurrence(r: TaskRecurrence): string {
  const time = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  switch (r.type) {
    case 'once':
      return `Once, ${new Date(r.runAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
    case 'interval': {
      const mins = Math.round(r.everyMs / 60_000)
      if (mins < 60) return `Every ${mins} min`
      const hrs = mins / 60
      return Number.isInteger(hrs) ? `Every ${hrs}h` : `Every ${mins} min`
    }
    case 'daily':
      return `Every day at ${time(r.hour, r.minute)}`
    case 'weekly':
      return `Every ${WEEKDAYS[r.weekday]} at ${time(r.hour, r.minute)}`
  }
}

type Focus = { onFocus: () => void; onBlur: () => void }

export function SchedulerPanel({ snap, onTyping }: { snap: IslandSnapshot; onTyping: (v: boolean) => void }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const focus = { onFocus: () => onTyping(true), onBlur: () => onTyping(false) }

  return (
    <div className="runs">
      <div className="row-between">
        <h3 className="label">Scheduled tasks</h3>
        <button className="link" onClick={() => setShowNew(v => !v)}>
          <Icon name={showNew ? 'close' : 'spark'} size={12} /> {showNew ? 'Cancel' : 'New task'}
        </button>
      </div>
      {showNew && <TaskForm snap={snap} focus={focus} onDone={() => setShowNew(false)} />}
      {!snap.scheduledTasks.length && !showNew ? (
        <div className="empty tall">No scheduled tasks yet. Create one to have Isla run it automatically — once, or on a repeating schedule.</div>
      ) : (
        snap.scheduledTasks.map(t => (
          <TaskCard key={t.id} task={t} snap={snap} focus={focus} open={openId === t.id} onToggle={() => setOpenId(openId === t.id ? null : t.id)} />
        ))
      )}
    </div>
  )
}

function TaskCard({ task, snap, focus, open, onToggle }: { task: ScheduledTask; snap: IslandSnapshot; focus: Focus; open: boolean; onToggle: () => void }) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const providerLabel = task.provider ? snap.providers.find(p => p.id === task.provider)?.label ?? task.provider : 'Default agent'

  const statusClass = task.lastRunStatus === 'error' ? 'error' : task.lastRunStatus === 'done' ? 'done' : ''

  return (
    <article className={`run ${statusClass}`}>
      <div className="run-head" role="button" tabIndex={0} onClick={onToggle} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onToggle()}>
        <span className={`status-pill ${task.enabled ? '' : 'killed'}`}>{task.enabled ? (task.nextRunAt ? timeUntil(task.nextRunAt) : '…') : 'Paused'}</span>
        <strong>{task.title}</strong>
        <span onClick={e => e.stopPropagation()}>
          <Toggle
            label={task.enabled ? 'Pause task' : 'Resume task'}
            checked={task.enabled}
            onChange={v => {
              void window.island.toggleTask(task.id, v).catch(e => setError(cleanErr(e)))
            }}
          />
        </span>
      </div>
      {open && (
        <div className="run-body">
          {editing ? (
            <TaskForm
              snap={snap}
              focus={focus}
              existing={task}
              onDone={() => setEditing(false)}
            />
          ) : (
            <>
              <div className="meta">
                <span>{describeRecurrence(task.recurrence)}</span>
                <span>{task.context === 'general' ? 'General' : task.workspace}</span>
                <span>{providerLabel}</span>
                <span className={task.mode === 'edit' ? 'warn' : ''}>{task.mode === 'edit' ? 'can edit files · needs approval' : 'read-only · runs automatically'}</span>
                <span>Ran {task.runCount}×</span>
              </div>
              <pre className="prompt-preview">{task.prompt}</pre>
              {task.history.length > 0 && (
                <div className="meta" style={{ marginTop: 10 }}>
                  {task.history.map((h, i) => (
                    <span key={i} className={h.status === 'error' ? 'warn' : ''}>
                      {timeAgo(h.at)} · {STATUS_LABEL[h.status]}
                    </span>
                  ))}
                </div>
              )}
              {error && <div className="alert error">{error}</div>}
              <div className="actions">
                <button
                  className="btn ghost"
                  onClick={() => void window.island.runTaskNow(task.id).catch(e => setError(cleanErr(e)))}
                >
                  <Icon name="play" size={13} /> Run now
                </button>
                <span className="spacer" />
                <button className="btn ghost" onClick={() => setEditing(true)}>
                  Edit
                </button>
                <button
                  className="btn red"
                  onClick={() => {
                    if (!confirmDelete) {
                      setConfirmDelete(true)
                      window.setTimeout(() => setConfirmDelete(false), 3000)
                      return
                    }
                    void window.island.deleteTask(task.id).catch(e => setError(cleanErr(e)))
                  }}
                >
                  {confirmDelete ? 'Confirm delete?' : 'Delete'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </article>
  )
}

const RECURRENCE_OPTIONS: { value: TaskRecurrence['type']; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'interval', label: 'Interval' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' }
]
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function TaskForm({ snap, focus, existing, onDone }: { snap: IslandSnapshot; focus: Focus; existing?: ScheduledTask; onDone: () => void }) {
  const s = snap.settings
  const [title, setTitle] = useState(existing?.title ?? '')
  const [prompt, setPrompt] = useState(existing?.prompt ?? '')
  const [context, setContext] = useState<RunContext>(existing?.context ?? 'general')
  const [workspace, setWorkspace] = useState(existing?.workspace ?? s.activeWorkspace ?? '')
  const [mode, setMode] = useState<AgentMode>(existing?.mode ?? 'readonly')
  const [provider, setProvider] = useState<ProviderId | ''>(existing?.provider ?? '')
  const [recType, setRecType] = useState<TaskRecurrence['type']>(existing?.recurrence.type ?? 'daily')
  const [onceAt, setOnceAt] = useState(() => {
    if (existing?.recurrence.type !== 'once') return ''
    const d = new Date(existing.recurrence.runAt)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  })
  const [everyValue, setEveryValue] = useState(existing?.recurrence.type === 'interval' ? Math.round(existing.recurrence.everyMs / 60_000) : 30)
  const [everyUnit, setEveryUnit] = useState<'minutes' | 'hours'>('minutes')
  const [time, setTime] = useState(
    existing && (existing.recurrence.type === 'daily' || existing.recurrence.type === 'weekly')
      ? `${String(existing.recurrence.hour).padStart(2, '0')}:${String(existing.recurrence.minute).padStart(2, '0')}`
      : '09:00'
  )
  const [weekday, setWeekday] = useState(existing?.recurrence.type === 'weekly' ? existing.recurrence.weekday : 1)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const headless = snap.providers.filter(p => p.headless && p.installed)

  const buildRecurrence = (): TaskRecurrence | null => {
    if (recType === 'once') {
      const ts = onceAt ? new Date(onceAt).getTime() : NaN
      if (!ts || Number.isNaN(ts)) return null
      return { type: 'once', runAt: ts }
    }
    if (recType === 'interval') {
      const mins = everyUnit === 'hours' ? everyValue * 60 : everyValue
      return { type: 'interval', everyMs: mins * 60_000 }
    }
    const [h, m] = time.split(':').map(Number)
    if (recType === 'daily') return { type: 'daily', hour: h || 0, minute: m || 0 }
    return { type: 'weekly', weekday, hour: h || 0, minute: m || 0 }
  }

  const submit = async () => {
    const recurrence = buildRecurrence()
    if (!recurrence) {
      setError('Pick a valid schedule.')
      return
    }
    const input: ScheduledTaskInput = {
      title,
      prompt,
      context,
      workspace: context === 'project' ? workspace : null,
      provider: provider || null,
      mode,
      recurrence
    }
    setBusy(true)
    setError(null)
    try {
      if (existing) await window.island.updateTask(existing.id, input)
      else await window.island.createTask(input)
      onDone()
    } catch (e) {
      setError(cleanErr(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="run-body" style={{ paddingTop: 12 }}>
      <div className="provider-grid">
        <label className="wide">
          <span>Title</span>
          <input value={title} placeholder="e.g. Search AI news" spellCheck={false} {...focus} onChange={e => setTitle(e.target.value)} />
        </label>
        <label className="wide">
          <span>Prompt</span>
          <textarea
            value={prompt}
            placeholder="What should Isla do when this runs?"
            rows={3}
            {...focus}
            onChange={e => setPrompt(e.target.value)}
          />
        </label>
        <label>
          <span>Context</span>
          <Segmented value={context} onChange={setContext} options={[{ value: 'general', label: 'General' }, { value: 'project', label: 'Project' }]} />
        </label>
        {context === 'project' && (
          <label>
            <span>Workspace</span>
            <select value={workspace} onChange={e => setWorkspace(e.target.value)}>
              {s.workspaces.map(w => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>Mode</span>
          <Segmented value={mode} onChange={setMode} options={[{ value: 'readonly', label: 'Read-only' }, { value: 'edit', label: 'Can edit' }]} />
        </label>
        <label>
          <span>Agent</span>
          <select value={provider} onChange={e => setProvider(e.target.value as ProviderId | '')}>
            <option value="">Use default agent</option>
            {headless.map(p => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {mode === 'edit' && <p className="muted small wide">Edit-mode tasks always need your approval before running — they never run fully unattended.</p>}

        <label className="wide">
          <span>Repeats</span>
          <Segmented value={recType} onChange={setRecType} options={RECURRENCE_OPTIONS} />
        </label>
        {recType === 'once' && (
          <label>
            <span>Run at</span>
            <input type="datetime-local" value={onceAt} {...focus} onChange={e => setOnceAt(e.target.value)} />
          </label>
        )}
        {recType === 'interval' && (
          <label>
            <span>Every</span>
            <div className="inline">
              <input type="number" min={1} value={everyValue} {...focus} onChange={e => setEveryValue(Number(e.target.value))} />
              <select value={everyUnit} onChange={e => setEveryUnit(e.target.value as 'minutes' | 'hours')}>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </div>
          </label>
        )}
        {(recType === 'daily' || recType === 'weekly') && (
          <label>
            <span>Time</span>
            <input type="time" value={time} {...focus} onChange={e => setTime(e.target.value)} />
          </label>
        )}
        {recType === 'weekly' && (
          <label>
            <span>Day</span>
            <select value={weekday} onChange={e => setWeekday(Number(e.target.value))}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="actions">
        <button className="btn primary" disabled={busy || !title.trim() || !prompt.trim()} onClick={() => void submit()}>
          {existing ? 'Save changes' : 'Create task'}
        </button>
      </div>
    </div>
  )
}

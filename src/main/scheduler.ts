import { randomUUID } from 'node:crypto'
import type { AgentRun, IslandEvent, RunRequest, ScheduledTask, ScheduledTaskInput, ScheduledTaskRunSummary, Settings, TaskRecurrence } from '@shared/types'
import type { AgentManager, isInsideWorkspace as IsInsideWorkspace } from './agents'

const TICK_MS = 20_000
const MIN_INTERVAL_MS = 60_000
const MAX_RUNS_PER_HOUR = 20
const MAX_HISTORY = 10

const SCHEDULED_SYSTEM =
  "You are Isla, a helpful desktop assistant on the user's Windows PC, running a task the user scheduled in advance. " +
  'Do exactly the task asked, concisely, in plain text (no markdown headings). This runs unattended — do not ask clarifying questions, make a reasonable assumption and proceed.'

interface SchedulerDeps {
  getSettings: () => Settings
  setTasks: (tasks: ScheduledTask[]) => void
  agents: AgentManager
  queueRun: (req: RunRequest, extra?: { approved?: boolean }) => Promise<AgentRun>
  isInsideWorkspace: typeof IsInsideWorkspace
  isLocked: () => boolean
  onChange: () => void
  notify: (e: Extract<IslandEvent, { type: 'notify' }>) => void
  log: (kind: string, detail: string) => void
}

/** Next future occurrence strictly after `from` — never backfills missed past occurrences. */
export function computeNextRun(r: ScheduledTask['recurrence'], from: number): number | null {
  if (r.type === 'once') return r.runAt > from ? r.runAt : null
  if (r.type === 'interval') return from + r.everyMs
  // daily / weekly: walk forward day by day from "from" until the time-of-day (and weekday) matches.
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setHours(r.hour, r.minute, 0, 0)
  if (r.type === 'weekly') {
    let delta = (r.weekday - d.getDay() + 7) % 7
    if (delta === 0 && d.getTime() <= from) delta = 7
    d.setDate(d.getDate() + delta)
    return d.getTime()
  }
  if (d.getTime() <= from) d.setDate(d.getDate() + 1)
  return d.getTime()
}

export function describeRecurrence(r: ScheduledTask['recurrence']): string {
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

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const EVERY_N = /\bevery\s+(\d+)\s*(min(?:ute)?s?|hours?)\b/i
const EVERY_WORD = /\bevery\s+(day|morning|evening|night|hour|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i
/** "daily"/"each day"/"once a day" only count as a scheduling cue right at the start of the message
 *  ("daily, check my inbox") — matching them anywhere ("what is my daily caloric need") is too loose. */
const DAILY_WORD = /^(daily|each\s+day|once\s+(a|per)\s+day)\b/i
/** "every day/morning/monday", or a leading "daily" — the recurrence cue a chat message needs to be a scheduling request at all. */
const RECUR_CUE = new RegExp(`${EVERY_N.source}|${EVERY_WORD.source}|${DAILY_WORD.source}`, 'i')
/** Only matches an explicit time-of-day mention ("at 9am", "at 8:30", "9pm") — never a bare number, so it can't eat unrelated digits elsewhere in the sentence. */
const TIME_OF_DAY = /\bat\s+(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)?\b|\b(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)\b/i

/** Parse a chat message like "every morning at 9am search AI news and summarize" into a recurring task draft. */
export function parseScheduleIntent(text: string): ScheduledTaskInput | null {
  const t = text.trim()
  const lower = t.toLowerCase()
  if (!RECUR_CUE.test(lower)) return null

  const weekdayMatch = WEEKDAY_NAMES.find(d => EVERY_WORD.test(lower) && lower.includes(`every ${d}`))
  const everyNMatch = lower.match(EVERY_N)

  let recurrence: TaskRecurrence
  let hour = 9
  let minute = 0
  const timeMatch = lower.match(TIME_OF_DAY)
  if (timeMatch) {
    const isFirstForm = timeMatch[1] !== undefined
    hour = parseInt(isFirstForm ? timeMatch[1] : timeMatch[4], 10)
    minute = parseInt((isFirstForm ? timeMatch[2] : timeMatch[5]) ?? '0', 10)
    const ampm = isFirstForm ? timeMatch[3] : timeMatch[6]
    if (ampm === 'pm' && hour < 12) hour += 12
    else if (ampm === 'am' && hour === 12) hour = 0
  } else if (/\b(evening|night)\b/.test(lower)) {
    hour = 19
  } else if (/\bmorning\b/.test(lower)) {
    hour = 9
  }

  if (everyNMatch) {
    const n = parseInt(everyNMatch[1], 10)
    const unit = everyNMatch[2].startsWith('h') ? 3_600_000 : 60_000
    recurrence = { type: 'interval', everyMs: n * unit }
  } else if (weekdayMatch) {
    recurrence = { type: 'weekly', weekday: WEEKDAY_NAMES.indexOf(weekdayMatch), hour, minute }
  } else {
    recurrence = { type: 'daily', hour, minute }
  }

  // Strip only the scheduling scaffolding actually matched above — never a blanket number/time sweep,
  // so digits that are part of the task itself ("3 new emails", "build 42") survive untouched.
  let prompt = t
  if (everyNMatch) prompt = prompt.replace(new RegExp(EVERY_N.source, 'i'), '')
  else if (weekdayMatch) prompt = prompt.replace(new RegExp(EVERY_WORD.source, 'i'), '')
  else {
    prompt = prompt.replace(new RegExp(EVERY_WORD.source, 'i'), '').replace(new RegExp(DAILY_WORD.source, 'i'), '')
  }
  if (timeMatch) prompt = prompt.replace(new RegExp(TIME_OF_DAY.source, 'i'), '')
  prompt = prompt
    .replace(/^[\s,:-]+|[\s,:-]+$/g, '')
    .replace(/^(and\s+)/i, '')
    .trim()
  if (!prompt) return null

  const title = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt

  return { title, prompt, context: 'general', mode: 'readonly', recurrence }
}

function validate(input: ScheduledTaskInput, s: Settings): void {
  if (!input.title.trim()) throw new Error('Title is required.')
  if (!input.prompt.trim()) throw new Error('Prompt is required.')
  if (input.context === 'project') {
    if (!input.workspace) throw new Error('Pick a workspace for a project task.')
    if (!s.workspaces.includes(input.workspace)) throw new Error('Workspace is not allowlisted.')
  }
  if (input.recurrence.type === 'interval' && input.recurrence.everyMs < MIN_INTERVAL_MS) {
    throw new Error('Minimum interval is 1 minute.')
  }
  if (input.recurrence.type === 'once' && input.recurrence.runAt <= Date.now()) {
    throw new Error('Pick a time in the future.')
  }
}

export class TaskScheduler {
  private tasks: ScheduledTask[]
  private timer: NodeJS.Timeout | null = null
  private fireTimes: number[] = []

  constructor(private d: SchedulerDeps) {
    this.tasks = d.getSettings().scheduledTasks
  }

  list(): ScheduledTask[] {
    return this.tasks
  }

  stats(): { runsLastHour: number; limitPerHour: number } {
    const hourAgo = Date.now() - 3_600_000
    this.fireTimes = this.fireTimes.filter(t => t > hourAgo)
    return { runsLastHour: this.fireTimes.length, limitPerHour: MAX_RUNS_PER_HOUR }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  create(input: ScheduledTaskInput): ScheduledTask {
    const s = this.d.getSettings()
    validate(input, s)
    const now = Date.now()
    const task: ScheduledTask = {
      id: randomUUID(),
      title: input.title.trim().slice(0, 80),
      prompt: input.prompt.slice(0, 20_000).trim(),
      context: input.context,
      workspace: input.context === 'project' ? input.workspace ?? null : null,
      provider: input.provider ?? null,
      mode: input.mode,
      recurrence: input.recurrence,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      nextRunAt: computeNextRun(input.recurrence, now),
      lastRunAt: null,
      lastRunStatus: null,
      runCount: 0,
      history: []
    }
    this.tasks = [task, ...this.tasks]
    this.persist()
    this.d.log('scheduler.created', task.title)
    return task
  }

  update(id: string, patch: Partial<ScheduledTaskInput> & { enabled?: boolean }): ScheduledTask {
    const t = this.tasks.find(x => x.id === id)
    if (!t) throw new Error('Task not found.')
    const s = this.d.getSettings()
    const merged: ScheduledTaskInput = {
      title: patch.title ?? t.title,
      prompt: patch.prompt ?? t.prompt,
      context: patch.context ?? t.context,
      workspace: patch.workspace !== undefined ? patch.workspace : t.workspace,
      provider: patch.provider !== undefined ? patch.provider : t.provider,
      mode: patch.mode ?? t.mode,
      recurrence: patch.recurrence ?? t.recurrence
    }
    validate(merged, s)
    t.title = merged.title.trim().slice(0, 80)
    t.prompt = merged.prompt.slice(0, 20_000).trim()
    t.context = merged.context
    t.workspace = merged.context === 'project' ? merged.workspace ?? null : null
    t.provider = merged.provider ?? null
    t.mode = merged.mode
    const recurrenceChanged = JSON.stringify(t.recurrence) !== JSON.stringify(merged.recurrence)
    t.recurrence = merged.recurrence
    if (patch.enabled !== undefined) t.enabled = patch.enabled
    if (recurrenceChanged || patch.enabled === true) t.nextRunAt = computeNextRun(t.recurrence, Date.now())
    t.updatedAt = Date.now()
    this.persist()
    return t
  }

  delete(id: string): void {
    this.tasks = this.tasks.filter(x => x.id !== id)
    this.persist()
  }

  toggle(id: string, enabled: boolean): void {
    const t = this.tasks.find(x => x.id === id)
    if (!t) throw new Error('Task not found.')
    t.enabled = enabled
    if (enabled) t.nextRunAt = computeNextRun(t.recurrence, Date.now())
    this.persist()
  }

  async runNow(id: string): Promise<AgentRun> {
    const t = this.tasks.find(x => x.id === id)
    if (!t) throw new Error('Task not found.')
    if (this.d.isLocked()) throw new Error('Kill switch is engaged. Resume the island first.')
    return this.fire(t)
  }

  /** Called by the AgentManager's global onFinish callback whenever a run it fired completes. */
  onRunFinished(run: AgentRun): void {
    const t = this.tasks.find(x => x.id === run.scheduledTaskId)
    if (!t) return
    t.lastRunStatus = run.status
    const summary: ScheduledTaskRunSummary = { at: Date.now(), status: run.status, runId: run.id, summary: (run.output || '').slice(0, 120) }
    const i = t.history.findIndex(h => h.runId === run.id)
    if (i >= 0) t.history[i] = summary
    else t.history = [summary, ...t.history].slice(0, MAX_HISTORY)
    this.persist()
  }

  private budgetOk(): boolean {
    const hourAgo = Date.now() - 3_600_000
    this.fireTimes = this.fireTimes.filter(t => t > hourAgo)
    return this.fireTimes.length < MAX_RUNS_PER_HOUR
  }

  private async tick(): Promise<void> {
    if (this.d.isLocked()) return
    const now = Date.now()
    let throttled = false
    for (const t of this.tasks) {
      if (!t.enabled || !t.nextRunAt || t.nextRunAt > now) continue
      if (!this.budgetOk()) {
        throttled = true
        break
      }
      try {
        await this.fire(t)
      } catch {
        // Already recorded in the task's history by fire(); keep scanning the rest of the batch.
      }
    }
    if (throttled) this.d.log('scheduler.budget-exceeded', `Deferred ${MAX_RUNS_PER_HOUR}/hr cap`)
  }

  private async fire(t: ScheduledTask): Promise<AgentRun> {
    this.fireTimes.push(Date.now())
    try {
      let run: AgentRun
      if (t.context === 'general' && t.mode === 'readonly') {
        run = this.d.agents.liteRun(t.title, SCHEDULED_SYSTEM, t.prompt, this.resolveModel(t), this.d.isLocked())
      } else {
        if (t.context === 'project' && (!t.workspace || !this.d.isInsideWorkspace(t.workspace, this.d.getSettings().workspaces))) {
          throw new Error('Workspace is no longer allowlisted.')
        }
        run = await this.d.queueRun(
          { prompt: t.prompt, title: t.title, context: t.context, provider: t.provider ?? undefined, workspace: t.workspace ?? undefined, mode: t.mode },
          { approved: t.mode === 'readonly' }
        )
      }
      run.scheduledTaskId = t.id
      t.lastRunStatus = run.status
      const summary: ScheduledTaskRunSummary = { at: Date.now(), status: run.status, runId: run.id, summary: (run.output || '').slice(0, 120) }
      t.history = [summary, ...t.history].slice(0, MAX_HISTORY)
      this.advance(t)
      this.persist()
      return run
    } catch (e) {
      t.lastRunStatus = 'error'
      const summary: ScheduledTaskRunSummary = { at: Date.now(), status: 'error', runId: '', summary: (e as Error).message.slice(0, 120) }
      t.history = [summary, ...t.history].slice(0, MAX_HISTORY)
      this.advance(t)
      this.persist()
      throw e
    }
  }

  private resolveModel(t: ScheduledTask): string {
    const s = this.d.getSettings()
    const provider = t.provider ?? s.activeProvider
    return s.providers[provider]?.model ?? ''
  }

  private advance(t: ScheduledTask): void {
    t.runCount++
    t.lastRunAt = Date.now()
    if (t.recurrence.type === 'once') {
      t.enabled = false
      t.nextRunAt = null
    } else {
      t.nextRunAt = computeNextRun(t.recurrence, Date.now())
    }
  }

  private persist(): void {
    this.d.setTasks(this.tasks)
    this.d.onChange()
  }
}

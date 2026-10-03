import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { PluginInfo, PluginManifest, PluginPermission, PluginRunSummary, PluginSettingDef, PluginToolDef, PluginValue, TaskRecurrence } from '@shared/types'
import { computeNextRun } from '../scheduler'
import type { HostCall, HostMessage, WorkerMessage } from './protocol'
import { markdownToHtml } from './report-html'
import { PluginBrowser } from './browser'

/**
 * Plugins: small tools anyone can write and share. A plugin is a folder with `isla-plugin.json` + a JS entry file.
 * Built-in ones ship in the app's plugins/ folder; installed ones live in %APPDATA%\Agentic Island\plugins.
 * Each run gets its own utility process (a crash can't take Isla down, the kill switch ends it). Isla's own powers —
 * AI, notifications, storage, reports — only reach a plugin through `call`, checked against its declared permissions.
 */

export const MANIFEST = 'isla-plugin.json'
const PERMISSIONS: PluginPermission[] = ['ai', 'ai-web', 'notify', 'network', 'browser']
const SETTING_TYPES = ['text', 'textarea', 'number', 'boolean', 'select', 'secret']
const TICK_MS = 30_000
const MAX_HISTORY = 50
const MAX_LOG = 40
const MIN_INTERVAL_MS = 15 * 60_000
/** Per run — keeps a buggy or greedy plugin from burning the user's AI budget. */
const BUDGET = { 'ai.ask': 30, 'ai.research': 5, notify: 3, 'report.save': 5, 'browser.open': 2000 } as const
const MAX_STORAGE_BYTES = 1_000_000
const MAX_REPORT_FILE_BYTES = 5_000_000
const REPORT_FILE = /^[\w .()-]{1,80}\.(md|csv|json|txt|html)$/i
const MAX_REPORT_FILES = 50

interface PluginState {
  enabled: boolean
  values: Record<string, PluginValue>
  schedules: PluginInfo['schedules']
  history: PluginRunSummary[]
}

interface Loaded {
  manifest: PluginManifest
  source: PluginInfo['source']
  dir: string
  entry: string
  error: string | null
}

interface Running {
  plugin: Loaded
  summary: PluginRunSummary
  child: UtilityProcess
  timer: NodeJS.Timeout
  log: string[]
  progress: number | null
  used: Record<keyof typeof BUDGET, number>
  /** Opened on first use (permission "browser"), closed when the run ends. */
  browser: PluginBrowser | null
  done: (s: PluginRunSummary) => void
}

export interface PluginHostDeps {
  /** %APPDATA%\Agentic Island */
  dataDir: string
  /** Plugins that ship with Isla (read-only). */
  builtinDir: string
  reportsDir: string
  workerPath: string
  isLocked: () => boolean
  ai: {
    ask: (system: string, prompt: string) => Promise<string>
    research: (title: string, prompt: string, pluginId: string) => Promise<string>
  }
  notify: (title: string, body: string, ok: boolean) => void
  /** Window icon for the plugin browser. */
  icon?: string
  /** Encrypted store for "secret" settings (API keys). */
  secrets: { get: (key: string) => string | null; set: (key: string, value: string | null) => void }
  onChange: () => void
  log: (kind: string, detail: string) => void
}

// ---------------------------------------------------------------- manifest

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max

function validRecurrence(r: unknown): r is Exclude<TaskRecurrence, { type: 'once' }> {
  const x = r as Record<string, number> & { type: string }
  if (!x || typeof x !== 'object') return false
  const hm = (h: number, m: number) => Number.isInteger(h) && h >= 0 && h < 24 && Number.isInteger(m) && m >= 0 && m < 60
  if (x.type === 'interval') return Number.isFinite(x.everyMs) && x.everyMs >= MIN_INTERVAL_MS
  if (x.type === 'daily') return hm(x.hour, x.minute)
  if (x.type === 'weekly') return hm(x.hour, x.minute) && Number.isInteger(x.weekday) && x.weekday >= 0 && x.weekday <= 6
  return false
}

/** Parse and check isla-plugin.json. Throws a message a plugin author can act on. */
export function readManifest(dir: string): { manifest: PluginManifest; entry: string } {
  const file = join(dir, MANIFEST)
  if (!existsSync(file)) throw new Error(`No ${MANIFEST} in this folder.`)
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`${MANIFEST} is not valid JSON: ${(e as Error).message}`)
  }
  const bad = (what: string) => {
    throw new Error(`${MANIFEST}: ${what}`)
  }
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(raw.id)) bad('"id" must be lowercase letters, digits and dashes (2–49 chars).')
  if (!str(raw.name, 60)) bad('"name" is required (up to 60 chars).')
  if (!str(raw.version, 20)) bad('"version" is required, e.g. "1.0.0".')
  if (typeof raw.description !== 'string' || raw.description.length > 400) bad('"description" is required (up to 400 chars).')

  const main = raw.main === undefined ? 'index.js' : raw.main
  if (typeof main !== 'string' || isAbsolute(main) || !/\.(c|m)?js$/.test(main)) bad('"main" must be a relative .js/.cjs/.mjs file.')
  const entry = resolve(dir, main as string)
  const rel = relative(dir, entry)
  if (rel.startsWith('..') || isAbsolute(rel)) bad('"main" must be inside the plugin folder.')
  if (!existsSync(entry)) bad(`entry file "${main}" was not found.`)

  const permissions = Array.isArray(raw.permissions) ? raw.permissions : []
  for (const p of permissions) if (!PERMISSIONS.includes(p)) bad(`unknown permission "${p}". Use: ${PERMISSIONS.join(', ')}.`)

  const settings: PluginSettingDef[] = []
  for (const s of Array.isArray(raw.settings) ? raw.settings : []) {
    if (!s || typeof s.key !== 'string' || !/^[a-zA-Z]\w{0,39}$/.test(s.key)) bad('each setting needs a "key" (letters, digits, _).')
    if (!str(s.label, 60)) bad(`setting "${s.key}" needs a "label".`)
    if (!SETTING_TYPES.includes(s.type)) bad(`setting "${s.key}": "type" must be one of ${SETTING_TYPES.join(', ')}.`)
    settings.push({
      key: s.key,
      label: s.label,
      type: s.type,
      default: ['string', 'number', 'boolean'].includes(typeof s.default) ? s.default : undefined,
      help: typeof s.help === 'string' ? s.help.slice(0, 200) : undefined,
      options: Array.isArray(s.options) ? s.options.filter((o: unknown) => typeof o === 'string').slice(0, 30) : undefined
    })
  }

  const tools: PluginToolDef[] = []
  for (const t of Array.isArray(raw.tools) ? raw.tools : []) {
    if (!t || typeof t.id !== 'string' || !/^[a-zA-Z][\w-]{0,39}$/.test(t.id)) bad('each tool needs an "id" (letters, digits, _ and -).')
    if (!str(t.title, 80)) bad(`tool "${t.id}" needs a "title".`)
    if (t.schedule !== undefined && !validRecurrence(t.schedule)) bad(`tool "${t.id}": "schedule" must be daily / weekly / interval (15 min or more).`)
    tools.push({
      id: t.id,
      title: t.title,
      description: typeof t.description === 'string' ? t.description.slice(0, 300) : undefined,
      chat: Array.isArray(t.chat) ? t.chat.filter((c: unknown) => str(c, 60)).map((c: string) => c.toLowerCase().trim()).slice(0, 10) : undefined,
      schedule: t.schedule,
      timeoutMinutes: Math.min(120, Math.max(1, Number(t.timeoutMinutes) || 15))
    })
  }
  if (!tools.length) bad('add at least one entry to "tools".')

  return {
    manifest: {
      id: raw.id as string,
      name: (raw.name as string).trim(),
      version: (raw.version as string).trim(),
      description: raw.description as string,
      author: typeof raw.author === 'string' ? raw.author.slice(0, 80) : undefined,
      homepage: typeof raw.homepage === 'string' && /^https:\/\//.test(raw.homepage) ? raw.homepage.slice(0, 200) : undefined,
      main: main as string,
      permissions,
      settings,
      tools
    },
    entry
  }
}

export const PERMISSION_TEXT: Record<PluginPermission, string> = {
  ai: 'Use your AI agent for short text jobs (counts toward your usage)',
  'ai-web': 'Run read-only AI web research (shown in your task list)',
  notify: 'Show notifications on the island',
  network: 'Visit websites',
  browser: 'Open web pages in a private Isla browser window (it can’t see your signed-in sites)'
}

// ---------------------------------------------------------------- host

export class PluginHost {
  private plugins = new Map<string, Loaded>()
  private state: Record<string, PluginState> = {}
  private running = new Map<string, Running>()
  private timer: NodeJS.Timeout | null = null

  constructor(private d: PluginHostDeps) {}

  get installedDir(): string {
    return join(this.d.dataDir, 'plugins')
  }

  private get stateFile(): string {
    return join(this.d.dataDir, 'plugins.json')
  }

  load(): void {
    mkdirSync(this.installedDir, { recursive: true })
    try {
      this.state = JSON.parse(readFileSync(this.stateFile, 'utf8'))
    } catch {
      this.state = {}
    }
    this.scan()
  }

  /** Re-read every plugin folder. Installed plugins win over a built-in one with the same id. */
  scan(): void {
    const next = new Map<string, Loaded>()
    for (const [root, source] of [[this.d.builtinDir, 'builtin'], [this.installedDir, 'installed']] as const) {
      if (!existsSync(root)) continue
      for (const name of readdirSync(root)) {
        const dir = join(root, name)
        if (!statSync(dir).isDirectory() || !existsSync(join(dir, MANIFEST))) continue
        try {
          const { manifest, entry } = readManifest(dir)
          next.set(manifest.id, { manifest, source, dir, entry, error: null })
        } catch (e) {
          // Still listed, so the author sees what's wrong.
          const id = `broken-${name.toLowerCase().replace(/[^a-z0-9-]/g, '')}`
          next.set(id, {
            manifest: { id, name, version: '?', description: '', permissions: [], tools: [] },
            source,
            dir,
            entry: '',
            error: (e as Error).message
          })
        }
      }
    }
    this.plugins = next
    for (const p of next.values()) this.stateOf(p)
    this.d.onChange()
  }

  private stateOf(p: Loaded): PluginState {
    const id = p.manifest.id
    const st = (this.state[id] ??= { enabled: p.source === 'installed', values: {}, schedules: {}, history: [] })
    // Tools with a suggested schedule get an entry (off until the user turns it on).
    for (const t of p.manifest.tools) {
      if (t.schedule && !st.schedules[t.id]) st.schedules[t.id] = { enabled: false, recurrence: t.schedule, nextRunAt: null }
    }
    return st
  }

  private secretKey(id: string, key: string): string {
    return `plugin:${id}:${key}`
  }

  /** `reveal`: fill in secret settings (only for the plugin's own run, never for the UI). */
  private values(p: Loaded, reveal = false): Record<string, PluginValue> {
    const st = this.stateOf(p)
    const out: Record<string, PluginValue> = {}
    for (const s of p.manifest.settings ?? []) {
      if (s.type === 'secret') out[s.key] = reveal ? this.d.secrets.get(this.secretKey(p.manifest.id, s.key)) ?? '' : ''
      else out[s.key] = st.values[s.key] ?? s.default ?? (s.type === 'boolean' ? false : s.type === 'number' ? 0 : '')
    }
    return out
  }

  list(): PluginInfo[] {
    return [...this.plugins.values()]
      .map(p => {
        const st = this.stateOf(p)
        const r = this.running.get(p.manifest.id)
        return {
          manifest: p.manifest,
          source: p.source,
          dir: p.dir,
          enabled: st.enabled && !p.error,
          error: p.error,
          values: this.values(p),
          secretsSet: (p.manifest.settings ?? []).filter(s => s.type === 'secret' && this.d.secrets.get(this.secretKey(p.manifest.id, s.key))).map(s => s.key),
          schedules: st.schedules,
          running: r ? { runId: r.summary.id, toolId: r.summary.toolId, startedAt: r.summary.startedAt, log: r.log, progress: r.progress } : null,
          history: st.history.map(h => ({ ...h, log: h.log ?? [] }))
        }
      })
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
  }

  private get(id: string): Loaded {
    const p = this.plugins.get(id)
    if (!p) throw new Error('Plugin not found.')
    return p
  }

  private persist(): void {
    const tmp = this.stateFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, this.stateFile)
    this.d.onChange()
  }

  // ---- settings

  setEnabled(id: string, enabled: boolean): void {
    const p = this.get(id)
    if (p.error) throw new Error(p.error)
    this.stateOf(p).enabled = enabled
    if (!enabled) this.stop(id)
    for (const s of Object.values(this.stateOf(p).schedules)) s.nextRunAt = enabled && s.enabled ? computeNextRun(s.recurrence, Date.now()) : null
    this.d.log(enabled ? 'plugin.enabled' : 'plugin.disabled', id)
    this.persist()
  }

  setValues(id: string, values: Record<string, unknown>): void {
    const p = this.get(id)
    const st = this.stateOf(p)
    for (const def of p.manifest.settings ?? []) {
      if (!(def.key in values)) continue
      const v = values[def.key]
      if (def.type === 'secret') {
        // '' = keep what is saved, null = forget it.
        if (v === null) this.d.secrets.set(this.secretKey(id, def.key), null)
        else if (typeof v === 'string' && v.trim()) this.d.secrets.set(this.secretKey(id, def.key), v.trim().slice(0, 500))
        continue
      }
      if (def.type === 'boolean') st.values[def.key] = v === true
      else if (def.type === 'number') st.values[def.key] = Number.isFinite(Number(v)) ? Number(v) : 0
      else if (def.type === 'select' && def.options?.length && !def.options.includes(String(v))) continue
      else st.values[def.key] = String(v ?? '').slice(0, 20_000)
    }
    this.persist()
  }

  setSchedule(id: string, toolId: string, sched: { enabled: boolean; recurrence: TaskRecurrence }): void {
    const p = this.get(id)
    if (!p.manifest.tools.some(t => t.id === toolId)) throw new Error('Tool not found.')
    if (!validRecurrence(sched.recurrence)) throw new Error('Pick a daily or weekly time, or an interval of 15 minutes or more.')
    const st = this.stateOf(p)
    const on = sched.enabled === true
    st.schedules[toolId] = { enabled: on, recurrence: sched.recurrence, nextRunAt: on && st.enabled ? computeNextRun(sched.recurrence, Date.now()) : null }
    this.d.log('plugin.schedule', `${id}/${toolId} ${on ? 'on' : 'off'}`)
    this.persist()
  }

  // ---- install / share

  /** Copy a plugin folder into the installed plugins (replacing an older version). `confirm` shows the permissions first. */
  async install(srcDir: string, confirm: (m: PluginManifest, update: Loaded | null) => Promise<boolean>): Promise<{ ok: boolean; message: string }> {
    const { manifest } = readManifest(srcDir)
    const existing = this.plugins.get(manifest.id) ?? null
    if (!(await confirm(manifest, existing))) return { ok: false, message: 'Install cancelled.' }
    if (this.running.has(manifest.id)) throw new Error(`${manifest.name} is running — stop it first.`)
    const dest = join(this.installedDir, manifest.id)
    const staging = `${dest}.installing`
    rmSync(staging, { recursive: true, force: true })
    cpSync(srcDir, staging, { recursive: true, filter: f => !/[\\/]\.git([\\/]|$)/.test(f) })
    rmSync(dest, { recursive: true, force: true })
    renameSync(staging, dest)
    const st = this.state[manifest.id]
    if (st) st.enabled = true
    this.scan()
    this.persist()
    this.d.log('plugin.installed', `${manifest.id}@${manifest.version}`)
    return { ok: true, message: `${existing ? 'Updated' : 'Installed'} ${manifest.name} ${manifest.version}.` }
  }

  async installZip(zip: string, confirm: Parameters<PluginHost['install']>[1]): Promise<{ ok: boolean; message: string }> {
    const tmp = join(this.d.dataDir, 'plugin-tmp', randomUUID())
    mkdirSync(tmp, { recursive: true })
    try {
      // Windows' own bsdtar reads zip files and refuses absolute or ../ paths.
      await tar(['-x', '-f', zip, '-C', tmp])
      let root = tmp
      if (!existsSync(join(root, MANIFEST))) {
        const subs = readdirSync(tmp).filter(n => statSync(join(tmp, n)).isDirectory())
        if (subs.length === 1 && existsSync(join(tmp, subs[0], MANIFEST))) root = join(tmp, subs[0])
        else throw new Error(`That .zip has no ${MANIFEST} at its top level.`)
      }
      return await this.install(root, confirm)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  async exportZip(id: string, outFile: string): Promise<void> {
    const p = this.get(id)
    rmSync(outFile, { force: true })
    await tar(['-a', '-c', '-f', outFile, '--exclude', '.git', '--exclude', 'node_modules/.cache', '-C', p.dir, '.'])
    this.d.log('plugin.exported', `${id} → ${basename(outFile)}`)
  }

  uninstall(id: string): void {
    const p = this.get(id)
    if (p.source !== 'installed') throw new Error('Built-in plugins can be turned off, not removed.')
    this.stop(id)
    rmSync(p.dir, { recursive: true, force: true })
    rmSync(join(this.d.dataDir, 'plugin-data', id), { recursive: true, force: true })
    for (const s of p.manifest.settings ?? []) if (s.type === 'secret') this.d.secrets.set(this.secretKey(id, s.key), null)
    delete this.state[id]
    this.d.log('plugin.uninstalled', id)
    this.scan()
    this.persist()
  }

  /** The page to open for a run: report.html (made from report.md), else the folder. */
  reportPath(id: string, runId: string): string | null {
    const h = this.state[id]?.history.find(x => x.id === runId)
    if (!h?.reportDir) return null
    for (const f of ['report.html', 'report.md']) if (existsSync(join(h.reportDir, f))) return join(h.reportDir, f)
    return existsSync(h.reportDir) ? h.reportDir : null
  }

  /** Where all of a plugin's reports go (one sub-folder per run). */
  reportsDirOf(id: string): string {
    const pluginName = safeName(this.get(id).manifest.name)
    const dir = join(this.d.reportsDir, pluginName)
    try {
      mkdirSync(dir, { recursive: true })
      return dir
    } catch {
      const fallback = join(this.d.dataDir, 'reports', pluginName)
      mkdirSync(fallback, { recursive: true })
      return fallback
    }
  }

  /** One past run as a .zip: its report files plus run.md (status, times, summary, log). Works for runs without a report too. */
  async exportRun(id: string, runId: string, outFile: string): Promise<void> {
    const p = this.get(id)
    const h = this.stateOf(p).history.find(x => x.id === runId)
    if (!h) throw new Error('That run is no longer in the history.')
    const tmp = join(this.d.dataDir, 'plugin-tmp', randomUUID())
    mkdirSync(tmp, { recursive: true })
    try {
      if (h.reportDir && existsSync(h.reportDir)) cpSync(h.reportDir, tmp, { recursive: true })
      const when = (t: number | null) => (t ? new Date(t).toLocaleString() : '-')
      const tool = p.manifest.tools.find(t => t.id === h.toolId)?.title ?? h.toolId
      const fence = '```'
      writeFileSync(
        join(tmp, 'run.md'),
        `# ${p.manifest.name}: ${tool}\n\n- Status: ${h.status}\n- Started: ${when(h.startedAt)} (${h.trigger})\n- Ended: ${when(h.endedAt)}\n- Plugin version: ${p.manifest.version}\n\n## Summary\n\n${h.summary}\n\n## Log\n\n${fence}\n${(h.log ?? []).join('\n')}\n${fence}\n`,
        'utf8'
      )
      rmSync(outFile, { force: true })
      await tar(['-a', '-c', '-f', outFile, '-C', tmp, '.'])
      this.d.log('plugin.run-exported', `${id}/${runId}`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  /** Forget a past run and delete its report folder (only if it is inside Isla's reports folder). */
  deleteRun(id: string, runId: string): void {
    const st = this.stateOf(this.get(id))
    const h = st.history.find(x => x.id === runId)
    if (!h) return
    const rel = h.reportDir ? relative(this.d.reportsDir, h.reportDir) : ''
    if (h.reportDir && rel && !rel.startsWith('..') && !isAbsolute(rel)) rmSync(h.reportDir, { recursive: true, force: true })
    st.history = st.history.filter(x => x.id !== runId)
    this.d.log('plugin.run-deleted', `${id}/${runId}`)
    this.persist()
  }

  // ---- chat

  /**
   * "seo scout dentists in Colombo" → the plugin tool that listed one of those phrases (or "run <plugin name>").
   * Turned-off plugins match too, so run() can say "turn it on" instead of the message going to an agent.
   */
  matchChat(text: string): { id: string; toolId: string; name: string } | null {
    const t = text.toLowerCase().replace(/\s+/g, ' ').trim()
    for (const p of this.plugins.values()) {
      if (p.error) continue
      const byName = new RegExp(`^(run|start|use|open)( the)? ${p.manifest.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( plugin)?\\b`)
      if (byName.test(t)) return { id: p.manifest.id, toolId: p.manifest.tools[0].id, name: p.manifest.name }
      for (const tool of p.manifest.tools) {
        if (tool.chat?.some(c => t.includes(c))) return { id: p.manifest.id, toolId: tool.id, name: p.manifest.name }
      }
    }
    return null
  }

  // ---- running

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    // Schedules that were on when Isla closed pick up from the next occurrence (never backfilled).
    let changed = false
    for (const [id, st] of Object.entries(this.state)) {
      for (const s of Object.values(st.schedules)) {
        if (s.enabled && st.enabled && this.plugins.has(id) && (!s.nextRunAt || s.nextRunAt < Date.now())) {
          s.nextRunAt = computeNextRun(s.recurrence, Date.now())
          changed = true
        }
      }
    }
    if (changed) this.persist()
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    if (this.d.isLocked()) return
    const now = Date.now()
    for (const p of this.plugins.values()) {
      const st = this.stateOf(p)
      if (p.error || !st.enabled) continue
      for (const [toolId, s] of Object.entries(st.schedules)) {
        if (!s.enabled || !s.nextRunAt || s.nextRunAt > now) continue
        s.nextRunAt = computeNextRun(s.recurrence, now)
        this.persist()
        if (this.running.has(p.manifest.id)) continue
        try {
          void this.run(p.manifest.id, toolId, 'schedule')
        } catch (e) {
          this.d.log('plugin.schedule-error', `${p.manifest.id}: ${(e as Error).message}`)
        }
      }
    }
  }

  /** Start a tool. Resolves when the run ends (it never rejects after it has started — errors land in the summary). */
  run(id: string, toolId: string, trigger: PluginRunSummary['trigger'], text = ''): Promise<PluginRunSummary> {
    if (this.d.isLocked()) throw new Error('Kill switch is engaged. Resume the island first.')
    const p = this.get(id)
    if (p.error) throw new Error(p.error)
    if (!this.stateOf(p).enabled) throw new Error(`${p.manifest.name} is turned off. Turn it on in the Plugins tab.`)
    const tool = p.manifest.tools.find(t => t.id === toolId)
    if (!tool) throw new Error('Tool not found.')
    if (this.running.has(id)) throw new Error(`${p.manifest.name} is already running.`)

    const summary: PluginRunSummary = { id: randomUUID(), toolId, startedAt: Date.now(), endedAt: null, status: 'running', trigger, summary: '', reportDir: null, reportFiles: [], log: [] }
    const child = utilityProcess.fork(this.d.workerPath, [], {
      serviceName: `Isla plugin ${p.manifest.id}`,
      cwd: this.dataDirOf(id),
      stdio: 'pipe',
      // No Isla secrets or tokens in the plugin's environment.
      env: { SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '', PATH: process.env.PATH ?? '' }
    })
    return new Promise<PluginRunSummary>(done => {
      const r: Running = {
        plugin: p,
        summary,
        child,
        timer: setTimeout(() => this.finish(id, 'error', `Stopped after ${tool.timeoutMinutes} minutes (time limit).`), (tool.timeoutMinutes ?? 15) * 60_000),
        log: [],
        progress: null,
        used: { 'ai.ask': 0, 'ai.research': 0, notify: 0, 'report.save': 0, 'browser.open': 0 },
        browser: null,
        done
      }
      this.running.set(id, r)
      this.d.log('plugin.run', `${id}/${toolId} (${trigger})`)
      const onOut = (d: Buffer) => this.addLog(r, d.toString('utf8'))
      child.stdout?.on('data', onOut)
      child.stderr?.on('data', onOut)
      child.on('spawn', () => {
        const msg: HostMessage = { type: 'run', pluginId: id, entry: p.entry, toolId, input: { text, trigger }, settings: this.values(p, true) }
        child.postMessage(msg)
      })
      child.on('message', (m: WorkerMessage) => void this.onMessage(id, r, m))
      child.on('exit', code => this.finish(id, 'error', `The plugin stopped unexpectedly (exit code ${code}).`))
      this.d.onChange()
    })
  }

  stop(id: string): void {
    if (this.running.has(id)) this.finish(id, 'stopped', 'Stopped by you.')
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.finish(id, 'stopped', 'Stopped by the kill switch.')
  }

  private dataDirOf(id: string): string {
    const dir = join(this.d.dataDir, 'plugin-data', id)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private addLog(r: Running, text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const l = line.trimEnd()
      if (l) r.log.push(l.slice(0, 300))
    }
    if (r.log.length > MAX_LOG) r.log.splice(0, r.log.length - MAX_LOG)
    this.d.onChange()
  }

  private async onMessage(id: string, r: Running, m: WorkerMessage): Promise<void> {
    if (this.running.get(id) !== r) return
    if (m.type === 'log') return this.addLog(r, m.text)
    if (m.type === 'progress') {
      r.progress = m.value
      if (m.text) this.addLog(r, m.text)
      else this.d.onChange()
      return
    }
    if (m.type === 'done') return this.finish(id, 'done', m.summary)
    if (m.type === 'error') return this.finish(id, 'error', m.message, m.stack)
    if (m.type === 'call') {
      let reply: HostMessage
      try {
        reply = { type: 'reply', callId: m.callId, ok: true, value: await this.handleCall(r, m) }
      } catch (e) {
        reply = { type: 'reply', callId: m.callId, ok: false, error: (e as Error).message }
      }
      if (this.running.get(id) === r) r.child.postMessage(reply)
    }
  }

  private async handleCall(r: Running, c: HostCall): Promise<unknown> {
    const m = r.plugin.manifest
    const need = (perm: PluginPermission) => {
      if (!m.permissions.includes(perm)) throw new Error(`${m.name} did not ask for the "${perm}" permission in ${MANIFEST}.`)
    }
    const spend = (k: keyof typeof BUDGET) => {
      if (r.used[k] >= BUDGET[k]) throw new Error(`Limit reached: ${BUDGET[k]} × ${k} per run.`)
      r.used[k]++
    }
    if (this.d.isLocked()) throw new Error('Kill switch is engaged.')
    switch (c.method) {
      case 'ai.ask': {
        need('ai')
        spend('ai.ask')
        const [prompt, system] = c.args
        return this.d.ai.ask(
          system.slice(0, 4000) || `You are a helper inside the "${m.name}" plugin of Isla. Answer exactly what is asked, concisely.`,
          prompt.slice(0, 30_000)
        )
      }
      case 'ai.research': {
        need('ai-web')
        spend('ai.research')
        const [prompt, title] = c.args
        return this.d.ai.research((title || `${m.name}: research`).slice(0, 80), prompt.slice(0, 20_000), m.id)
      }
      case 'notify': {
        need('notify')
        spend('notify')
        this.d.notify(`${m.name}: ${c.args[0]}`.slice(0, 80), c.args[1].slice(0, 200), true)
        return null
      }
      case 'storage.get':
        return this.readStorage(m.id)[c.args[0]] ?? null
      case 'storage.set': {
        const data = this.readStorage(m.id)
        if (c.args[1] === undefined || c.args[1] === null) delete data[c.args[0]]
        else data[c.args[0]] = c.args[1]
        const json = JSON.stringify(data)
        if (json.length > MAX_STORAGE_BYTES) throw new Error('Plugin storage is full (1 MB).')
        writeFileSync(join(this.dataDirOf(m.id), 'storage.json'), json, 'utf8')
        return null
      }
      case 'report.save': {
        spend('report.save')
        return this.saveReport(r, c.args[0])
      }
      case 'browser.open': {
        need('browser')
        spend('browser.open')
        r.browser ??= new PluginBrowser(`${m.name} — Isla plugin browser`, this.d.icon)
        const o = c.args[1] ?? {}
        return r.browser.open(String(c.args[0]), {
          width: Number(o.width) || undefined,
          height: Number(o.height) || undefined,
          timeoutMs: Number(o.timeoutMs) || undefined,
          fresh: o.fresh === true
        })
      }
      case 'browser.eval':
        need('browser')
        if (!r.browser) throw new Error('Open a page first (ctx.browser.open).')
        return r.browser.eval(String(c.args[0]), Number(c.args[1]) || 30_000)
      case 'browser.show':
        need('browser')
        r.browser ??= new PluginBrowser(`${m.name} — Isla plugin browser`, this.d.icon)
        r.browser.show(c.args[0] === true)
        return null
      case 'browser.close':
        r.browser?.close()
        r.browser = null
        return null
    }
  }

  private readStorage(id: string): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(join(this.dataDirOf(id), 'storage.json'), 'utf8'))
    } catch {
      return {}
    }
  }

  private saveReport(r: Running, rep: { title: string; markdown: string; files?: Record<string, string> }): string {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`
    const title = String(rep.title ?? '').slice(0, 200)
    const markdown = String(rep.markdown ?? '')
    // report.html is made from report.md, so every plugin's report opens nicely in the browser.
    const files: Record<string, string> = { 'report.md': `# ${title}\n\n${markdown}`, 'report.html': markdownToHtml(title, markdown) }
    const extra = Object.entries(rep.files ?? {})
    if (extra.length > MAX_REPORT_FILES) throw new Error(`At most ${MAX_REPORT_FILES} extra report files.`)
    for (const [name, content] of extra) {
      if (!REPORT_FILE.test(name) || name in files) throw new Error(`Report file name not allowed: ${name} (use .md, .csv, .json, .txt or .html; report.md and report.html are made for you).`)
      files[name] = String(content)
    }

    const candidateBases = [this.d.reportsDir, join(this.d.dataDir, 'reports')]
    let savedFolder = ''
    let lastError: unknown = null

    for (const base of candidateBases) {
      try {
        const folder = join(base, safeName(r.plugin.manifest.name), stamp)
        mkdirSync(folder, { recursive: true })
        for (const [name, content] of Object.entries(files)) {
          if (content.length > MAX_REPORT_FILE_BYTES) throw new Error(`${name} is larger than 5 MB.`)
          writeFileSync(join(folder, name), (name.endsWith('.csv') ? '\ufeff' : '') + content, 'utf8')
        }
        savedFolder = folder
        break
      } catch (err: any) {
        lastError = err
        if (err?.code === 'EPERM' || err?.code === 'EACCES') {
          continue
        }
        throw err
      }
    }

    if (!savedFolder) {
      throw lastError ?? new Error('Failed to save report to disk.')
    }

    r.summary.reportDir = savedFolder
    r.summary.reportFiles = Object.keys(files)
    return savedFolder
  }

  private finish(id: string, status: PluginRunSummary['status'], summary: string, stack = ''): void {
    const r = this.running.get(id)
    if (!r) return
    this.running.delete(id)
    clearTimeout(r.timer)
    r.child.removeAllListeners('exit')
    r.child.kill()
    r.browser?.close()
    r.summary.status = status
    r.summary.endedAt = Date.now()
    // The result shows the plain message; the stack trace goes to the run's log (Log button) for the plugin's author.
    const stackLines = stack
      .split(/\r?\n/)
      .slice(1, 8)
      .map(l => l.trim())
      .filter(Boolean)
    r.summary.log = [...r.log, ...stackLines].slice(-MAX_LOG)
    r.summary.summary = summary.replace(/^Error:\s*/, '')
    const st = this.stateOf(r.plugin)
    st.history = [r.summary, ...st.history].slice(0, MAX_HISTORY)
    this.persist()
    this.d.log(`plugin.${status}`, `${id}/${r.summary.toolId}`)
    const tool = r.plugin.manifest.tools.find(t => t.id === r.summary.toolId)
    if (status !== 'stopped') this.d.notify(`${r.plugin.manifest.name}${status === 'done' ? ' finished' : ' failed'}`, tool?.title ?? '', status === 'done')
    r.done(r.summary)
  }
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, '').trim() || 'Plugin'

function tar(args: string[]): Promise<void> {
  // Full path, so a tar.exe elsewhere on PATH can't stand in for Windows' own.
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return new Promise((res, rej) =>
    execFile(exe, args, { windowsHide: true, timeout: 120_000 }, (err, _out, stderr) => (err ? rej(new Error(String(stderr || err.message).trim())) : res()))
  )
}

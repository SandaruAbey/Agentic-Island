import { winHelper } from './winhelper'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir, cpus } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import type { AiLimit, AiProcess, ModelUsage, UsageLimitConfig, UsageReport, UsageRing } from '@shared/types'

type Source = ModelUsage['source']
interface Row {
  date: string // YYYY-MM-DD local
  source: Source
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  requests: number
}

const DAYS = 7
const fileCache = new Map<string, { mtime: number; size: number; rows: Row[] }>()

const localDate = (ts: number | string) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function walk(dir: string, depth: number, since: number, out: string[], exts: string[] = ['.jsonl']): void {
  if (!existsSync(dir) || depth < 0) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, depth - 1, since, out, exts)
    else if (exts.some(ext => e.name.endsWith(ext))) {
      try {
        if (statSync(p).mtimeMs >= since) out.push(p)
      } catch {
        /* ignore */
      }
    }
  }
}

function addRow(map: Map<string, Row>, r: Omit<Row, 'requests'>): void {
  const key = `${r.date}|${r.source}|${r.model}`
  const cur = map.get(key) ?? { ...r, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
  cur.input += r.input
  cur.output += r.output
  cur.cacheRead += r.cacheRead
  cur.cacheWrite += r.cacheWrite
  cur.requests += 1
  map.set(key, cur)
}

async function parseFile(path: string, kind: 'claude' | 'codex', seenIds: Set<string>): Promise<Row[]> {
  const st = statSync(path)
  const cached = fileCache.get(path)
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.rows
  const map = new Map<string, Row>()
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  let codexModel = 'codex'
  let prevTotal = { input: 0, output: 0, cached: 0 }
  for await (const line of rl) {
    if (!line || line.length > 2_000_000) continue
    if (kind === 'claude' && !line.includes('"usage"')) continue
    if (kind === 'codex' && !line.includes('token_count') && !line.includes('turn_context')) continue
    let j: any
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if (kind === 'claude') {
      const u = j.message?.usage
      if (!u || !j.timestamp) continue
      const id = `${j.message?.id ?? ''}:${j.requestId ?? ''}`
      if (id !== ':' && seenIds.has(id)) continue
      seenIds.add(id)
      addRow(map, {
        date: localDate(j.timestamp),
        source: 'Claude Code',
        model: j.message?.model ?? 'unknown',
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0
      })
    } else {
      if (j.type === 'turn_context' && j.payload?.model) codexModel = j.payload.model
      // Codex logs its real plan rate limits (5-hour + weekly windows) — keep the newest.
      const rl = j.payload?.rate_limits
      if (rl && j.timestamp) {
        const at = Date.parse(j.timestamp)
        if (!codexLimits || at > codexLimits.at) codexLimits = { at, primary: rl.primary ?? null, secondary: rl.secondary ?? null }
      }
      const info = j.payload?.type === 'token_count' ? j.payload.info : null
      const t = info?.total_token_usage
      if (!t || !j.timestamp) continue
      const cur = { input: t.input_tokens ?? 0, output: t.output_tokens ?? 0, cached: t.cached_input_tokens ?? 0 }
      const d = { input: cur.input - prevTotal.input, output: cur.output - prevTotal.output, cached: cur.cached - prevTotal.cached }
      prevTotal = cur
      if (d.input <= 0 && d.output <= 0) continue
      addRow(map, {
        date: localDate(j.timestamp),
        source: 'Codex',
        model: codexModel,
        input: Math.max(0, d.input - d.cached),
        output: Math.max(0, d.output),
        cacheRead: Math.max(0, d.cached),
        cacheWrite: 0
      })
    }
  }
  const rows = [...map.values()]
  fileCache.set(path, { mtime: st.mtimeMs, size: st.size, rows })
  return rows
}

export async function scanUsage(islandCostUsd: number, islandRows: ModelUsage[]): Promise<UsageReport> {
  const since = Date.now() - DAYS * 86_400_000
  const notes: string[] = []
  const claudeRoots = [
    process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'projects') : '',
    join(homedir(), '.claude', 'projects'),
    join(homedir(), '.config', 'claude', 'projects')
  ].filter(Boolean)
  const codexRoot = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')

  const claudeFiles: string[] = []
  for (const r of new Set(claudeRoots)) walk(r, 3, since, claudeFiles)
  const codexFiles: string[] = []
  walk(codexRoot, 4, since, codexFiles)
  if (!claudeFiles.length) notes.push('No Claude Code sessions found in the last 7 days (~/.claude/projects).')
  if (!codexFiles.length) notes.push('No Codex sessions found in the last 7 days (~/.codex/sessions).')

  const rows: Row[] = []
  const seen = new Set<string>()
  for (const f of claudeFiles) rows.push(...(await parseFile(f, 'claude', seen).catch(() => [])))
  for (const f of codexFiles) rows.push(...(await parseFile(f, 'codex', new Set()).catch(() => [])))

  // ---- Antigravity: try to find real token logs ----
  const antigravityRoots = [
    join(homedir(), '.gemini', 'logs'),
    join(homedir(), '.gemini', 'usage'),
    join(homedir(), '.gemini', 'sessions'),
    join(process.env.APPDATA ?? '', 'Antigravity', 'logs'),
    join(process.env.APPDATA ?? '', 'Antigravity', 'usage'),
    join(process.env.APPDATA ?? '', 'Antigravity IDE', 'logs'),
    join(process.env.LOCALAPPDATA ?? '', 'antigravity', 'logs'),
    join(process.env.LOCALAPPDATA ?? '', 'antigravity', 'usage')
  ].filter(Boolean)
  const antigravityFiles: string[] = []
  for (const r of new Set(antigravityRoots)) walk(r, 3, since, antigravityFiles, ['.jsonl', '.json', '.log'])
  let antigravityFound = false
  for (const f of antigravityFiles) {
    const aRows = await parseAntigravityFile(f, since).catch(() => [])
    if (aRows.length) {
      antigravityFound = true
      rows.push(...aRows)
    }
  }
  if (!antigravityFound) {
    notes.push('No Antigravity usage logs found — Antigravity shows its own quota in its settings.')
  }

  const today = localDate(Date.now())
  const agg = (filter: (r: Row) => boolean): ModelUsage[] => {
    const m = new Map<string, ModelUsage>()
    for (const r of rows) {
      if (!filter(r)) continue
      const k = `${r.source}|${r.model}`
      const cur = m.get(k) ?? { source: r.source, model: r.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
      cur.input += r.input
      cur.output += r.output
      cur.cacheRead += r.cacheRead
      cur.cacheWrite += r.cacheWrite
      cur.requests += r.requests
      m.set(k, cur)
    }
    return [...m.values()].sort((a, b) => b.input + b.output - (a.input + a.output))
  }
  const sinceDate = localDate(since)
  const daily: { date: string; tokens: number }[] = []
  for (let i = DAYS - 1; i >= 0; i--) {
    const date = localDate(Date.now() - i * 86_400_000)
    daily.push({ date, tokens: rows.filter(r => r.date === date).reduce((s, r) => s + r.input + r.output + r.cacheWrite, 0) })
  }
  return {
    today: [...agg(r => r.date === today), ...islandRows],
    week: agg(r => r.date >= sinceDate),
    daily,
    islandCostUsd,
    scannedAt: Date.now(),
    notes
  }
}

// ---- Usage rings: today + this week per AI ----

interface CodexWindow {
  used_percent?: number
  window_minutes?: number
  resets_in_seconds?: number
  resets_at?: number
}
let codexLimits: { at: number; primary: CodexWindow | null; secondary: CodexWindow | null } | null = null

async function collectRows(days: number): Promise<Row[]> {
  const since = Date.now() - days * 86_400_000
  const claudeRoots = [
    process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'projects') : '',
    join(homedir(), '.claude', 'projects'),
    join(homedir(), '.config', 'claude', 'projects')
  ].filter(Boolean)
  const claudeFiles: string[] = []
  for (const r of new Set(claudeRoots)) walk(r, 3, since, claudeFiles)
  const codexFiles: string[] = []
  walk(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'), 4, since, codexFiles)
  const rows: Row[] = []
  const seen = new Set<string>()
  for (const f of claudeFiles) rows.push(...(await parseFile(f, 'claude', seen).catch(() => [])))
  for (const f of codexFiles) rows.push(...(await parseFile(f, 'codex', new Set()).catch(() => [])))
  return rows
}

function startOfWeek(now: Date, weekStartDay: number): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const back = (d.getDay() - weekStartDay + 7) % 7
  d.setDate(d.getDate() - back)
  return d
}

function codexResetAt(w: CodexWindow, loggedAt: number): number {
  if (typeof w.resets_at === 'number') return w.resets_at > 1e12 ? w.resets_at : w.resets_at * 1000
  if (typeof w.resets_in_seconds === 'number') return loggedAt + w.resets_in_seconds * 1000
  return loggedAt + (w.window_minutes ?? 300) * 60_000
}

// ---- Real Claude plan usage (same source as Claude Code's /usage) ----

interface ClaudeWindow {
  utilization: number
  resets_at: string | null
}
let claudePlanCache: { at: number; five: ClaudeWindow | null; week: ClaudeWindow | null; error: string | null } | null = null

/**
 * Asks Anthropic for *your own* plan usage using the sign-in Claude Code already stored on this PC.
 * The token is read in the main process only, sent only to api.anthropic.com, never logged or stored by Isla.
 * Cached for 3 minutes. Never refreshes or modifies your sign-in.
 */
async function claudePlanUsage(): Promise<typeof claudePlanCache> {
  if (claudePlanCache && Date.now() - claudePlanCache.at < 180_000) return claudePlanCache
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  let token: string | undefined
  try {
    const o = JSON.parse(readFileSync(join(base, '.credentials.json'), 'utf8'))?.claudeAiOauth
    if (o?.expiresAt && Number(o.expiresAt) < Date.now()) {
      claudePlanCache = { at: Date.now(), five: null, week: null, error: 'Claude Code sign-in expired — open Claude Code once to refresh it.' }
      return claudePlanCache
    }
    token = o?.accessToken
  } catch {
    /* not signed in with a Claude plan */
  }
  if (!token) return null
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'agentic-island' },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`Anthropic usage API returned ${res.status}`)
    const j = await res.json()
    claudePlanCache = { at: Date.now(), five: j.five_hour ?? null, week: j.seven_day ?? null, error: null }
  } catch (e) {
    claudePlanCache = { at: Date.now(), five: null, week: null, error: (e as Error).message }
  }
  return claudePlanCache
}

export async function computeLimits(cfg: UsageLimitConfig): Promise<AiLimit[]> {
  const rows = await collectRows(28)
  const now = new Date()
  const today = localDate(now.getTime())
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
  const weekStart = startOfWeek(now, cfg.weekStartDay)
  const weekStartDate = localDate(weekStart.getTime())
  const nextWeek = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7).getTime()
  const out: AiLimit[] = []

  const defs: { id: AiLimit['id']; source: Source; label: string; color: string; daily: number; weekly: number }[] = [
    { id: 'claude', source: 'Claude Code', label: 'Claude', color: '#ff9f0a', daily: cfg.claudeDaily, weekly: cfg.claudeWeekly },
    { id: 'codex', source: 'Codex', label: 'Codex', color: '#30d158', daily: cfg.codexDaily, weekly: cfg.codexWeekly }
  ]
  for (const d of defs) {
    const perDay = new Map<string, number>()
    for (const r of rows) if (r.source === d.source) perDay.set(r.date, (perDay.get(r.date) ?? 0) + r.input + r.output + r.cacheWrite)
    const reported = d.id === 'codex' && codexLimits && Date.now() - codexLimits.at < 7 * 86_400_000 ? codexLimits : null
    const plan = d.id === 'claude' && cfg.readPlanUsage ? await claudePlanUsage() : null
    if (plan?.five && plan.week) {
      // Real numbers from your Claude plan — identical to Claude Code's /usage screen.
      const at = (s: string | null, fallback: number) => (s ? Date.parse(s) : fallback)
      out.push({
        id: 'claude',
        label: 'Claude',
        color: d.color,
        inner: { label: 'Session (5h)', pct: Math.round(plan.five.utilization), used: null, limit: null, resetsAt: at(plan.five.resets_at, Date.now() + 5 * 3_600_000) },
        outer: { label: 'Weekly (7 day)', pct: Math.round(plan.week.utilization), used: null, limit: null, resetsAt: at(plan.week.resets_at, nextWeek) },
        reported: true
      })
      continue
    }
    if (!perDay.size && !reported) continue

    const usedToday = perDay.get(today) ?? 0
    let usedWeek = 0
    for (const [date, n] of perDay) if (date >= weekStartDate) usedWeek += n
    // Auto limits: 125% of your busiest *earlier* day / 7-day stretch in the last 4 weeks
    // (today is excluded, otherwise a record day would always read 100%).
    let busiestDay = 0
    for (const [date, n] of perDay) if (date !== today) busiestDay = Math.max(busiestDay, n)
    let busiestWeek = 0
    for (let i = 1; i < 22; i++) {
      let sum = 0
      for (let k = 0; k < 7; k++) sum += perDay.get(localDate(Date.now() - (i + k) * 86_400_000)) ?? 0
      busiestWeek = Math.max(busiestWeek, sum)
    }
    const dailyLimit = d.daily > 0 ? d.daily : Math.max(200_000, Math.round(busiestDay * 1.25))
    const weeklyLimit = d.weekly > 0 ? d.weekly : Math.max(1_000_000, Math.round(busiestWeek * 1.25), Math.round(dailyLimit * 3))
    const pct = (u: number, l: number) => Math.min(100, Math.round((u / l) * 100))

    let inner: UsageRing = { label: 'Today', pct: pct(usedToday, dailyLimit), used: usedToday, limit: dailyLimit, resetsAt: tomorrow }
    let outer: UsageRing = { label: 'Week', pct: pct(usedWeek, weeklyLimit), used: usedWeek, limit: weeklyLimit, resetsAt: nextWeek }
    if (reported?.primary?.used_percent !== undefined) {
      const w = reported.primary
      const hours = Math.round((w.window_minutes ?? 300) / 60)
      inner = { label: `${hours}h limit`, pct: Math.round(w.used_percent!), used: null, limit: null, resetsAt: codexResetAt(w, reported.at) }
    }
    if (reported?.secondary?.used_percent !== undefined) {
      const w = reported.secondary
      outer = { label: 'Weekly limit', pct: Math.round(w.used_percent!), used: null, limit: null, resetsAt: codexResetAt(w, reported.at) }
    }
    out.push({ id: d.id, label: d.label, color: d.color, inner, outer, reported: !!reported })
  }
  // ---- Antigravity: only show ring if real logs were found ----
  const antigravityLogs = await scanAntigravityRows(28)
  if (antigravityLogs.length > 0) {
    const d = { id: 'antigravity' as const, source: 'Antigravity' as Source, label: 'Antigravity', color: '#bf5af2', daily: cfg.antigravityDaily, weekly: cfg.antigravityWeekly }
    const perDay = new Map<string, number>()
    for (const r of antigravityLogs) perDay.set(r.date, (perDay.get(r.date) ?? 0) + r.input + r.output + r.cacheWrite)
    if (perDay.size > 0) {
      const usedToday = perDay.get(today) ?? 0
      let usedWeek = 0
      for (const [date, n] of perDay) if (date >= weekStartDate) usedWeek += n
      let busiestDay = 0
      for (const [date, n] of perDay) if (date !== today) busiestDay = Math.max(busiestDay, n)
      let busiestWeek = 0
      for (let i = 1; i < 22; i++) {
        let sum = 0
        for (let k = 0; k < 7; k++) sum += perDay.get(localDate(Date.now() - (i + k) * 86_400_000)) ?? 0
        busiestWeek = Math.max(busiestWeek, sum)
      }
      const dailyLimit = d.daily > 0 ? d.daily : Math.max(200_000, Math.round(busiestDay * 1.25))
      const weeklyLimit = d.weekly > 0 ? d.weekly : Math.max(1_000_000, Math.round(busiestWeek * 1.25), Math.round(dailyLimit * 3))
      const pct = (u: number, l: number) => Math.min(100, Math.round((u / l) * 100))
      out.push({
        id: 'antigravity',
        label: 'Antigravity',
        color: d.color,
        inner: { label: 'Today', pct: pct(usedToday, dailyLimit), used: usedToday, limit: dailyLimit, resetsAt: tomorrow },
        outer: { label: 'Week', pct: pct(usedWeek, weeklyLimit), used: usedWeek, limit: weeklyLimit, resetsAt: nextWeek },
        reported: false
      })
    }
  }

  return out
}

// ---- Running AI processes ----

const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match '^(claude|codex|gemini|antigravity|cursor|windsurf|kiro|ollama|ollama app|lm studio|chatgpt|node|language_server_windows_x64)\\.exe$' } |
  ForEach-Object { [pscustomobject]@{ n=$_.Name; p=$_.ProcessId; c=[string]$_.CommandLine; e=[string]$_.ExecutablePath; w=$_.WorkingSetSize; t=($_.KernelModeTime + $_.UserModeTime) } } |
  ConvertTo-Json -Compress
`

function classify(name: string, cmd: string, exe: string): string | null {
  const n = name.toLowerCase()
  const c = cmd.toLowerCase()
  const e = exe.toLowerCase()
  if (n === 'claude.exe') return e.includes('anthropicclaude') || e.includes('windowsapps') ? 'Claude Desktop' : 'Claude Code'
  if (n === 'codex.exe') return 'Codex CLI'
  if (n === 'gemini.exe') return 'Gemini CLI'
  if (n === 'antigravity.exe' || (n === 'language_server_windows_x64.exe' && e.includes('antigravity'))) return 'Antigravity'
  if (n === 'cursor.exe') return 'Cursor'
  if (n === 'windsurf.exe') return 'Windsurf'
  if (n === 'kiro.exe') return 'Kiro'
  if (n === 'ollama.exe' || n === 'ollama app.exe') return 'Ollama'
  if (n === 'lm studio.exe') return 'LM Studio'
  if (n === 'chatgpt.exe') return 'ChatGPT'
  if (n === 'node.exe') {
    if (c.includes('claude-code') || c.includes('@anthropic-ai')) return 'Claude Code'
    if (c.includes('@openai/codex')) return 'Codex CLI'
    if (c.includes('gemini-cli')) return 'Gemini CLI'
  }
  return null
}

let prevCpu = new Map<number, number>()
let prevAt = 0

export function listAiProcesses(): Promise<AiProcess[]> {
  return new Promise(res => {
    // Native helper: no PowerShell started every few seconds while the Usage tab is open.
    const query = (cb: (err: Error | null, out: string) => void) =>
      winHelper.isNative
        ? winHelper.procs().then(out => cb(null, out), e => cb(e as Error, ''))
        : execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
            { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
            (err, out) => cb(err, out)
          )
    query(
      (err, out) => {
        if (err || !out.trim()) return res([])
        let list: any[]
        try {
          const j = JSON.parse(out)
          list = Array.isArray(j) ? j : [j]
        } catch {
          return res([])
        }
        const now = Date.now()
        const elapsed = prevAt ? (now - prevAt) / 1000 : 0
        const cores = cpus().length || 1
        const nextCpu = new Map<number, number>()
        const groups = new Map<string, AiProcess>()
        for (const p of list) {
          const kind = classify(p.n ?? '', p.c ?? '', p.e ?? '')
          if (!kind) continue
          const cpuSec = (Number(p.t) || 0) / 1e7
          nextCpu.set(p.p, cpuSec)
          const before = prevCpu.get(p.p)
          const pct = elapsed && before !== undefined ? Math.max(0, ((cpuSec - before) / elapsed / cores) * 100) : 0
          const g = groups.get(kind) ?? { kind, name: kind, pid: p.p, count: 0, memoryMb: 0, cpuPercent: 0 }
          g.count += 1
          g.memoryMb += (Number(p.w) || 0) / 1024 / 1024
          g.cpuPercent += pct
          groups.set(kind, g)
        }
        prevCpu = nextCpu
        prevAt = now
        res(
          [...groups.values()]
            .map(g => ({ ...g, memoryMb: Math.round(g.memoryMb), cpuPercent: Math.round(g.cpuPercent * 10) / 10 }))
            .sort((a, b) => b.memoryMb - a.memoryMb)
        )
      }
    )
  })
}

// ---- Antigravity log parsing ----

/**
 * Try to parse Antigravity/Gemini token usage from log files.
 * Antigravity may store usage data in various formats — we try several known patterns.
 * If no parseable logs are found, returns an empty array (no ring will be shown).
 */
async function parseAntigravityFile(path: string, since: number): Promise<Row[]> {
  const map = new Map<string, Row>()
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line || line.length > 2_000_000) continue
    // Skip lines that clearly don't contain usage data
    if (!line.includes('token') && !line.includes('usage') && !line.includes('model')) continue
    let j: any
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    // Try multiple possible log formats
    const ts = j.timestamp || j.ts || j.created_at || j.time
    if (!ts) continue
    const tsMs = typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : Date.parse(String(ts))
    if (isNaN(tsMs) || tsMs < since) continue
    // Format 1: { usage: { input_tokens, output_tokens } }
    const u = j.usage || j.token_usage || j.tokens
    if (u && (u.input_tokens !== undefined || u.output_tokens !== undefined || u.total_tokens !== undefined)) {
      addRow(map, {
        date: localDate(tsMs),
        source: 'Antigravity',
        model: j.model || j.message?.model || 'unknown',
        input: u.input_tokens ?? u.prompt_tokens ?? 0,
        output: u.output_tokens ?? u.completion_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? u.cached_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0
      })
      continue
    }
    // Format 2: flat { input_tokens, output_tokens } at top level
    if (j.input_tokens !== undefined || j.output_tokens !== undefined) {
      addRow(map, {
        date: localDate(tsMs),
        source: 'Antigravity',
        model: j.model || 'unknown',
        input: j.input_tokens ?? 0,
        output: j.output_tokens ?? 0,
        cacheRead: j.cache_read_input_tokens ?? 0,
        cacheWrite: j.cache_creation_input_tokens ?? 0
      })
    }
  }
  return [...map.values()]
}

async function scanAntigravityRows(days: number): Promise<Row[]> {
  const since = Date.now() - days * 86_400_000
  const roots = [
    join(homedir(), '.gemini', 'logs'),
    join(homedir(), '.gemini', 'usage'),
    join(homedir(), '.gemini', 'sessions'),
    join(process.env.APPDATA ?? '', 'Antigravity', 'logs'),
    join(process.env.APPDATA ?? '', 'Antigravity', 'usage'),
    join(process.env.APPDATA ?? '', 'Antigravity IDE', 'logs'),
    join(process.env.LOCALAPPDATA ?? '', 'antigravity', 'logs'),
    join(process.env.LOCALAPPDATA ?? '', 'antigravity', 'usage')
  ].filter(Boolean)
  const files: string[] = []
  for (const r of new Set(roots)) walk(r, 3, since, files, ['.jsonl', '.json', '.log'])
  const rows: Row[] = []
  for (const f of files) rows.push(...(await parseAntigravityFile(f, since).catch(() => [])))
  return rows
}

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { AgentMode, AgentRun, ProviderId, ProviderStatus, RunRequest, Settings, TokenUsage } from '@shared/types'

const PROVIDERS: Record<ProviderId, { label: string; bin: string[]; headless: boolean; models: string[] }> = {
  claude: {
    label: 'Claude Code',
    bin: ['claude'],
    headless: true,
    models: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'opus', 'sonnet', 'haiku']
  },
  codex: { label: 'Codex CLI', bin: ['codex'], headless: true, models: ['gpt-5-codex', 'gpt-5', 'gpt-5-mini'] },
  gemini: { label: 'Gemini CLI', bin: ['gemini'], headless: true, models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  antigravity: {
    label: 'Antigravity CLI',
    bin: ['agy', 'antigravity', 'antigravity-cli'],
    headless: true,
    models: [
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.1-pro',
      'claude-sonnet-4.6',
      'claude-opus-4.6',
      'gpt-oss-120b'
    ]
  },
  custom: { label: 'Custom CLI', bin: [], headless: true, models: [] }
}

export function sanitizeAntigravityModel(model?: string): { modelName: string; effort?: string } {
  const m = (model || '').trim().toLowerCase()
  if (!m || m === 'haiku' || m === 'default' || m === 'cheap' || m.startsWith('claude-3') || m.startsWith('gpt-4')) {
    return { modelName: 'gemini-3.8-flash', effort: 'high' }
  }
  if (m.includes('3.8') || m.includes('gemini-3.8-flash')) {
    return { modelName: 'gemini-3.8-flash', effort: 'high' }
  }
  if (m.includes('3.7') || m.includes('gemini-3.7-flash')) {
    return { modelName: 'gemini-3.7-flash', effort: 'high' }
  }
  if (m.includes('3.6') || m.includes('gemini-3.6-flash')) {
    return { modelName: 'gemini-3.6-flash', effort: 'high' }
  }
  if (m.includes('3.1') || m.includes('gemini-3.1-pro')) {
    return { modelName: 'gemini-3.1-pro', effort: 'high' }
  }
  if (m.includes('claude-sonnet-4') || m.includes('sonnet-4.6')) {
    return { modelName: 'claude-sonnet-4.6' }
  }
  if (m.includes('claude-opus-4') || m.includes('opus-4.6')) {
    return { modelName: 'claude-opus-4.6' }
  }
  if (m.includes('gpt-oss')) {
    return { modelName: 'gpt-oss-120b' }
  }
  return { modelName: model!.trim() }
}

const MAX_RUN_MS = 15 * 60_000
const MAX_OUTPUT = 400_000
/** Characters that could break out of cmd.exe quoting when a .cmd shim must be used. */
const UNSAFE_CMD_CHARS = /["%^&|<>!\r\n`]/
const SAFE_MODEL = /^[\w.:\-/@[\]]{0,80}$/

const READONLY_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git branch:*)'
]

/** Never let a task reach the network from the shell (data exfiltration). */
const NETWORK_DENY = [
  'WebFetch',
  'WebSearch',
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(Invoke-WebRequest:*)',
  'Bash(Invoke-RestMethod:*)',
  'Bash(iwr:*)',
  'Bash(irm:*)',
  'Bash(ssh:*)',
  'Bash(scp:*)',
  'Bash(git push:*)'
]

function searchPath(): string {
  const h = homedir()
  const extra = [
    join(process.env.APPDATA ?? '', 'npm'),
    join(h, '.local', 'bin'),
    join(h, '.bun', 'bin'),
    join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin'),
    join(h, '.gemini', 'antigravity-cli', 'bin'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Antigravity', 'bin'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Antigravity'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Antigravity IDE', 'bin'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links')
  ]
  return [process.env.PATH ?? '', ...extra].join(';')
}

function where(name: string): Promise<string | null> {
  return new Promise(res => {
    execFile('where.exe', [name], { env: { ...process.env, PATH: searchPath() }, timeout: 5000, windowsHide: true }, (err, out) => {
      if (err) return res(null)
      const hits = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      // Prefer real executables, then npm shims.
      res(hits.find(h => /\.exe$/i.test(h)) ?? hits.find(h => /\.(cmd|bat)$/i.test(h)) ?? null)
    })
  })
}

const IDE_DIRS = ['.vscode', '.antigravity', '.antigravity-ide', '.cursor', '.windsurf', '.vscode-insiders']

/** Newest matching binary inside ~/.<ide>/extensions/<prefix>*<rel>. */
function findInExtensions(prefix: string, rel: string[]): string | null {
  let best: { path: string; mtime: number } | null = null
  for (const ide of IDE_DIRS) {
    const dir = join(homedir(), ide, 'extensions')
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue
      const p = join(dir, name, ...rel)
      if (!existsSync(p)) continue
      const mtime = statSync(p).mtimeMs
      if (!best || mtime > best.mtime) best = { path: p, mtime }
    }
  }
  return best?.path ?? null
}

/** Spawn without ever handing user text to a shell. .cmd shims need cmd.exe, so their args are validated first. */
export function spawnSafe(cmd: string, args: string[], cwd: string): ChildProcess {
  const env = { ...process.env, PATH: searchPath(), NO_COLOR: '1', FORCE_COLOR: '0' }
  if (/\.(cmd|bat)$/i.test(cmd)) {
    for (const a of [cmd, ...args]) {
      if (UNSAFE_CMD_CHARS.test(a)) throw new Error(`Refusing unsafe argument: ${a}`)
    }
    const line = [cmd, ...args].map(a => `"${a}"`).join(' ')
    return spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: true
    })
  }
  return spawn(cmd, args, { cwd, env, windowsHide: true, shell: false })
}

export function killTree(pid: number | undefined): void {
  if (!pid) return
  execFile('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
}

export function isInsideWorkspace(path: string, workspaces: string[]): boolean {
  const p = resolve(path).toLowerCase()
  return workspaces.some(w => {
    const r = resolve(w).toLowerCase()
    return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)
  })
}

export class AgentManager {
  runs: AgentRun[] = []
  providers: ProviderStatus[] = []
  private procs = new Map<string, ChildProcess>()
  /** Private scratch folder used as the working directory for General (non-coding) questions. */
  assistantDir = ''
  /** Whether the installed Claude Code supports --restricted (ignores user/project settings, confines tools). */
  private claudeRestricted = false

  constructor(
    private getSettings: () => Settings,
    private onChange: () => void,
    private onOutput: (id: string, chunk: string) => void,
    private onFinish: (run: AgentRun) => void,
    private log: (kind: string, detail: string) => void
  ) {}

  async detect(): Promise<ProviderStatus[]> {
    const s = this.getSettings()
    // Probe every CLI in parallel — some (npm shims) take seconds to answer --version.
    const probe = async (id: ProviderId): Promise<ProviderStatus> => {
      const def = PROVIDERS[id]
      const override = s.providers[id].command.trim()
      let path: string | null = null
      if (override) path = existsSync(override) ? override : await where(override)
      else for (const b of def.bin) if (!path) path = await where(b)
      if (!path && id === 'antigravity') {
        const agyBin = join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe')
        if (existsSync(agyBin)) {
          path = agyBin
        } else {
          const programs = join(process.env.LOCALAPPDATA ?? '', 'Programs')
          path = [
            join(programs, 'Antigravity', 'bin', 'agy.exe'),
            join(programs, 'Antigravity', 'Antigravity.exe'),
            join(programs, 'Antigravity IDE', 'Antigravity IDE.exe')
          ].find(existsSync) ?? null
        }
      }
      // Agents bundled inside IDE extensions (VS Code, Antigravity, Cursor, Windsurf).
      if (!path && id === 'claude') path = findInExtensions('anthropic.claude-code-', ['resources', 'native-binary', 'claude.exe'])
      if (!path && id === 'codex') path = findInExtensions('openai.chatgpt-', ['bin', 'windows-x86_64', 'codex.exe'])
      const [versionOut, helpOut] = await Promise.all([
        path && def.headless ? this.quick(path, ['--version']) : null,
        path && id === 'claude' ? this.quick(path, ['--help']) : null
      ])
      if (id === 'claude') this.claudeRestricted = !!helpOut?.includes('--restricted')
      return {
        id,
        label: id === 'custom' ? s.providers.custom.label || def.label : def.label,
        installed: !!path,
        path,
        version: versionOut?.split(/\r?\n/)[0]?.slice(0, 60) || null,
        headless: def.headless,
        modelSuggestions: def.models
      }
    }
    this.providers = await Promise.all((Object.keys(PROVIDERS) as ProviderId[]).map(probe))
    return this.providers
  }

  private quick(path: string, args: string[]): Promise<string | null> {
    return new Promise(res => {
      try {
        const p = spawnSafe(path, args, homedir())
        let buf = ''
        const t = setTimeout(() => {
          killTree(p.pid)
          res(null)
        }, 8000)
        p.stdout?.on('data', d => (buf += d))
        p.on('close', () => {
          clearTimeout(t)
          res(buf.trim() || null)
        })
        p.on('error', () => res(null))
      } catch {
        res(null)
      }
    })
  }

  get activeCount(): number {
    return this.procs.size
  }

  /** Agent that answers General questions: the chosen one, else the active one if it can run headless, else the first installed. */
  assistantProvider(): ProviderId | null {
    const s = this.getSettings()
    const ok = (id: ProviderId) => {
      const p = this.providers.find(x => x.id === id)
      return !!p?.installed && p.headless && s.providers[id].enabled
    }
    if (s.assistant.provider !== 'auto' && ok(s.assistant.provider)) return s.assistant.provider
    if (ok(s.activeProvider)) return s.activeProvider
    return (['claude', 'codex', 'gemini', 'antigravity', 'custom'] as ProviderId[]).find(ok) ?? null
  }

  /**
   * A small, cheap, tool-less call for background checks (screen insights, commit review).
   * Not shown as a task; no tools, no settings, no MCP, tiny system prompt — about 1k tokens per call with Claude.
   */
  quickAsk(system: string, prompt: string, model: string): Promise<{ text: string; tokens: number; cost: number }> {
    const id = this.assistantProvider()
    const status = this.providers.find(p => p.id === id)
    if (!id || !status?.path) return Promise.reject(new Error('No background agent available.'))
    if (!SAFE_MODEL.test(model)) return Promise.reject(new Error('Invalid model id.'))
    let args: string[]
    let input = prompt
    if (id === 'claude') {
      // System prompt goes through a file: works for .cmd shims too (no quotes on the command line).
      const sysFile = join(this.assistantDir, `system-${createHash('sha1').update(system).digest('hex').slice(0, 10)}.txt`)
      if (!existsSync(sysFile)) writeFileSync(sysFile, system, 'utf8')
      args = ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', 'local', '--system-prompt-file', sysFile]
      if (model) args.push('--model', model)
    } else if (id === 'codex') {
      args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', ...(model ? ['-m', model] : []), '-']
      input = `${system}\n\n${prompt}`
    } else if (id === 'gemini') {
      args = ['--approval-mode', 'default', ...(model ? ['-m', model] : [])]
      input = `${system}\n\n${prompt}`
    } else if (id === 'antigravity') {
      args = []
      const agy = sanitizeAntigravityModel(model)
      if (agy.modelName) {
        args.push('--model', agy.modelName)
        if (agy.effort) args.push('--effort', agy.effort)
      }
      args.push('--print', `${system}\n\n${prompt}`)
      input = ''
    } else {
      args = this.getSettings().providers.custom.args.map(x => x.replaceAll('{model}', model))
      input = `${system}\n\n${prompt}`
    }
    return new Promise((res, rej) => {
      let child: ChildProcess
      try {
        child = spawnSafe(status.path!, args, this.assistantDir)
      } catch (e) {
        return rej(e)
      }
      this.procs.set(`quick-${Date.now()}`, child)
      let out = ''
      let errOut = ''
      const timer = setTimeout(() => {
        killTree(child.pid)
        rej(new Error('Background check timed out.'))
      }, 90_000)
      child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')))
      child.stderr?.on('data', (d: Buffer) => (errOut += d.toString('utf8')))
      child.on('error', e => rej(e))
      child.on('close', code => {
        clearTimeout(timer)
        for (const [k, v] of this.procs) if (v === child) this.procs.delete(k)
        if (code !== 0 && code !== null) {
          return rej(new Error(errOut.trim() || out.trim() || `Agent exited with code ${code}`))
        }
        if (id === 'claude') {
          try {
            const j = JSON.parse(out.trim().split(/\r?\n/).pop() ?? '{}')
            const u = j.usage ?? {}
            res({
              text: String(j.result ?? ''),
              tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              cost: j.total_cost_usd ?? 0
            })
          } catch {
            rej(new Error('Could not read the agent reply.'))
          }
        } else if (id === 'codex') {
          const texts: string[] = []
          let tokens = 0
          for (const l of out.split(/\r?\n/)) {
            try {
              const j = JSON.parse(l)
              if (j.type === 'item.completed' && j.item?.type === 'agent_message') texts.push(j.item.text)
              if (j.type === 'turn.completed' && j.usage) tokens = (j.usage.input_tokens ?? 0) + (j.usage.output_tokens ?? 0)
            } catch {
              /* not json */
            }
          }
          res({ text: texts.join('\n'), tokens, cost: 0 })
        } else res({ text: out, tokens: 0, cost: 0 })
      })
      child.stdin?.end(input + '\n')
    })
  }

  /**
   * Everyday text jobs (summarize, reply, translate) — shown as a normal task card, but run through the
   * lean tool-less call with the cheap background model (~1k tokens instead of a full agent session).
   * The user clicked for it, so no approval card; it can't read files, run commands or reach the web.
   */
  liteRun(title: string, system: string, prompt: string, model: string, locked: boolean): AgentRun {
    if (locked) throw new Error('Kill switch is engaged. Resume the island first.')
    const provider = this.assistantProvider()
    if (!provider) throw new Error('No background-capable agent found. Install or sign in to Claude Code, Codex CLI or Gemini CLI.')
    let effectiveModel = model || this.getSettings().providers[provider].model
    if (provider === 'antigravity') {
      effectiveModel = sanitizeAntigravityModel(effectiveModel).modelName
    }
    const run: AgentRun = {
      id: randomUUID(),
      provider,
      model: effectiveModel,
      mode: 'readonly',
      workspace: this.assistantDir,
      prompt,
      title: title.slice(0, 80),
      status: 'running',
      output: '',
      startedAt: Date.now(),
      context: 'general',
      allowWeb: false,
      hasMail: false
    }
    this.runs.unshift(run)
    this.runs = this.runs.slice(0, 30)
    this.log('run.lite', run.title)
    this.onChange()
    this.quickAsk(system, prompt, effectiveModel)
      .then(r => {
        run.output = r.text.trim() || '(no answer)'
        run.usage = { input: r.tokens, output: 0, cacheRead: 0, cacheWrite: 0 }
        run.costUsd = r.cost
        if (run.status === 'running') run.status = 'done'
      })
      .catch(e => {
        run.output = String((e as Error).message)
        if (run.status === 'running') run.status = 'error'
      })
      .finally(() => {
        run.endedAt = Date.now()
        this.onOutput(run.id, '')
        this.onFinish(run)
        this.onChange()
      })
    return run
  }

  /**
   * Queue a task for approval. `opts` is only ever set by the main process (never from the renderer):
   * the fully composed prompt (e.g. with redacted mail attached) and whether web access is allowed.
   */
  request(req: RunRequest, locked: boolean, opts: { prompt?: string; allowWeb?: boolean; hasMail?: boolean } = {}): AgentRun {
    const s = this.getSettings()
    if (locked) throw new Error('Kill switch is engaged. Resume the island first.')
    const context = req.context === 'general' ? 'general' : 'project'
    let provider: ProviderId
    let workspace: string
    if (context === 'general') {
      const p = this.assistantProvider()
      if (!p) throw new Error('No background-capable agent found. Install Claude Code, Codex CLI or Gemini CLI (Antigravity only works inside its IDE).')
      provider = p
      workspace = this.assistantDir
    } else {
      provider = req.provider ?? s.activeProvider
      if (!s.activeWorkspace || !isInsideWorkspace(s.activeWorkspace, s.workspaces)) {
        throw new Error('Pick an allowlisted workspace first (Settings → Workspaces), or switch the composer to General.')
      }
      workspace = s.activeWorkspace
    }
    const cfg = s.providers[provider]
    if (!cfg.enabled) throw new Error(`${PROVIDERS[provider].label} is disabled in settings.`)
    const prompt = String(opts.prompt ?? req.prompt ?? '').slice(0, 60_000).trim()
    if (!prompt) throw new Error('Prompt is empty.')
    const run: AgentRun = {
      id: randomUUID(),
      provider,
      model: cfg.model,
      // General questions are always read-only.
      mode: context === 'general' ? 'readonly' : (req.mode ?? cfg.mode),
      workspace,
      prompt,
      title: (req.title ?? req.prompt ?? prompt).slice(0, 80),
      status: 'pending-approval',
      output: '',
      startedAt: Date.now(),
      context,
      allowWeb: !!opts.allowWeb && !opts.hasMail,
      hasMail: !!opts.hasMail
    }
    this.runs.unshift(run)
    this.runs = this.runs.slice(0, 30)
    this.log('run.requested', `${run.title} [${provider}/${run.model || 'default'}/${run.mode}]`)
    this.onChange()
    return run
  }

  reject(id: string): void {
    const run = this.runs.find(r => r.id === id)
    if (!run || run.status !== 'pending-approval') return
    run.status = 'rejected'
    run.endedAt = Date.now()
    this.log('run.rejected', run.title)
    this.onChange()
  }

  approve(id: string, locked: boolean): void {
    const run = this.runs.find(r => r.id === id)
    if (!run || run.status !== 'pending-approval') return
    if (locked) throw new Error('Kill switch is engaged.')
    const s = this.getSettings()
    if (!isInsideWorkspace(run.workspace, [...s.workspaces, this.assistantDir])) throw new Error('Workspace is no longer allowlisted.')
    const status = this.providers.find(p => p.id === run.provider)
    if (!status?.path) throw new Error(`${PROVIDERS[run.provider].label} was not found on this PC.`)
    if (!status.headless) throw new Error('This provider cannot run headless. Use "Open in Antigravity".')
    if (!SAFE_MODEL.test(run.model)) throw new Error('Model id contains invalid characters.')

    const args = this.buildArgs(run.provider, run.model, run.mode, run.allowWeb, run.prompt)
    this.log('run.approved', `${run.title} → ${status.path} ${args.join(' ')} (cwd ${run.workspace})`)
    run.status = 'running'
    run.startedAt = Date.now()

    let child: ChildProcess
    try {
      child = spawnSafe(status.path, args, run.workspace)
    } catch (e) {
      run.status = 'error'
      run.output = String((e as Error).message)
      this.onChange()
      return
    }
    this.procs.set(run.id, child)
    if (run.provider !== 'antigravity') {
      child.stdin?.end(run.prompt + '\n')
    }

    let lineBuf = ''
    const append = (text: string) => {
      if (!text) return
      if (run.output.length < MAX_OUTPUT) run.output += text
      this.onOutput(run.id, text)
    }
    child.stdout?.on('data', (d: Buffer) => {
      lineBuf += d.toString('utf8')
      const lines = lineBuf.split(/\r?\n/)
      lineBuf = lines.pop() ?? ''
      for (const l of lines) append(this.parseLine(run, l))
    })
    child.stderr?.on('data', (d: Buffer) => {
      const t = d.toString('utf8')
      append(`⚠ ${t}`)
    })
    const timer = setTimeout(() => this.cancel(run.id, 'timeout'), MAX_RUN_MS)
    child.on('error', err => append(`\n⚠ ${err.message}\n`))
    child.on('close', code => {
      clearTimeout(timer)
      if (lineBuf) append(this.parseLine(run, lineBuf))
      this.procs.delete(run.id)
      if (run.status === 'running') run.status = code === 0 ? 'done' : 'error'
      if (run.status === 'error' && !run.output.trim()) run.output = `Exited with code ${code}.`
      const hint = signInHint(run.provider, run.output)
      if (run.status === 'error' && hint) append(`\n💡 ${hint}\n`)
      run.endedAt = Date.now()
      this.log(`run.${run.status}`, `${run.title} (exit ${code})`)
      this.onFinish(run)
      this.onChange()
    })
    this.onChange()
  }

  private buildArgs(provider: ProviderId, model: string, mode: AgentMode, allowWeb: boolean, prompt?: string): string[] {
    const s = this.getSettings()
    switch (provider) {
      case 'claude': {
        const a = ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config']
        if (model) a.push('--model', model)
        const edit = mode === 'edit' ? ['Edit', 'Write'] : []
        // Web tools only for General questions without mail attached (no private data that could leak).
        const web = allowWeb ? ['WebSearch', 'WebFetch'] : []
        const deny = NETWORK_DENY.filter(t => !web.includes(t))
        if (this.claudeRestricted) {
          // Restricted mode ignores the user's own allow rules, so only the tools named here exist,
          // and Bash is limited to read-only git commands via --allowedTools (anything else is denied in -p).
          a.push('--restricted', '--tools', ['Read', 'Grep', 'Glob', 'Bash', ...edit, ...web].join(','))
          a.push('--allowedTools', [...READONLY_TOOLS, ...edit, ...web].join(','))
          a.push('--disallowedTools', deny.join(','))
        } else {
          // Older CLI: no shell tool at all, and skip user/project settings that could widen permissions.
          a.push('--setting-sources', 'local', '--tools', ['Read', 'Grep', 'Glob', ...edit, ...web].join(','))
          a.push('--disallowedTools', ['Bash', 'PowerShell', ...deny.filter(t => !t.startsWith('Bash('))].join(','))
        }
        a.push('--permission-mode', mode === 'edit' ? 'acceptEdits' : 'default')
        // When web approval is required, web tools are still listed (allowed) but the run
        // will always go through the approval card (handled in request/queueRun).
        return a
      }
      case 'codex': {
        const a = ['exec', '--json', '--skip-git-repo-check', '--sandbox', mode === 'edit' ? 'workspace-write' : 'read-only']
        if (model) a.push('-m', model)
        a.push('-')
        return a
      }
      case 'gemini': {
        const a = ['--approval-mode', mode === 'edit' ? 'auto_edit' : 'default']
        if (model) a.push('-m', model)
        return a
      }
      case 'antigravity': {
        const a: string[] = []
        const agy = sanitizeAntigravityModel(model)
        if (agy.modelName) {
          a.push('--model', agy.modelName)
          if (agy.effort) {
            a.push('--effort', agy.effort)
          }
        }
        if (mode === 'edit') {
          a.push('--mode', 'accept-edits', '--dangerously-skip-permissions')
        } else {
          a.push('--mode', 'plan')
        }
        a.push('--print', prompt || '')
        return a
      }
      case 'custom':
        return s.providers.custom.args.map(x => x.replaceAll('{model}', model))
      default:
        return []
    }
  }

  /** Turn one line of CLI output into readable text, collecting token usage where the CLI reports it. */
  private parseLine(run: AgentRun, line: string): string {
    const t = line.trim()
    if (!t) return ''
    if (run.provider !== 'claude' && run.provider !== 'codex') return line + '\n'
    let j: any
    try {
      j = JSON.parse(t)
    } catch {
      return line + '\n'
    }
    if (run.provider === 'claude') {
      if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
        return j.message.content
          .map((c: any) => {
            if (c.type === 'text') return c.text + '\n'
            if (c.type === 'tool_use') return `▸ ${c.name} ${summarize(c.input)}\n`
            return ''
          })
          .join('')
      }
      if (j.type === 'result') {
        run.usage = toUsage(j.usage)
        if (typeof j.total_cost_usd === 'number') run.costUsd = j.total_cost_usd
        if (j.is_error) run.status = 'error'
        return ''
      }
      return ''
    }
    // codex exec --json
    if (j.type === 'item.completed' && j.item) {
      if (j.item.type === 'agent_message') return (j.item.text ?? '') + '\n'
      if (j.item.type === 'command_execution') return `▸ ${j.item.command ?? 'command'}\n`
      if (j.item.type === 'file_change') return `▸ edited files\n`
      return ''
    }
    if (j.type === 'turn.completed' && j.usage) {
      run.usage = {
        input: j.usage.input_tokens ?? 0,
        output: j.usage.output_tokens ?? 0,
        cacheRead: j.usage.cached_input_tokens ?? 0,
        cacheWrite: 0
      }
      return ''
    }
    if (j.type === 'error' || j.type === 'turn.failed') return `⚠ ${j.message ?? j.error?.message ?? 'error'}\n`
    return ''
  }

  cancel(id: string, reason = 'cancelled'): void {
    const run = this.runs.find(r => r.id === id)
    const p = this.procs.get(id)
    if (p) killTree(p.pid)
    if (run && (run.status === 'running' || run.status === 'pending-approval')) {
      run.status = 'killed'
      run.endedAt = Date.now()
      this.log('run.killed', `${run.title} (${reason})`)
    }
    this.onChange()
  }

  killAll(reason: string): number {
    const n = this.procs.size
    for (const id of [...this.procs.keys()]) this.cancel(id, reason)
    for (const r of this.runs) if (r.status === 'pending-approval') this.cancel(r.id, reason)
    return n
  }

  clearFinished(): void {
    this.runs = this.runs.filter(r => r.status === 'running' || r.status === 'pending-approval')
    this.onChange()
  }

  /** Antigravity is an IDE: open the workspace in it. The caller copies the prompt to the clipboard. */
  openAntigravity(workspace: string): { ok: boolean; message: string } {
    const status = this.providers.find(p => p.id === 'antigravity')
    if (!status?.path) return { ok: false, message: 'Antigravity was not found on this PC.' }
    try {
      const child = spawnSafe(status.path, [workspace], workspace)
      child.unref()
      this.log('antigravity.open', workspace)
      return { ok: true, message: 'Opened in Antigravity — prompt copied, paste it into the agent panel.' }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }
}

/** Turn "not signed in" failures into one clear instruction. */
function signInHint(provider: ProviderId, output: string): string | null {
  if (!/auth method|not logged in|please run \/login|please sign in|sign in|login required|unauthori[sz]ed|api key|GEMINI_API_KEY|OPENAI_API_KEY|401/i.test(output)) return null
  switch (provider) {
    case 'gemini':
      return 'Gemini CLI is not signed in. Open a terminal, run "gemini" once and choose "Login with Google" — then ask again.'
    case 'claude':
      return 'Claude Code is not signed in. Open a terminal, run "claude" and use /login — then ask again.'
    case 'codex':
      return 'Codex CLI is not signed in. Open a terminal and run "codex login" — then ask again.'
    case 'antigravity':
      return 'Antigravity CLI is not signed in. Open a terminal, run "agy" to sign in — then ask again.'
    default:
      return 'This agent is not signed in. Run it once in a terminal to sign in, then ask again.'
  }
}

function toUsage(u: any): TokenUsage | undefined {
  if (!u) return undefined
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0
  }
}

function summarize(input: any): string {
  if (!input) return ''
  const v = input.file_path ?? input.path ?? input.pattern ?? input.command ?? ''
  return String(v).slice(0, 90)
}

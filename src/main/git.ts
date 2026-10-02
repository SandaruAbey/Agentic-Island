import { execFile } from 'node:child_process'
import type { GitCommit, GitFile, GitState } from '@shared/types'

function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((res, rej) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => (err ? rej(new Error((stderr || err.message).trim())) : res(stdout))
    )
  })
}

export async function readGitState(workspace: string): Promise<GitState> {
  const base: GitState = {
    workspace,
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicted: 0,
    files: [],
    commits: [],
    lastCommitAt: null,
    updatedAt: Date.now()
  }
  try {
    const status = await git(workspace, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'])
    base.isRepo = true
    const files: GitFile[] = []
    for (const line of status.split('\n')) {
      if (line.startsWith('# branch.head ')) base.branch = line.slice(14).trim()
      else if (line.startsWith('# branch.upstream ')) base.upstream = line.slice(18).trim()
      else if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+) -(\d+)/)
        if (m) {
          base.ahead = +m[1]
          base.behind = +m[2]
        }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const parts = line.split(' ')
        const xy = parts[1]
        const path = line.startsWith('2 ') ? parts.slice(9).join(' ').split('\t')[0] : parts.slice(8).join(' ')
        if (xy[0] !== '.') base.staged++
        if (xy[1] !== '.') base.modified++
        files.push({ path, code: xy })
      } else if (line.startsWith('u ')) {
        base.conflicted++
        files.push({ path: line.split(' ').slice(10).join(' '), code: 'UU' })
      } else if (line.startsWith('? ')) {
        base.untracked++
        files.push({ path: line.slice(2), code: '??' })
      }
    }
    base.files = files.slice(0, 200)

    const log = await git(workspace, ['log', '-6', '--pretty=format:%h%x1f%s%x1f%an%x1f%cr%x1f%ct']).catch(() => '')
    base.commits = log
      .split('\n')
      .filter(Boolean)
      .map(l => {
        const [hash, subject, author, relative] = l.split('\x1f')
        return { hash, subject, author, relative } as GitCommit
      })
    const firstTs = log.split('\n')[0]?.split('\x1f')[4]
    base.lastCommitAt = firstTs ? +firstTs * 1000 : null
  } catch (e) {
    const msg = (e as Error).message
    if (!/not a git repository/i.test(msg)) base.error = msg.slice(0, 200)
  }
  return base
}

export async function runGitOp(workspace: string, op: 'push' | 'pull' | 'fetch'): Promise<string> {
  const args = op === 'pull' ? ['pull', '--ff-only'] : op === 'push' ? ['push'] : ['fetch', '--prune']
  const out = await git(workspace, args, 120_000)
  return out.trim() || `git ${op} completed.`
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Private key', /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['OpenAI / Anthropic key', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe key', /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/],
  ['Hard-coded secret', /(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"'\s]{8,}["']/i]
]
const SECRET_FILES = /(^|[\\/])(\.env(\..+)?|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.pfx|credentials\.json|service-account.*\.json)$/i

export function scanSecrets(addedLines: string, files: string[]): string[] {
  const found = new Set<string>()
  for (const f of files) if (SECRET_FILES.test(f) && !/\.example$|\.sample$|\.template$/i.test(f)) found.add(`Sensitive file: ${f}`)
  for (const [label, re] of SECRET_PATTERNS) if (re.test(addedLines)) found.add(label)
  return [...found]
}

export interface ReviewDiff {
  hash: string
  files: string[]
  /** Diff text for review, truncated. */
  text: string
  /** Only the added lines (for the secret scan). */
  added: string
}

/** Everything that "git add -A && git commit" would include, without touching the index. */
export async function diffForReview(workspace: string, maxChars = 7000): Promise<ReviewDiff | null> {
  const tracked = await git(workspace, ['diff', 'HEAD', '--no-color', '--unified=2']).catch(() => git(workspace, ['diff', '--cached', '--no-color']).catch(() => ''))
  const untracked = (await git(workspace, ['ls-files', '--others', '--exclude-standard']).catch(() => '')).split('\n').filter(Boolean)
  const trackedFiles = (await git(workspace, ['diff', 'HEAD', '--name-only']).catch(() => '')).split('\n').filter(Boolean)
  const files = [...new Set([...trackedFiles, ...untracked])]
  if (!files.length) return null
  let text = tracked
  let added = tracked
    .split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n')
  const { readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  for (const f of untracked.slice(0, 30)) {
    try {
      const p = join(workspace, f)
      if (statSync(p).size > 100_000) continue
      const body = readFileSync(p, 'utf8')
      if (body.includes('\u0000')) continue // binary
      text += `\n--- new file: ${f}\n${body.slice(0, 1500)}`
      added += '\n' + body
    } catch {
      /* unreadable */
    }
  }
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256').update(files.join('\n') + '\n' + tracked + added).digest('hex').slice(0, 16)
  return { hash, files, text: text.length > maxChars ? text.slice(0, maxChars) + '\n…(truncated)' : text, added }
}

export async function commitAll(workspace: string, message: string, push: boolean, upstream: string | null): Promise<string> {
  await git(workspace, ['add', '-A'])
  const out = await git(workspace, ['commit', '-m', message])
  const first = out.split('\n')[0]
  if (!push) return first
  if (upstream) await git(workspace, ['push'], 120_000)
  else {
    const remotes = (await git(workspace, ['remote'])).split('\n').filter(Boolean)
    if (!remotes.length) return `${first} — committed. No remote configured, so nothing was pushed.`
    await git(workspace, ['push', '-u', remotes.includes('origin') ? 'origin' : remotes[0], 'HEAD'], 120_000)
  }
  return `${first} — pushed.`
}

export async function diffSummary(workspace: string): Promise<string> {
  const stat = await git(workspace, ['diff', 'HEAD', '--stat']).catch(() => '')
  return stat.slice(0, 4000)
}

export class GitWatcher {
  state: GitState | null = null
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private lastKey = ''

  constructor(
    private getWorkspace: () => string | null,
    private onChange: (s: GitState | null) => void
  ) {}

  start(): void {
    this.stop()
    void this.tick()
    this.timer = setInterval(() => void this.tick(), 8000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  get running(): boolean {
    return this.timer !== null
  }

  async tick(): Promise<void> {
    if (this.busy) return
    const ws = this.getWorkspace()
    if (!ws) {
      if (this.state) {
        this.state = null
        this.onChange(null)
      }
      return
    }
    this.busy = true
    try {
      const s = await readGitState(ws)
      const key = JSON.stringify({ ...s, updatedAt: 0, commits: s.commits.map(c => c.hash) })
      this.state = s
      if (key !== this.lastKey) {
        this.lastKey = key
        this.onChange(s)
      }
    } finally {
      this.busy = false
    }
  }
}

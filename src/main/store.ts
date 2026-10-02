import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { AuditEntry, DeepPartial, Settings } from '@shared/types'

const dir = () => app.getPath('userData')
const settingsFile = () => join(dir(), 'settings.json')
const secretsFile = () => join(dir(), 'secrets.bin')
const auditFile = () => join(dir(), 'audit.log')

export const defaultSettings: Settings = {
  google: { clientId: '', clientSecret: '' },
  mediaControls: true,
  earbuds: true,
  dock: { edge: 'top', pos: 0.5, hidden: false },
  usageLimits: { claudeDaily: 0, claudeWeekly: 0, codexDaily: 0, codexWeekly: 0, antigravityDaily: 0, antigravityWeekly: 0, weekStartDay: 1, readPlanUsage: true },
  activeProvider: 'claude',
  providers: {
    claude: { enabled: true, command: '', model: 'claude-sonnet-5', mode: 'readonly' },
    codex: { enabled: true, command: '', model: '', mode: 'readonly' },
    gemini: { enabled: true, command: '', model: '', mode: 'readonly' },
    antigravity: { enabled: true, command: '', model: '', mode: 'readonly' },
    custom: { enabled: false, command: '', model: '', mode: 'readonly', label: 'Custom agent', args: [] }
  },
  workspaces: [],
  activeWorkspace: null,
  scheduledTasks: [],
  mail: {
    enabled: false,
    provider: 'google',
    googleEmail: '',
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    user: '',
    hasPassword: false,
    clipboardClearSeconds: 45
  },
  proactive: { enabled: true, llmPredictions: false },
  launchAtLogin: false,
  appPermissions: [],
  computer: { enabled: true, realInput: true },
  assistant: {
    provider: 'auto',
    autoApproveGeneral: false,
    contextAware: true,
    mailNotifications: true,
    screenWatch: true,
    aiInsights: true,
    aiChecksPerHour: 10,
    backgroundModel: '',
    autoReviewCommits: true,
    webApprovalRequired: true,
    linkPreviews: true
  }
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    // Only keys that exist in the schema are accepted — unknown keys from the renderer are dropped.
    if (!(k in out)) continue
    const cur = out[k]
    if (typeof cur !== typeof v && !(cur === null || v === null)) continue
    out[k] = typeof cur === 'object' && cur !== null && !Array.isArray(cur) ? deepMerge(cur, v) : v
  }
  return out as T
}

let settings: Settings = defaultSettings

export function loadSettings(): Settings {
  mkdirSync(dir(), { recursive: true })
  try {
    if (existsSync(settingsFile())) {
      const raw = JSON.parse(readFileSync(settingsFile(), 'utf8'))
      // Older versions only had IMAP: keep an existing IMAP setup on IMAP.
      if (raw?.mail && !raw.mail.provider && raw.mail.user) raw.mail.provider = 'imap'
      settings = deepMerge(defaultSettings, raw)
    }
  } catch {
    settings = defaultSettings
  }
  settings.mail.hasPassword = !!readSecret('mailPassword')
  // assistant.provider is deprecated (General runs now always follow activeProvider) — never let a stale pinned value resurface.
  settings.assistant.provider = 'auto'
  // The old built-in default — background checks now use the model you picked for your agent.
  if (settings.assistant.backgroundModel === 'gemini-3.8-flash') settings.assistant.backgroundModel = ''
  return settings
}

export function getSettings(): Settings {
  return settings
}

export function patchSettings(patch: DeepPartial<Settings>): Settings {
  // hasPassword and workspace list are managed by dedicated, validated IPC calls.
  const p = structuredClone(patch) as DeepPartial<Settings>
  if (p.mail) {
    delete p.mail.hasPassword
    delete p.mail.googleEmail
  }
  delete p.workspaces
  delete p.dock
  delete p.activeWorkspace
  delete p.scheduledTasks
  settings = deepMerge(settings, p)
  saveSettings()
  return settings
}

export function replaceSettings(next: Settings): void {
  settings = next
  saveSettings()
}

function saveSettings(): void {
  const tmp = settingsFile() + '.tmp'
  writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
  renameSync(tmp, settingsFile())
}

// ---- Secrets: encrypted with Windows DPAPI via Electron safeStorage ----

function readSecrets(): Record<string, string> {
  try {
    if (!existsSync(secretsFile()) || !safeStorage.isEncryptionAvailable()) return {}
    return JSON.parse(safeStorage.decryptString(readFileSync(secretsFile())))
  } catch {
    return {}
  }
}

export function readSecret(key: string): string | null {
  return readSecrets()[key] ?? null
}

export function writeSecret(key: string, value: string | null): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  const all = readSecrets()
  if (value === null) delete all[key]
  else all[key] = value
  writeFileSync(secretsFile(), safeStorage.encryptString(JSON.stringify(all)))
  return true
}

// ---- Audit log (append-only JSONL, never contains secrets or OTP values) ----

export function audit(kind: string, detail: string): void {
  const entry: AuditEntry = { at: Date.now(), kind, detail: detail.slice(0, 500) }
  try {
    if (existsSync(auditFile()) && statSync(auditFile()).size > 2_000_000) {
      renameSync(auditFile(), auditFile() + '.1')
    }
    appendFileSync(auditFile(), JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    /* audit must never crash the app */
  }
}

export function readAudit(limit = 200): AuditEntry[] {
  try {
    const lines = readFileSync(auditFile(), 'utf8').trim().split('\n')
    return lines
      .slice(-limit)
      .map(l => JSON.parse(l) as AuditEntry)
      .reverse()
  } catch {
    return []
  }
}

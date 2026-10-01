// Types shared between the main process, preload and renderer.

export type ProviderId = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'custom'

/** readonly = agent may read/plan only. edit = agent may modify files inside the workspace. */
export type AgentMode = 'readonly' | 'edit'

export interface ProviderConfig {
  enabled: boolean
  /** Optional absolute path override for the executable. */
  command: string
  /** Model id passed to the CLI. Empty string = CLI default. */
  model: string
  mode: AgentMode
}

export interface CustomProviderConfig extends ProviderConfig {
  label: string
  /** Extra args. `{model}` is substituted. The prompt is always sent on stdin, never as an argument. */
  args: string[]
}

export interface MailConfig {
  enabled: boolean
  /** google = "Sign in with Google" (Gmail API, read-only). imap = any provider with an app password. */
  provider: 'google' | 'imap'
  /** Connected Google account (set by the main process after sign-in). */
  googleEmail: string
  host: string
  port: number
  secure: boolean
  user: string
  /** True when an encrypted password is stored. The password itself never leaves the main process. */
  hasPassword: boolean
  /** Seconds before a copied code is wiped from the clipboard. */
  clipboardClearSeconds: number
}

export type DockEdge = 'top' | 'bottom' | 'left' | 'right'

export interface DockState {
  edge: DockEdge
  /** 0..1 position along the edge. */
  pos: number
  /** Collapsed to a small arrow tab. */
  hidden: boolean
}

export interface UsageLimitConfig {
  /** Tokens per day / week (input + output + cache writes). 0 = auto (your own busiest day / week). */
  claudeDaily: number
  claudeWeekly: number
  codexDaily: number
  codexWeekly: number
  antigravityDaily: number
  antigravityWeekly: number
  /** 0 = Sunday … 6 = Saturday. */
  weekStartDay: number
  /** Show real Claude plan usage (session + weekly) using Claude Code's local sign-in. */
  readPlanUsage: boolean
}

export interface UsageRing {
  label: string
  /** 0..100 */
  pct: number
  used: number | null
  limit: number | null
  resetsAt: number
}

export interface AiLimit {
  id: 'claude' | 'codex' | 'antigravity'
  label: string
  color: string
  /** Inner ring: today (or Codex's 5-hour window when it reports one). */
  inner: UsageRing
  /** Outer ring: this week. */
  outer: UsageRing
  /** True when the percentages come from the provider itself (Codex rate limits), false = local estimate. */
  reported: boolean
}

export interface MediaState {
  /** Windows app id of the player (e.g. "Chrome", "Spotify.exe"). */
  app: string
  appName: string
  title: string
  artist: string
  album: string
  /** Playing | Paused | Stopped | Changing | Opened | Closed */
  status: string
  canToggle: boolean
  canNext: boolean
  canPrev: boolean
  /** Seconds, as of receivedAt. */
  position: number
  duration: number
  receivedAt: number
  /** data: URL of the cover art, if the player provides one. */
  thumbnail: string | null
}

/** An installed application detected on the PC. */
export interface InstalledApp {
  name: string
  process: string
  path: string | null
}

/** Per-app permission for screen reading. */
export interface AppPermission {
  /** Process name (lowercase). */
  process: string
  /** Display name. */
  name: string
  /** Whether Isla is allowed to read this app's screen content. */
  allowed: boolean
}

export interface Settings {
  /** Your own Google Cloud "Desktop app" OAuth client (only needed if the build doesn't bundle one). */
  google: { clientId: string; clientSecret: string }
  /** Show now-playing media with controls in the island. */
  mediaControls: boolean
  dock: DockState
  usageLimits: UsageLimitConfig
  activeProvider: ProviderId
  providers: {
    claude: ProviderConfig
    codex: ProviderConfig
    gemini: ProviderConfig
    antigravity: ProviderConfig
    custom: CustomProviderConfig
  }
  /** Allowlisted folders. Agents and git actions only run inside these. */
  workspaces: string[]
  activeWorkspace: string | null
  scheduledTasks: ScheduledTask[]
  mail: MailConfig
  proactive: {
    enabled: boolean
    /** Let the agent itself predict next steps (costs tokens, read-only). */
    llmPredictions: boolean
  }
  launchAtLogin: boolean
  /** Per-app screen reading permissions. Apps not listed follow the default (allowed). */
  appPermissions: AppPermission[]
  assistant: {
    /** @deprecated No longer user-facing — General questions always use activeProvider now. Kept only so old settings.json files still deep-merge cleanly; always normalized back to 'auto' on load. */
    provider: ProviderId | 'auto'
    /** Run read-only General questions without the approval card (never applies when mail content is attached or in edit mode). */
    autoApproveGeneral: boolean
    /** Notice which app/window you are in and offer relevant help. Window titles never leave this PC. */
    contextAware: boolean
    /** Show a peek when a new (non-code) email arrives. */
    mailNotifications: boolean
    /** Read the window in front with on-device OCR (Windows) to offer help. Screenshots never leave the PC. */
    screenWatch: boolean
    /** Let a small, cheap model suggest the next step from the screen text. */
    aiInsights: boolean
    /** Hard cap on background AI calls per hour (screen insights + commit reviews). */
    aiChecksPerHour: number
    /** Model for background checks (e.g. "haiku"). Empty = the assistant's configured model. */
    backgroundModel: string
    /** Review finished changes and offer "Commit & push". */
    autoReviewCommits: boolean
    /** Always ask user permission before any web-reaching operation (fetch, search). */
    webApprovalRequired: boolean
  }
}

export interface ProviderStatus {
  id: ProviderId
  label: string
  installed: boolean
  path: string | null
  version: string | null
  /** Headless = we can stream a prompt to it. Antigravity is an IDE so it is launch-only. */
  headless: boolean
  modelSuggestions: string[]
}

export type RunStatus = 'pending-approval' | 'running' | 'done' | 'error' | 'killed' | 'rejected'

export interface AgentRun {
  id: string
  provider: ProviderId
  model: string
  mode: AgentMode
  workspace: string
  prompt: string
  title: string
  status: RunStatus
  output: string
  startedAt: number
  endedAt?: number
  usage?: TokenUsage
  costUsd?: number
  /** general = everyday assistant in a private scratch folder; project = inside the active workspace. */
  context: RunContext
  /** Set by the main process only: web search allowed (never when mail content is attached). */
  allowWeb: boolean
  /** The prompt includes email content (shown on the approval card). */
  hasMail: boolean
  /** Set when this run was fired by the TaskScheduler — links back to ScheduledTask.id. */
  scheduledTaskId?: string
}

export type RunContext = 'general' | 'project'

export interface RunRequest {
  prompt: string
  title?: string
  /** Overrides for this run only. */
  provider?: ProviderId
  mode?: AgentMode
  context?: RunContext
  /** Project-context override: must be allowlisted. Defaults to the globally active workspace when omitted. */
  workspace?: string
  /** Attach these emails (by uid) as context. Codes inside them are redacted. */
  mailUids?: string[]
}

export type TaskRecurrence =
  | { type: 'once'; runAt: number }
  | { type: 'interval'; everyMs: number }
  | { type: 'daily'; hour: number; minute: number }
  /** weekday: 0 = Sunday … 6 = Saturday. */
  | { type: 'weekly'; weekday: number; hour: number; minute: number }

export interface ScheduledTaskRunSummary {
  at: number
  status: RunStatus
  runId: string
  /** First ~120 chars of the run's output or error, for a quick glance in the list. */
  summary: string
}

export interface ScheduledTask {
  id: string
  title: string
  prompt: string
  context: RunContext
  /** Required (and must stay allowlisted) when context === 'project'. */
  workspace: string | null
  /** Optional override; null = resolve the default agent the same way any other run does. */
  provider: ProviderId | null
  /** edit-mode tasks always land as pending-approval — never fully unattended. */
  mode: AgentMode
  recurrence: TaskRecurrence
  enabled: boolean
  createdAt: number
  updatedAt: number
  nextRunAt: number | null
  lastRunAt: number | null
  lastRunStatus: RunStatus | null
  runCount: number
  /** Last 10 fires, newest first. Persists across restarts, unlike the in-memory AgentRun ring buffer. */
  history: ScheduledTaskRunSummary[]
}

export interface ScheduledTaskInput {
  title: string
  prompt: string
  context: RunContext
  workspace?: string | null
  provider?: ProviderId | null
  mode: AgentMode
  recurrence: TaskRecurrence
}

export interface MailSummary {
  /** Message id: IMAP uid as text, or Gmail message id. */
  uid: string
  from: string
  fromAddress: string
  subject: string
  date: number
  preview: string
  unread: boolean
}

export interface MailMessage extends MailSummary {
  to: string
  text: string
}

/** Result of asking Isla something from the Home composer. */
export type AskResult =
  | { type: 'mail'; message: MailMessage }
  | { type: 'mail-list'; messages: MailSummary[]; title: string }
  | { type: 'otp'; otp: OtpCode | null }
  | { type: 'run'; run: AgentRun }
  | { type: 'opened'; message: string }
  | { type: 'chat'; text: string }
  | { type: 'error'; message: string }

export interface CommitProposal {
  workspace: string
  /** Hash of the reviewed diff — the commit is refused if the tree changed since. */
  diffHash: string
  files: string[]
  message: string
  ok: boolean
  issues: string[]
  /** Possible secrets found locally in the added lines. */
  secrets: string[]
  source: 'ai' | 'local'
  createdAt: number
}

export interface ScreenStatus {
  app: string
  capturedAt: number
  chars: number
  /** Why the last capture was skipped (e.g. password manager in front). */
  skipped: string | null
}

export interface BackgroundStats {
  callsLastHour: number
  limitPerHour: number
  tokensToday: number
  costToday: number
}

export interface ActivityContext {
  app: string
  process: string
  title: string
  kind: 'browser' | 'mail' | 'ide' | 'office' | 'chat' | 'terminal' | 'other'
  /** Detected sign-in / verification page. */
  signIn: boolean
  /** Project folder name when an IDE is focused. */
  project: string | null
  /** Process id of the window, so Isla can paste text back into it. */
  pid: number
}

export interface GitFile {
  path: string
  /** Two-letter porcelain code, e.g. "M.", ".M", "??", "UU". */
  code: string
}

export interface GitCommit {
  hash: string
  subject: string
  author: string
  relative: string
}

export interface GitState {
  workspace: string
  isRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: number
  modified: number
  untracked: number
  conflicted: number
  files: GitFile[]
  commits: GitCommit[]
  lastCommitAt: number | null
  error?: string
  updatedAt: number
}

export interface OtpCode {
  id: string
  code: string
  from: string
  subject: string
  receivedAt: number
  expiresAt: number
}

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelUsage extends TokenUsage {
  source: 'Claude Code' | 'Codex' | 'Antigravity' | 'Agentic Island'
  model: string
  requests: number
}

export interface UsageReport {
  today: ModelUsage[]
  week: ModelUsage[]
  daily: { date: string; tokens: number }[]
  islandCostUsd: number
  scannedAt: number
  notes: string[]
}

export interface AiProcess {
  name: string
  pid: number
  /** Number of OS processes grouped under this app. */
  count: number
  memoryMb: number
  cpuPercent: number
  kind: string
}

export type SuggestionAction =
  | { type: 'run'; request: RunRequest }
  | { type: 'git'; op: 'push' | 'pull' | 'fetch' }
  | { type: 'copy-otp'; id: string }
  | { type: 'open-panel'; panel: PanelId }
  | { type: 'ask'; text: string; context: RunContext }
  | { type: 'do'; title: string; prompt: string }
  | { type: 'commit'; push: boolean }
  | { type: 'add-workspace' }

export interface Suggestion {
  id: string
  title: string
  detail: string
  icon: 'commit' | 'push' | 'pull' | 'conflict' | 'key' | 'spark' | 'review' | 'warn' | 'mail' | 'folder' | 'eye' | 'chat' | 'translate'
  action: SuggestionAction
  createdAt: number
}

export type PanelId = 'home' | 'agent' | 'git' | 'mail' | 'usage' | 'scheduler' | 'settings' | 'security'

export interface AuditEntry {
  at: number
  kind: string
  detail: string
}

export interface SecurityState {
  /** Kill switch engaged: every agent/watcher is stopped until the user resumes. */
  locked: boolean
  lockedAt: number | null
  activeRuns: number
  killShortcut: string
}

export interface IslandSnapshot {
  settings: Settings
  providers: ProviderStatus[]
  runs: AgentRun[]
  git: GitState | null
  otps: OtpCode[]
  suggestions: Suggestion[]
  security: SecurityState
  mailStatus: 'off' | 'connecting' | 'watching' | 'error'
  mailError: string | null
  inbox: MailSummary[]
  activity: ActivityContext | null
  /** Provider used for General questions right now (null = none can run headless). */
  assistantProvider: ProviderId | null
  screen: ScreenStatus | null
  proposal: CommitProposal | null
  background: BackgroundStats
  limits: AiLimit[]
  media: MediaState | null
  /** A Google OAuth client is available (bundled or configured), so "Sign in with Google" works. */
  googleReady: boolean
  version: string
  scheduledTasks: ScheduledTask[]
  schedulerStats: { runsLastHour: number; limitPerHour: number }
}

export type IslandEvent =
  | { type: 'snapshot'; snapshot: IslandSnapshot }
  | { type: 'run-output'; id: string; chunk: string }
  | { type: 'dock'; dock: DockState }
  | { type: 'media'; media: MediaState | null }
  | { type: 'notify'; kind: 'otp' | 'mail' | 'run-done' | 'run-error' | 'security' | 'info' | 'suggest' | 'commit' | 'reminder'
      title: string
      body: string
      url?: string
      uid?: string
      suggestionId?: string
      /** For suggestion peeks: which kind, so Isla's face can match it. */
      icon?: Suggestion['icon']
    }

/** API exposed on window.island by the preload script. */
export interface IslandApi {
  getSnapshot(): Promise<IslandSnapshot>
  ask(text: string, context: RunContext): Promise<AskResult>
  readMail(uid: string): Promise<MailMessage>
  refreshInbox(): Promise<MailSummary[]>
  onEvent(cb: (e: IslandEvent) => void): () => void
  setInteractive(interactive: boolean): void
  dragStart(pillWidth: number, pillHeight: number, offsetX: number, offsetY: number): void
  dragEnd(): void
  setHidden(hidden: boolean): void
  setPeekActive(active: boolean): Promise<boolean>
  mediaControl(cmd: 'toggle' | 'next' | 'prev'): void
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>
  setMailPassword(password: string): Promise<boolean>
  clearMailPassword(): Promise<boolean>
  testMail(): Promise<{ ok: boolean; message: string }>
  googleSignIn(): Promise<{ ok: boolean; message: string; needsSetup?: boolean }>
  googleSignOut(): Promise<void>
  openUrl(url: string): Promise<void>
  /** Copy text, switch back to the app you were using, and paste it (never presses Enter). */
  pasteToApp(text: string): Promise<{ ok: boolean; message: string }>
  addWorkspace(): Promise<string | null>
  removeWorkspace(path: string): Promise<void>
  setActiveWorkspace(path: string): Promise<void>
  refreshProviders(): Promise<ProviderStatus[]>
  requestRun(req: RunRequest): Promise<AgentRun>
  approveRun(id: string): Promise<void>
  rejectRun(id: string): Promise<void>
  cancelRun(id: string): Promise<void>
  clearRuns(): Promise<void>
  createTask(input: ScheduledTaskInput): Promise<ScheduledTask>
  updateTask(id: string, patch: Partial<ScheduledTaskInput> & { enabled?: boolean }): Promise<ScheduledTask>
  deleteTask(id: string): Promise<void>
  runTaskNow(id: string): Promise<AgentRun>
  toggleTask(id: string, enabled: boolean): Promise<void>
  openInAntigravity(prompt: string): Promise<{ ok: boolean; message: string }>
  gitAction(op: 'push' | 'pull' | 'fetch'): Promise<{ ok: boolean; message: string }>
  commit(message: string, push: boolean, diffHash: string, allowSecrets?: boolean): Promise<{ ok: boolean; message: string }>
  reviewChanges(): Promise<CommitProposal | null>
  doSuggestion(id: string): Promise<AgentRun>
  copyText(text: string): Promise<void>
  copyOtp(id: string): Promise<boolean>
  dismissOtp(id: string): Promise<void>
  dismissSuggestion(id: string): Promise<void>
  predictNext(): Promise<void>
  getUsage(): Promise<UsageReport>
  getProcesses(): Promise<AiProcess[]>
  getAudit(): Promise<AuditEntry[]>
  killSwitch(): Promise<void>
  resume(): Promise<void>
  shutdown(): Promise<void>
  /** Scan installed apps on the PC for the permissions panel. */
  scanInstalledApps(): Promise<InstalledApp[]>
  /** Set screen-reading permission for a specific app. */
  setAppPermission(process: string, name: string, allowed: boolean): Promise<void>
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] }

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

export interface MeetingSettings {
  /** Notice when Teams / Zoom / Meet… starts using the microphone and offer to record. */
  autoDetect: boolean
  /** Also record the screen as a video (audio is always recorded for the summary). */
  recordScreen: boolean
  /** Transcribe + summarize with Gemini when the meeting ends (needs a Gemini API key). */
  summarize: boolean
  /** 'English' or 'meeting' (= the main language spoken in the meeting). */
  summaryLanguage: 'English' | 'meeting'
  geminiModel: string
  /** A Gemini API key is stored (encrypted). The key itself never leaves the main process. */
  hasGeminiKey: boolean
  /** Recording defaults (also used by the meeting peek and the tray). */
  captureSystemAudio: boolean
  captureMic: boolean
  /** Display ids to record; empty = the main screen. */
  screens: string[]
}

/** What to capture for one recording. */
export interface RecordOptions {
  /** Display ids; empty = no video (sound only). */
  screens: string[]
  /** Computer sound — what you hear (other people in a call, videos…). */
  systemAudio: boolean
  /** Your microphone. */
  mic: boolean
}

export interface ScreenSource {
  displayId: string
  name: string
  primary: boolean
  width: number
  height: number
  /** Small preview (data: URL). */
  thumbnail: string
}

export type MeetingPhase = 'idle' | 'detected' | 'recording' | 'processing'

/** Live meeting status shown on the island. */
export interface MeetingState {
  phase: MeetingPhase
  /** "Teams", "Zoom", "Google Meet"… */
  app: string
  detectedAt: number | null
  recordingSince: number | null
  /** What is happening while processing ("Uploading audio…", "Writing summary…"). */
  step: string | null
}

export interface MeetingActionItem {
  task: string
  owner: string | null
  due: string | null
}

export interface MeetingRecord {
  id: string
  /** meeting = recorded while a call app used the mic (auto-summarized); screen = a plain screen recording. */
  kind: 'meeting' | 'screen'
  app: string
  title: string
  startedAt: number
  endedAt: number
  folder: string
  hasVideo: boolean
  /** recording.mp4 (or .webm on older systems); null when only audio was recorded. */
  videoFile: string | null
  status: 'recorded' | 'processing' | 'done' | 'error'
  error?: string
  /** Detected main language(s), e.g. "Sinhala, English". */
  language: string | null
  summary: string[]
  decisions: string[]
  actionItems: MeetingActionItem[]
  /** Only filled by getMeeting(); the snapshot leaves it out. */
  transcript?: string
}

export interface Settings {
  /** Software rendering (no GPU process) — about half the memory. Applied at the next start. */
  lowMemory: boolean
  meetings: MeetingSettings
  /** Your own Google Cloud "Desktop app" OAuth client (only needed if the build doesn't bundle one). */
  google: { clientId: string; clientSecret: string }
  /** Show now-playing media with controls in the island. */
  mediaControls: boolean
  /** Show connected Bluetooth earbuds/headphones and their battery on the island. */
  earbuds: boolean
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
  }
  launchAtLogin: boolean
  /** Per-app screen reading permissions. Apps not listed follow the default (allowed). */
  appPermissions: AppPermission[]
  /** Let approved tasks operate the PC through Isla's tools (mail, files, windows, Isla's own browser). */
  computer: {
    enabled: boolean
    /** Allow the real mouse/keyboard as a last resort (every use is confirmed on the island). */
    realInput: boolean
  }
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
    /** Show previews (title, picture) for links and images in answers. Fetched by Isla, with private addresses blocked. */
    linkPreviews: boolean
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
  /** Set when a plugin asked for this run (web research) — its result goes back to the plugin, never handed off to a PC task. */
  pluginId?: string
  /** Set by the main process only: the run may operate the PC through Isla's computer-control tools. */
  computer?: boolean
  /** Conversation this run belongs to (follow-ups share it); the first run's id. */
  threadId?: string
  /** What the user typed (the prompt may also carry history, mail or screen text). */
  question?: string
  /** In a live update: output unchanged since the last one, so it was left out (the island keeps its copy). */
  outputOmitted?: boolean
  /** Computer runs: the user already allowed PC work for this conversation (a quick continuation) — no first-use prompt. */
  preApproved?: boolean
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
  /** Continue this conversation (set by the main process). */
  threadId?: string
}

/** A connected Bluetooth audio device (earbuds, headphones) and its battery, as Windows reports it. */
export interface AudioDevice {
  name: string
  /** 0–100, or null when the device doesn't report it. */
  battery: number | null
}

/** A file mentioned in an answer, for its card. */
export interface FileInfo {
  path: string
  name: string
  dir: string
  isDir: boolean
  size: number
  modified: number
  /** Windows shell thumbnail (images, PDFs, videos, Office files…) as a data URL. */
  thumb: string | null
}

/** Preview of a web link or image in an answer (fetched by the main process, never by the page). */
export interface LinkPreview {
  url: string
  site: string
  title: string
  description: string
  /** data: URL */
  image: string | null
}

/** Where a Home question goes: the two run contexts, or a task that operates the PC. */
export type AskContext = RunContext | 'computer'

/** A risky step a computer-control task wants to take — it waits for Allow / Deny on the island. */
export interface PendingAction {
  id: string
  runId: string
  runTitle: string
  /** e.g. "Click “Send” in Isla browser". */
  summary: string
  /** Why Isla is asking. */
  reason: string
  createdAt: number
  expiresAt: number
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
  | { type: 'do'; title: string; prompt: string; /** Ask the user what they want first (shown as a text box). */ askUser?: string }
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

export type PanelId = 'home' | 'agent' | 'git' | 'mail' | 'meetings' | 'usage' | 'scheduler' | 'plugins' | 'settings' | 'security'

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

/** A one-off meeting / alarm / reminder set from chat. */
export interface Reminder {
  id: string
  kind: 'meeting' | 'alarm' | 'reminder'
  title: string
  url?: string
  targetAt: number
  createdAt: number
}

export interface IslandSnapshot {
  meeting: MeetingState
  meetingList: MeetingRecord[]
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
  /** Upcoming reminders, soonest first. */
  reminders: Reminder[]
  /** Reminders that went off and wait for you (Join / Snooze / Done). */
  alerts: Reminder[]
  /** Computer-control steps waiting for your OK. */
  pendingActions: PendingAction[]
  /** Isla's own browser window exists (it may be hidden). */
  browserOpen: boolean
  /** Antigravity CLI and computer control: null = agy not installed, false = not connected yet, true = connected. */
  antigravityComputer: boolean | null
  /** Connected Bluetooth earbuds/headphones with battery. */
  audioDevices: AudioDevice[]
  /** Plugins found on this PC (built-in and installed), with their state. */
  plugins: PluginInfo[]
}

export type IslandEvent =
  | { type: 'snapshot'; snapshot: IslandSnapshot }
  | { type: 'run-output'; id: string; chunk: string }
  | { type: 'dock'; dock: DockState }
  | { type: 'media'; media: MediaState | null }
  | { type: 'notify'; kind: 'otp' | 'mail' | 'run-done' | 'run-error' | 'security' | 'info' | 'suggest' | 'commit' | 'reminder' | 'action' | 'device' | 'meeting' | 'meeting-done' | 'approval'
      /** For approval peeks: the task waiting for Approve / Reject. */
      runId?: string
      /** For meeting peeks: the finished meeting's id (Open summary). */
      meetingId?: string
      title: string
      body: string
      url?: string
      uid?: string
      suggestionId?: string
      /** For computer-control confirmations: the PendingAction id. */
      actionId?: string
      /** For a reminder that is ringing: its id (Join / Snooze / Done). */
      reminderId?: string
      /** For suggestion peeks: which kind, so Isla's face can match it. */
      icon?: Suggestion['icon']
      /** Where "Open" goes (default: the Agent panel). */
      panel?: PanelId
    }

/** API exposed on window.island by the preload script. */
export interface IslandApi {
  getSnapshot(): Promise<IslandSnapshot>
  ask(text: string, context: AskContext, threadId?: string | null): Promise<AskResult>
  fileInfo(path: string): Promise<FileInfo | null>
  openFile(path: string, reveal?: boolean): Promise<{ ok: boolean; message: string }>
  linkPreview(url: string): Promise<LinkPreview | null>
  readMail(uid: string): Promise<MailMessage>
  refreshInbox(): Promise<MailSummary[]>
  onEvent(cb: (e: IslandEvent) => void): () => void
  setInteractive(interactive: boolean): void
  dragStart(pillWidth: number, pillHeight: number, offsetX: number, offsetY: number): void
  dragEnd(): void
  setHidden(hidden: boolean): void
  meetingRecord(opts?: RecordOptions): Promise<{ ok: boolean; message: string }>
  listScreens(): Promise<ScreenSource[]>
  meetingStop(): Promise<void>
  meetingDismiss(): void
  meetingRetry(id: string): Promise<void>
  getMeeting(id: string): Promise<MeetingRecord | null>
  openMeetingFolder(id: string): Promise<void>
  playMeetingVideo(id: string): Promise<void>
  deleteMeeting(id: string): Promise<void>
  setGeminiKey(key: string | null): Promise<{ ok: boolean; message: string }>
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
  deleteReminder(id: string): Promise<void>
  ackReminder(id: string, action: 'done' | 'snooze' | 'open'): Promise<void>
  decideAction(id: string, allow: boolean): Promise<void>
  showBrowser(show: boolean): Promise<void>
  connectAntigravity(): Promise<{ ok: boolean; message: string }>
  toggleTask(id: string, enabled: boolean): Promise<void>
  openInAntigravity(prompt: string): Promise<{ ok: boolean; message: string }>
  gitAction(op: 'push' | 'pull' | 'fetch'): Promise<{ ok: boolean; message: string }>
  commit(message: string, push: boolean, diffHash: string, allowSecrets?: boolean): Promise<{ ok: boolean; message: string }>
  reviewChanges(): Promise<CommitProposal | null>
  doSuggestion(id: string, request?: string): Promise<AgentRun>
  copyText(text: string): Promise<void>
  copyOtp(id: string): Promise<boolean>
  dismissOtp(id: string): Promise<void>
  dismissSuggestion(id: string): Promise<void>
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
  /** Pick a plugin folder or .zip and install it (Isla shows its permissions and asks first). */
  installPlugin(from: 'folder' | 'zip'): Promise<{ ok: boolean; message: string }>
  uninstallPlugin(id: string): Promise<void>
  /** Pack an installed plugin into a .zip to share with someone else. */
  exportPlugin(id: string): Promise<{ ok: boolean; message: string }>
  setPluginEnabled(id: string, enabled: boolean): Promise<void>
  /** For "secret" settings: '' keeps the saved value, null clears it. */
  setPluginValues(id: string, values: Record<string, PluginValue | null>): Promise<void>
  setPluginSchedule(id: string, toolId: string, schedule: { enabled: boolean; recurrence: TaskRecurrence }): Promise<void>
  runPlugin(id: string, toolId: string): Promise<void>
  stopPlugin(id: string): Promise<void>
  openPluginReport(id: string, runId: string, reveal?: boolean): Promise<void>
  /** Save one past run (its report files + summary + log) as a .zip. */
  exportPluginRun(id: string, runId: string): Promise<{ ok: boolean; message: string }>
  deletePluginRun(id: string, runId: string): Promise<void>
  /** Open the folder with every report this plugin saved. */
  openPluginReports(id: string): Promise<void>
  openPluginsFolder(): Promise<void>
  reloadPlugins(): Promise<void>
}

// ---------------------------------------------------------------- plugins

/** What a plugin can ask Isla to do for it. Network and files are not sandboxed — plugins are trusted code, like editor extensions. */
export type PluginPermission = 'ai' | 'ai-web' | 'notify' | 'network' | 'browser'

export type PluginValue = string | number | boolean

export interface PluginSettingDef {
  key: string
  label: string
  /** secret: stored encrypted (Windows DPAPI), never sent back to the UI. */
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'secret'
  default?: PluginValue
  help?: string
  options?: string[]
}

export interface PluginToolDef {
  id: string
  title: string
  description?: string
  /** Chat phrases that start this tool ("seo scout"). The whole message is passed to the tool as input.text. */
  chat?: string[]
  /** Suggested schedule; the user turns it on or changes it in the Plugins tab. */
  schedule?: Exclude<TaskRecurrence, { type: 'once' }>
  /** Hard stop for one run (default 15, max 120). */
  timeoutMinutes?: number
}

/** isla-plugin.json */
export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  author?: string
  homepage?: string
  /** Entry file, relative to the plugin folder (default index.js). */
  main?: string
  permissions: PluginPermission[]
  settings?: PluginSettingDef[]
  tools: PluginToolDef[]
}

export interface PluginRunSummary {
  id: string
  toolId: string
  startedAt: number
  endedAt: number | null
  status: 'running' | 'done' | 'error' | 'stopped'
  trigger: 'manual' | 'chat' | 'schedule'
  /** Short Markdown result shown in the panel (and in chat). */
  summary: string
  /** Folder with the saved report files, if the run saved any. */
  reportDir: string | null
  reportFiles: string[]
  /** The run's last log lines, kept so past runs can be checked later. */
  log: string[]
}

export interface PluginInfo {
  manifest: PluginManifest
  /** builtin: ships with Isla (plugins/ in the app); installed: added by you. */
  source: 'builtin' | 'installed'
  dir: string
  enabled: boolean
  /** Problem loading it (bad manifest, missing entry file). */
  error: string | null
  /** Secret settings show as '' here; these keys have a saved value. */
  values: Record<string, PluginValue>
  secretsSet: string[]
  schedules: Record<string, { enabled: boolean; recurrence: TaskRecurrence; nextRunAt: number | null }>
  running: { runId: string; toolId: string; startedAt: number; log: string[]; progress: number | null } | null
  history: PluginRunSummary[]
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] }

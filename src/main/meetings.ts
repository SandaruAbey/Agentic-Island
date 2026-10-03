import { remuxFragmentedMp4 } from './remux'
import { app, BrowserWindow, desktopCapturer, ipcMain, screen as eScreen, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IslandEvent, MeetingRecord, MeetingSettings, MeetingState, RecordOptions, ScreenSource } from '@shared/types'
import { killTree } from './agents'
import { winHelper } from './winhelper'

/**
 * Meetings: notice a call (an app starts using the microphone), offer to record, record screen + audio
 * on the user's click, and when the call ends transcribe + summarize with Gemini (Sinhala, Tamil, English…).
 *
 * Privacy: nothing is recorded without a click; a red REC indicator is always visible; files stay in
 * Videos\Agentic Island\Meetings; audio is uploaded to Gemini only when a key is set and summaries are on,
 * and the uploaded copy is deleted from Google right after.
 */

// ---------------------------------------------------------------- who is using the microphone

/** Windows keeps a live record of which apps use the mic (LastUsedTimeStop = 0 → in use right now). */
const MIC_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$base = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
$last = '-'
while ($true) {
  $list = @()
  foreach ($k in (Get-ChildItem $base -ErrorAction SilentlyContinue)) {
    $keys = if ($k.PSChildName -eq 'NonPackaged') { Get-ChildItem $k.PSPath -ErrorAction SilentlyContinue } else { @($k) }
    foreach ($n in $keys) {
      $p = Get-ItemProperty $n.PSPath -ErrorAction SilentlyContinue
      if ($p -and $p.LastUsedTimeStart -gt 0 -and $p.LastUsedTimeStop -eq 0) { $list += $n.PSChildName }
    }
  }
  $s = ($list | Sort-Object) -join '|'
  if ($s -ne $last) { $last = $s; [Console]::Out.WriteLine('MIC:' + $s); [Console]::Out.Flush() }
  Start-Sleep -Seconds 3
}
`

const MEETING_APPS: [RegExp, string][] = [
  [/teams/i, 'Teams'],
  [/zoom/i, 'Zoom'],
  [/webex|ciscocollab/i, 'Webex'],
  [/skype/i, 'Skype'],
  [/slack/i, 'Slack'],
  [/discord/i, 'Discord'],
  [/whatsapp/i, 'WhatsApp'],
  [/telegram/i, 'Telegram'],
  [/chrome|msedge|firefox|brave|opera|vivaldi/i, 'browser']
]

/** Our own recorder also uses the mic — never treat Isla/Electron as a meeting. */
const SELF = /agentic island|electron\.exe/i

export function meetingAppFor(micUsers: string[], browserTitle: string): string | null {
  for (const u of micUsers) {
    if (SELF.test(u)) continue
    for (const [re, name] of MEETING_APPS) {
      if (!re.test(u)) continue
      if (name !== 'browser') return name
      // A browser using the mic is almost always a web call; name it from the tab when we can.
      if (/\bmeet\b|google meet/i.test(browserTitle)) return 'Google Meet'
      if (/zoom/i.test(browserTitle)) return 'Zoom (web)'
      if (/teams/i.test(browserTitle)) return 'Teams (web)'
      if (/jitsi|whereby|webex/i.test(browserTitle)) return 'Web call'
      return 'Browser call'
    }
  }
  return null
}

// ---------------------------------------------------------------- WAV writer (16 kHz mono PCM)

const SAMPLE_RATE = 16_000

function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(SAMPLE_RATE, 24)
  h.writeUInt32LE(SAMPLE_RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(dataBytes, 40)
  return h
}

// ---------------------------------------------------------------- Gemini (audio → transcript + summary)

const GEMINI = 'https://generativelanguage.googleapis.com'

async function geminiUpload(key: string, file: string, mime: string, onStep: (s: string) => void): Promise<{ name: string; uri: string }> {
  const bytes = readFileSync(file)
  onStep(`Uploading audio (${Math.round(bytes.length / 1_048_576)} MB)…`)
  const start = await fetch(`${GEMINI}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: 'meeting-audio' } })
  })
  const url = start.headers.get('x-goog-upload-url')
  if (!start.ok || !url) throw new Error(`Gemini upload refused (${start.status}). Check your API key.`)
  const up = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Length': String(bytes.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: bytes
  })
  const j = await up.json()
  if (!up.ok || !j.file) throw new Error(`Gemini upload failed (${up.status}).`)
  let f = j.file
  onStep('Gemini is listening to the recording…')
  for (let i = 0; i < 120 && f.state === 'PROCESSING'; i++) {
    await new Promise(r => setTimeout(r, 3000))
    f = await (await fetch(`${GEMINI}/v1beta/${f.name}`, { headers: { 'x-goog-api-key': key } })).json()
  }
  if (f.state !== 'ACTIVE') throw new Error('Gemini could not process the audio.')
  return { name: f.name, uri: f.uri }
}

async function geminiGenerate(key: string, model: string, fileUri: string, prompt: string, json: boolean): Promise<string> {
  const res = await fetch(`${GEMINI}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ file_data: { mime_type: 'audio/wav', file_uri: fileUri } }, { text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 65_536, ...(json ? { responseMimeType: 'application/json' } : {}) }
    }),
    signal: AbortSignal.timeout(20 * 60_000)
  })
  const j = await res.json()
  if (!res.ok) throw new Error(j.error?.message ?? `Gemini error ${res.status}`)
  return (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('')
}

const SUMMARY_PROMPT = (lang: string) => `This is a recording of a meeting. People may speak Sinhala, Tamil, English, another language, or mix them.
Write the result in ${lang}. Reply with JSON only:
{"title": "short meeting title", "language": "main language(s) spoken", "summary": ["5-10 short bullet points covering what was discussed"], "decisions": ["decisions made"], "action_items": [{"task": "...", "owner": "name or null", "due": "date/time or null"}]}
Use empty arrays when there is nothing. Do not invent anything that was not said.`

const TRANSCRIPT_PROMPT = `Transcribe this meeting recording verbatim in the ORIGINAL language(s) spoken — write Sinhala in Sinhala script, Tamil in Tamil script, English in English. Do not translate.
Label speakers as "Speaker 1:", "Speaker 2:" (use names if people say them). Put a [mm:ss] timestamp at the start of each speaker turn. Output plain text only.`

// ---------------------------------------------------------------- the manager

export class MeetingManager {
  state: MeetingState = { phase: 'idle', app: '', detectedAt: null, recordingSince: null, step: null }
  list: MeetingRecord[] = []
  private mic: ChildProcess | null = null
  private micNative = false
  private micUsers: string[] = []
  private idleTimer: NodeJS.Timeout | null = null
  private recorder: BrowserWindow | null = null
  private current: { rec: MeetingRecord; wav: { fd: number; bytes: number }; video: WriteStream | null; wantVideo: boolean } | null = null
  private stopped: (() => void) | null = null
  private dismissedUntil = 0
  /** Screens the recorder will ask for, in order (each getDisplayMedia call takes the next one). */
  private sourceQueue: { id: string; audio: boolean }[] = []

  /** Called by the display-media handler for the recorder's next getDisplayMedia request. */
  nextSource(): { id: string; audio: boolean } | null {
    return this.sourceQueue.shift() ?? null
  }

  /** All screens with a small preview, for the "what to record" picker. */
  async listScreens(): Promise<ScreenSource[]> {
    const displays = eScreen.getAllDisplays()
    const primary = eScreen.getPrimaryDisplay().id
    const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } })
    return src.map((s, i) => {
      const d = displays.find(x => String(x.id) === s.display_id)
      return {
        displayId: s.display_id || String(i),
        name: d?.id === primary ? 'Main screen' : `Screen ${i + 1}`,
        primary: d?.id === primary,
        width: d ? Math.round(d.size.width * d.scaleFactor) : 0,
        height: d ? Math.round(d.size.height * d.scaleFactor) : 0,
        thumbnail: s.thumbnail.toDataURL()
      }
    })
  }
  private dataFile = ''

  constructor(
    private d: {
      settings: () => MeetingSettings
      geminiKey: () => string | null
      browserTitle: () => string
      isLocked: () => boolean
      /** Keep Isla's own window out of the recording (Windows "exclude from capture"). */
      hideFromCapture: (hidden: boolean) => void
      onChange: () => void
      notify: (e: Extract<IslandEvent, { type: 'notify' }>) => void
      log: (kind: string, detail: string) => void
    }
  ) {}

  /** The renderer that does the actual capture (hidden). Only it may use screen/mic, only while recording. */
  get recorderContentsId(): number | null {
    return this.recorder && !this.recorder.isDestroyed() ? this.recorder.webContents.id : null
  }

  load(): void {
    this.dataFile = join(app.getPath('userData'), 'meetings.json')
    try {
      this.list = JSON.parse(readFileSync(this.dataFile, 'utf8'))
      // A crash mid-processing leaves "processing" behind — let the user retry.
      for (const m of this.list) {
        if (m.status === 'processing') m.status = 'recorded'
        m.kind ??= 'meeting'
        if (m.videoFile === undefined) {
          const old = ['recording.mp4', 'recording.webm'].map(f => join(m.folder, f)).find(f => existsSync(f) && statSync(f).size > 0)
          m.videoFile = old ?? null
        }
      }
    } catch {
      this.list = []
    }
    ipcMain.on('rec:chunk', (e, kind: unknown, data: unknown) => {
      if (e.sender.id !== this.recorderContentsId || !this.current || !(data instanceof Uint8Array)) return
      if (kind === 'pcm') {
        writeSync(this.current.wav.fd, data)
        this.current.wav.bytes += data.length
      } else if (kind === 'video') this.current.video?.write(Buffer.from(data))
    })
    // The recorder tells us which container it could use (MP4 when available) before the first video chunk.
    ipcMain.on('rec:format', (e, ext: unknown) => {
      const cur = this.current
      if (e.sender.id !== this.recorderContentsId || !cur || !cur.wantVideo || cur.video) return
      const file = join(cur.rec.folder, ext === 'mp4' ? 'recording.mp4' : 'recording.webm')
      cur.video = createWriteStream(file)
      cur.rec.videoFile = file
    })
    ipcMain.on('rec:stopped', e => {
      if (e.sender.id === this.recorderContentsId) this.stopped?.()
    })
    ipcMain.on('rec:error', (e, msg: unknown) => {
      if (e.sender.id !== this.recorderContentsId) return
      this.d.log('meeting.error', String(msg).slice(0, 200))
      this.d.notify({ type: 'notify', kind: 'info', title: 'Recording problem', body: String(msg).slice(0, 160) })
    })
  }

  private save(): void {
    try {
      writeFileSync(this.dataFile, JSON.stringify(this.list.map(m => ({ ...m, transcript: undefined })), null, 2))
    } catch {
      /* best effort */
    }
  }

  // ---- detection

  start(): void {
    if (this.mic || this.micNative) return
    if (winHelper.isNative) {
      this.micNative = true
      winHelper.onMic = users => this.onMic(users)
      winHelper.enable('mic')
      return
    }
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(MIC_SCRIPT, 'utf16le').toString('base64')], { windowsHide: true })
    this.mic = p
    let buf = ''
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (d: string) => {
      buf += d
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const l of lines) if (l.startsWith('MIC:')) this.onMic(l.slice(4).split('|').filter(Boolean))
    })
    p.on('close', () => {
      if (this.mic === p) this.mic = null
    })
  }

  stopWatching(): void {
    if (this.micNative) {
      this.micNative = false
      winHelper.disable('mic')
    }
    const p = this.mic
    this.mic = null
    if (p) killTree(p.pid)
  }

  private onMic(users: string[]): void {
    this.micUsers = users
    const app = meetingAppFor(users, this.d.browserTitle())
    const s = this.state
    if (app) {
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.idleTimer = null
      if (s.phase === 'idle' && this.d.settings().autoDetect && !this.d.isLocked() && Date.now() > this.dismissedUntil) {
        this.state = { phase: 'detected', app, detectedAt: Date.now(), recordingSince: null, step: null }
        this.d.log('meeting.detected', app)
        this.d.notify({ type: 'notify', kind: 'meeting', title: `Meeting started in ${app}`, body: 'Record the screen and summarize it when it ends?' })
        this.d.onChange()
      }
      return
    }
    // Mic released: give it a little time (people mute, rejoin…) before calling the meeting over.
    if ((s.phase === 'detected' || s.phase === 'recording') && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null
        if (meetingAppFor(this.micUsers, this.d.browserTitle())) return
        if (this.state.phase === 'recording') void this.stop('Meeting ended')
        else if (this.state.phase === 'detected') {
          this.state = { phase: 'idle', app: '', detectedAt: null, recordingSince: null, step: null }
          this.d.onChange()
        }
      }, this.state.phase === 'recording' ? 25_000 : 10_000)
    }
  }

  dismiss(): void {
    if (this.state.phase !== 'detected') return
    this.dismissedUntil = Date.now() + 30 * 60_000 // don't ask again for this call
    this.state = { phase: 'idle', app: '', detectedAt: null, recordingSince: null, step: null }
    this.d.onChange()
  }

  // ---- recording

  async record(appName?: string, opts?: RecordOptions): Promise<{ ok: boolean; message: string }> {
    if (this.d.isLocked()) return { ok: false, message: 'Kill switch is engaged.' }
    if (this.state.phase === 'recording') return { ok: true, message: 'Already recording.' }
    if (this.state.phase === 'processing') return { ok: false, message: 'Still finishing the last recording — try again in a moment.' }
    // It's a meeting only when a call app is actually using the microphone; otherwise it's a plain screen recording.
    const callApp = this.state.phase === 'detected' ? this.state.app : meetingAppFor(this.micUsers, this.d.browserTitle())
    const kind: MeetingRecord['kind'] = appName || callApp ? 'meeting' : 'screen'
    const app0 = appName || callApp || 'Screen'
    const started = new Date()
    const stamp = `${started.getFullYear()}-${String(started.getMonth() + 1).padStart(2, '0')}-${String(started.getDate()).padStart(2, '0')} ${String(started.getHours()).padStart(2, '0')}${String(started.getMinutes()).padStart(2, '0')}`
    let folder = join(app.getPath('videos'), 'Agentic Island', 'Meetings', `${stamp} ${app0.replace(/[\\/:*?"<>|()]/g, '').trim()}`)
    try {
      mkdirSync(folder, { recursive: true })
    } catch (err: any) {
      if (err?.code === 'EPERM' || err?.code === 'EACCES') {
        folder = join(app.getPath('userData'), 'meetings', `${stamp} ${app0.replace(/[\\/:*?"<>|()]/g, '').trim()}`)
        mkdirSync(folder, { recursive: true })
      } else {
        throw err
      }
    }
    const settings = this.d.settings()
    const rec: MeetingRecord = {
      id: randomUUID(),
      kind,
      app: app0,
      title: kind === 'screen' ? `Screen recording · ${started.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : `${app0} meeting`,
      startedAt: started.getTime(),
      endedAt: 0,
      folder,
      hasVideo: kind === 'screen' || settings.recordScreen,
      videoFile: null,
      status: 'recorded',
      language: null,
      summary: [],
      decisions: [],
      actionItems: []
    }
    const fd = openSync(join(folder, 'audio.wav'), 'w')
    writeSync(fd, wavHeader(0))
    // What to capture: the picker's choice, else the saved defaults.
    const o: RecordOptions = opts ?? { screens: settings.screens, systemAudio: settings.captureSystemAudio, mic: settings.captureMic }
    const all = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    let chosen = all.filter(x => o.screens.includes(x.display_id))
    const wantVideo = opts ? o.screens.length > 0 : rec.hasVideo
    const primaryId = String(eScreen.getPrimaryDisplay().id)
    if (wantVideo && !chosen.length) chosen = all.filter(x => x.display_id === primaryId).slice(0, 1).concat(all).slice(0, 1)
    // Computer sound comes with a screen capture; without video we still borrow the main screen for it and drop the picture.
    if (!wantVideo) chosen = o.systemAudio ? all.filter(x => x.display_id === primaryId).concat(all).slice(0, 1) : []
    if (!chosen.length && !o.mic) {
      closeSync(fd)
      return { ok: false, message: 'Choose at least a screen, computer sound or the microphone.' }
    }
    this.sourceQueue = chosen.map((source, i) => ({ id: source.id, audio: o.systemAudio && i === 0 }))
    rec.hasVideo = wantVideo && chosen.length > 0
    this.current = { rec, wav: { fd, bytes: 0 }, video: null, wantVideo: rec.hasVideo }

    this.recorder = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      webPreferences: {
        preload: join(__dirname, '../preload/recorder.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    if (process.env.ELECTRON_RENDERER_URL) await this.recorder.loadURL(`${process.env.ELECTRON_RENDERER_URL}/recorder.html`)
    else await this.recorder.loadFile(join(__dirname, '../renderer/recorder.html'))
    this.d.hideFromCapture(true)
    this.recorder.webContents.send('rec:start', { screens: chosen.length, video: rec.hasVideo, systemAudio: o.systemAudio, mic: o.mic })

    this.state = { phase: 'recording', app: app0, detectedAt: this.state.detectedAt, recordingSince: Date.now(), step: null }
    this.d.log('meeting.recording', `${kind} · ${app0} → ${folder}`)
    this.d.onChange()
    return { ok: true, message: kind === 'meeting' ? 'Recording — let everyone know the meeting is being recorded.' : 'Recording your screen.' }
  }

  async stop(reason: string): Promise<void> {
    if (this.state.phase !== 'recording' || !this.current) return
    const cur = this.current
    this.state = { ...this.state, phase: 'processing', step: 'Saving recording…' }
    this.d.onChange()
    // Ask the recorder to flush its last chunks, but never wait forever.
    await new Promise<void>(res => {
      this.stopped = res
      this.recorder?.webContents.send('rec:stop')
      setTimeout(res, 15_000)
    })
    this.stopped = null
    this.d.hideFromCapture(false)
    if (this.recorder && !this.recorder.isDestroyed()) this.recorder.destroy()
    this.recorder = null
    this.current = null
    // Finish the WAV header now that we know the length.
    writeSync(cur.wav.fd, wavHeader(cur.wav.bytes), 0, 44, 0)
    closeSync(cur.wav.fd)
    await new Promise<void>(res => (cur.video ? cur.video.end(() => res()) : res()))
    // MediaRecorder's fragmented MP4 can't be seeked — rewrite it as a normal MP4 (no re-encoding).
    if (cur.rec.videoFile?.endsWith('.mp4')) remuxFragmentedMp4(cur.rec.videoFile)
    const rec = cur.rec
    rec.endedAt = Date.now()
    this.list.unshift(rec)
    this.list = this.list.slice(0, 50)
    this.save()
    this.d.log('meeting.stopped', `${rec.app} · ${Math.round((rec.endedAt - rec.startedAt) / 60_000)} min · ${reason}`)
    if (!rec.videoFile && cur.wav.bytes < SAMPLE_RATE * 2 * 2) {
      rec.status = 'error'
      rec.error = 'The recording is too short or has no sound.'
      this.save()
      this.idle()
      return
    }
    void this.process(rec.id)
  }

  /** Kill switch: stop at once, keep what was recorded, don't upload anything. */
  emergencyStop(): void {
    // process() sees the lock and skips the upload — the file is just saved.
    if (this.state.phase === 'recording') void this.stop('Kill switch')
    else if (this.state.phase === 'detected') this.idle()
    this.stopWatching()
  }

  private idle(): void {
    this.state = { phase: 'idle', app: '', detectedAt: null, recordingSince: null, step: null }
    this.d.onChange()
  }

  // ---- transcribe + summarize

  /** `requested`: the user clicked "Transcribe & summarize" (screen recordings are never summarized on their own). */
  async process(id: string, requested = false): Promise<void> {
    const rec = this.list.find(m => m.id === id)
    if (!rec) return
    const s = this.d.settings()
    const key = this.d.geminiKey()
    const mins = Math.max(1, Math.round((rec.endedAt - rec.startedAt) / 60_000))
    if (rec.kind === 'screen' && !requested) {
      rec.status = 'recorded'
      this.save()
      this.idle()
      this.d.notify({ type: 'notify', kind: 'meeting-done', meetingId: rec.id, title: 'Screen recording saved', body: `${mins} min · ${rec.videoFile ? 'MP4 video' : 'audio'} in Videos\\Agentic Island` })
      return
    }
    if ((!s.summarize && !requested) || !key || this.d.isLocked()) {
      rec.status = 'recorded'
      this.save()
      this.idle()
      this.d.notify({
        type: 'notify',
        kind: 'meeting-done',
        meetingId: rec.id,
        title: 'Meeting recorded',
        body: key ? 'Saved. Summaries are off.' : 'Saved. Add a free Gemini key in Settings → Meetings to get summaries.'
      })
      return
    }
    rec.status = 'processing'
    rec.error = undefined
    this.state = { phase: 'processing', app: rec.app, detectedAt: null, recordingSince: null, step: 'Preparing…' }
    this.d.onChange()
    const step = (t: string) => {
      this.state = { ...this.state, step: t }
      this.d.onChange()
    }
    let uploaded: { name: string; uri: string } | null = null
    try {
      uploaded = await geminiUpload(key, join(rec.folder, 'audio.wav'), 'audio/wav', step)
      step('Writing the summary…')
      const j = JSON.parse(await geminiGenerate(key, s.geminiModel, uploaded.uri, SUMMARY_PROMPT(s.summaryLanguage === 'English' ? 'English' : 'the main language spoken in the meeting'), true))
      rec.title = String(j.title || rec.title).slice(0, 120)
      rec.language = j.language ? String(j.language).slice(0, 60) : null
      rec.summary = (Array.isArray(j.summary) ? j.summary : []).map(String).slice(0, 20)
      rec.decisions = (Array.isArray(j.decisions) ? j.decisions : []).map(String).slice(0, 20)
      rec.actionItems = (Array.isArray(j.action_items) ? j.action_items : []).slice(0, 30).map((a: { task?: string; owner?: string; due?: string }) => ({
        task: String(a.task ?? ''),
        owner: a.owner ? String(a.owner) : null,
        due: a.due ? String(a.due) : null
      }))
      step('Writing the transcript…')
      const transcript = await geminiGenerate(key, s.geminiModel, uploaded.uri, TRANSCRIPT_PROMPT, false)
      writeFileSync(join(rec.folder, 'transcript.txt'), transcript, 'utf8')
      writeFileSync(join(rec.folder, 'summary.md'), summaryMarkdown(rec), 'utf8')
      rec.status = 'done'
      this.d.log('meeting.summarized', `${rec.title} (${rec.language ?? '?'})`)
      this.d.notify({ type: 'notify', kind: 'meeting-done', meetingId: rec.id, title: 'Meeting summary ready', body: rec.title })
    } catch (e) {
      rec.status = 'error'
      rec.error = (e as Error).message.slice(0, 300)
      this.d.log('meeting.error', rec.error)
      this.d.notify({ type: 'notify', kind: 'meeting-done', meetingId: rec.id, title: 'Could not summarize the meeting', body: rec.error })
    } finally {
      // Remove the uploaded copy from Google right away.
      if (uploaded) await fetch(`${GEMINI}/v1beta/${uploaded.name}`, { method: 'DELETE', headers: { 'x-goog-api-key': key } }).catch(() => {})
      this.save()
      this.idle()
    }
  }

  get(id: string): MeetingRecord | null {
    const m = this.list.find(x => x.id === id)
    if (!m) return null
    let transcript: string | undefined
    try {
      transcript = readFileSync(join(m.folder, 'transcript.txt'), 'utf8')
    } catch {
      /* not transcribed yet */
    }
    return { ...m, transcript }
  }

  open(id: string): void {
    const m = this.list.find(x => x.id === id)
    if (!m) return
    const target = m.videoFile && existsSync(m.videoFile) ? m.videoFile : join(m.folder, 'audio.wav')
    if (existsSync(target)) shell.showItemInFolder(target)
    else if (existsSync(m.folder)) void shell.openPath(m.folder)
  }

  play(id: string): void {
    const m = this.list.find(x => x.id === id)
    const f = m?.videoFile && existsSync(m.videoFile) ? m.videoFile : m ? join(m.folder, 'audio.wav') : null
    // Recordings made before the seek fix are made seekable the first time they're played (no-op if already fine).
    if (f?.endsWith('.mp4') && existsSync(f)) remuxFragmentedMp4(f)
    if (f && existsSync(f)) void shell.openPath(f)
  }

  remove(id: string): void {
    const m = this.list.find(x => x.id === id)
    if (!m) return
    try {
      if (existsSync(m.folder) && statSync(m.folder).isDirectory()) rmSync(m.folder, { recursive: true, force: true })
    } catch {
      /* file in use */
    }
    this.list = this.list.filter(x => x.id !== id)
    this.save()
    this.d.log('meeting.deleted', m.title)
    this.d.onChange()
  }
}

export function summaryMarkdown(m: MeetingRecord): string {
  const when = new Date(m.startedAt).toLocaleString()
  const mins = Math.max(1, Math.round((m.endedAt - m.startedAt) / 60_000))
  const list = (xs: string[]) => (xs.length ? xs.map(x => `- ${x}`).join('\n') : '- (none)')
  const actions = m.actionItems.length
    ? m.actionItems.map(a => `- [ ] ${a.task}${a.owner ? ` — **${a.owner}**` : ''}${a.due ? ` (due ${a.due})` : ''}`).join('\n')
    : '- (none)'
  return `# ${m.title}\n\n${m.app} · ${when} · ${mins} min${m.language ? ` · ${m.language}` : ''}\n\n## Summary\n${list(m.summary)}\n\n## Decisions\n${list(m.decisions)}\n\n## Action items\n${actions}\n`
}

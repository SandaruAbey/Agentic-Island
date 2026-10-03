import { useEffect, useState } from 'react'
import type { IslandSnapshot, MeetingRecord, ScreenSource } from '@shared/types'
import { Icon, Shimmer, Toggle, cleanErr, timeAgo } from '../components/ui'

export const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function MeetingsPanel({ snap, initialId, onTyping }: { snap: IslandSnapshot; initialId?: string | null; onTyping: (v: boolean) => void }) {
  const [openId, setOpenId] = useState<string | null>(initialId ?? null)
  const [picking, setPicking] = useState(false)
  const [, tick] = useState(0)
  const m = snap.meeting
  const s = snap.settings.meetings
  useEffect(() => {
    if (m.phase !== 'recording') return
    const t = window.setInterval(() => tick(x => x + 1), 1000)
    return () => window.clearInterval(t)
  }, [m.phase])

  if (openId) return <MeetingDetail id={openId} onBack={() => setOpenId(null)} snap={snap} />

  return (
    <div className="meetings">
      {/* Live status */}
      <div className={`meet-live ${m.phase}`}>
        <div>
          <strong>
            {m.phase === 'recording'
              ? `● Recording ${m.app} · ${fmtDuration(Date.now() - (m.recordingSince ?? Date.now()))}`
              : m.phase === 'processing'
                ? `Summarizing ${m.app}…`
                : m.phase === 'detected'
                  ? `Meeting in ${m.app}`
                  : 'Not recording'}
          </strong>
          <span className="muted small">
            {m.phase === 'recording'
              ? 'Your screen and sound are being recorded (Isla itself is hidden from the video).'
              : m.phase === 'processing'
                ? <Shimmer icon="spark">{m.step ?? 'Working…'}</Shimmer>
                : s.autoDetect
                  ? 'Record your screen any time. In a Teams / Zoom / Meet call Isla asks first, and summarizes the meeting when it ends.'
                  : 'Record your screen any time. Meeting detection is off.'}
          </span>
        </div>
        {m.phase === 'recording' ? (
          <button className="btn red" onClick={() => void window.island.meetingStop()}>
            <Icon name="stop" size={13} /> Stop & summarize
          </button>
        ) : m.phase === 'processing' ? (
          <span className="spinner" aria-label="Working" />
        ) : (
          <button className="btn red ghost-red" onClick={() => setPicking(p => !p)}>
            <Icon name="rec" size={13} /> {m.phase === 'detected' ? 'Record this meeting…' : 'Record…'}
          </button>
        )}
      </div>

      {picking && m.phase !== 'recording' && m.phase !== 'processing' && <RecordPicker snap={snap} onClose={() => setPicking(false)} />}

      {!s.hasGeminiKey && <GeminiKeySetup onTyping={onTyping} />}

      <div className="meet-settings">
        <label>
          <Toggle label="Ask to record when a meeting starts" checked={s.autoDetect} onChange={v => void window.island.updateSettings({ meetings: { autoDetect: v } })} />
          <span>Ask when a meeting starts</span>
        </label>
        <label>
          <Toggle label="Record the screen too" checked={s.recordScreen} onChange={v => void window.island.updateSettings({ meetings: { recordScreen: v } })} />
          <span>Record video in meetings</span>
        </label>
        <label>
          <Toggle label="Summarize meetings" checked={s.summarize} onChange={v => void window.island.updateSettings({ meetings: { summarize: v } })} />
          <span>Summarize meetings automatically</span>
        </label>
        <label>
          <select value={s.summaryLanguage} onChange={e => void window.island.updateSettings({ meetings: { summaryLanguage: e.target.value as 'English' | 'meeting' } })}>
            <option value="English">Summary in English</option>
            <option value="meeting">Summary in the meeting’s language</option>
          </select>
        </label>
      </div>

      <h3 className="label">Recordings</h3>
      {snap.meetingList.length === 0 ? (
        <div className="empty">No recordings yet. Click “Record screen”, or join a call.</div>
      ) : (
        <ul className="meet-list">
          {snap.meetingList.map(r => (
            <li key={r.id}>
              <button onClick={() => setOpenId(r.id)}>
                <span className={`meet-badge ${r.status} ${r.kind}`}>
                  {r.status === 'done' ? 'Summary' : r.status === 'processing' ? <Shimmer tint>Working…</Shimmer> : r.status === 'error' ? 'Failed' : r.kind === 'screen' ? 'Video' : 'Meeting'}
                </span>
                <strong>{r.title}</strong>
                <span className="muted small">
                  {r.kind === 'screen' ? 'Screen' : r.app} · {timeAgo(r.startedAt)} · {fmtDuration(r.endedAt - r.startedAt)}
                  {r.language ? ` · ${r.language}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        Saved as MP4 in <code>Videos\Agentic Island\Meetings</code>. Audio goes to Google Gemini only to transcribe and summarize (meetings, or when you
        ask), and the uploaded copy is deleted right after.
      </p>
    </div>
  )
}

/** "What should I record?" — screens (one or several), computer sound, microphone. Remembered for next time. */
function RecordPicker({ snap, onClose }: { snap: IslandSnapshot; onClose: () => void }) {
  const s = snap.settings.meetings
  const [screens, setScreens] = useState<ScreenSource[] | null>(null)
  const [picked, setPicked] = useState<string[]>(s.screens)
  const [systemAudio, setSystemAudio] = useState(s.captureSystemAudio)
  const [mic, setMic] = useState(s.captureMic)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    void window.island.listScreens().then(list => {
      setScreens(list)
      // Default: last choice if those screens still exist, else the main screen.
      const valid = s.screens.filter(id => list.some(x => x.displayId === id))
      setPicked(valid.length ? valid : list.filter(x => x.primary).map(x => x.displayId).slice(0, 1))
    })
  }, [])
  const toggle = (id: string) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))
  const nothing = !picked.length && !systemAudio && !mic

  return (
    <div className="rec-picker">
      <div className="row-between">
        <strong>What should I record?</strong>
        <button className="icon-btn subtle" title="Close" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="screen-grid">
        {screens === null ? (
          <Shimmer className="small">Looking for screens…</Shimmer>
        ) : (
          screens.map(sc => (
            <button key={sc.displayId} className={`screen-opt ${picked.includes(sc.displayId) ? 'on' : ''}`} onClick={() => toggle(sc.displayId)}>
              <img src={sc.thumbnail} alt="" draggable={false} />
              <span>
                <i className="tick">{picked.includes(sc.displayId) ? '✓' : ''}</i>
                {sc.name}
                {sc.width ? <em> · {sc.width}×{sc.height}</em> : null}
              </span>
            </button>
          ))
        )}
      </div>
      {screens && screens.length > 1 && <p className="muted small">Pick several screens to record them side by side in one video.</p>}
      <div className="rec-sound">
        <label>
          <Toggle label="Computer sound" checked={systemAudio} onChange={setSystemAudio} />
          <span>
            <b>Computer sound</b> — what you hear (people in a call, videos)
          </span>
        </label>
        <label>
          <Toggle label="Microphone" checked={mic} onChange={setMic} />
          <span>
            <b>Microphone</b> — your voice
          </span>
        </label>
      </div>
      {msg && <div className="alert error">{msg}</div>}
      <div className="actions">
        <span className="muted small">{!picked.length && !nothing ? 'No screen picked — sound only.' : ''}</span>
        <span className="spacer" />
        <button
          className="btn red"
          disabled={nothing}
          onClick={async () => {
            const r = await window.island.meetingRecord({ screens: picked, systemAudio, mic }).catch(e => ({ ok: false, message: cleanErr(e) }))
            if (r.ok) onClose()
            else setMsg(r.message)
          }}
        >
          <Icon name="rec" size={13} /> Start recording
        </button>
      </div>
    </div>
  )
}

function GeminiKeySetup({ onTyping }: { onTyping: (v: boolean) => void }) {
  const [key, setKey] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="gemini-setup">
      <strong>Turn on meeting summaries (free)</strong>
      <p className="muted small">
        Gemini understands Sinhala, Tamil, English and most other languages. Create a free API key, paste it here — it’s stored encrypted on this PC.
      </p>
      <div className="inline">
        <button className="btn ghost sm" onClick={() => void window.island.openUrl('https://aistudio.google.com/apikey')}>
          Get a free key ↗
        </button>
        <input
          type="password"
          value={key}
          placeholder="Paste your Gemini API key"
          autoComplete="off"
          spellCheck={false}
          onFocus={() => onTyping(true)}
          onBlur={() => onTyping(false)}
          onChange={e => setKey(e.target.value)}
        />
        <button
          className="btn primary sm"
          disabled={!key.trim() || busy}
          onClick={async () => {
            setBusy(true)
            const r = await window.island.setGeminiKey(key).catch(e => ({ ok: false, message: cleanErr(e) }))
            setBusy(false)
            setMsg({ ok: r.ok, text: r.message })
            if (r.ok) setKey('')
          }}
        >
          {busy ? 'Checking…' : 'Save'}
        </button>
      </div>
      {msg && <div className={`alert ${msg.ok ? 'info' : 'error'}`}>{msg.text}</div>}
    </div>
  )
}

function MeetingDetail({ id, onBack, snap }: { id: string; onBack: () => void; snap: IslandSnapshot }) {
  const [rec, setRec] = useState<MeetingRecord | null>(null)
  const [tab, setTab] = useState<'summary' | 'transcript'>('summary')
  const [copied, setCopied] = useState(false)
  const live = snap.meetingList.find(x => x.id === id)
  useEffect(() => {
    void window.island.getMeeting(id).then(setRec)
  }, [id, live?.status])
  if (!rec) return <div className="empty"><Shimmer>Loading…</Shimmer></div>

  const asText = () =>
    [
      rec.title,
      '',
      'Summary:',
      ...rec.summary.map(x => `• ${x}`),
      '',
      'Decisions:',
      ...(rec.decisions.length ? rec.decisions.map(x => `• ${x}`) : ['• (none)']),
      '',
      'Action items:',
      ...(rec.actionItems.length ? rec.actionItems.map(a => `[ ] ${a.task}${a.owner ? ` — ${a.owner}` : ''}${a.due ? ` (due ${a.due})` : ''}`) : ['[ ] (none)'])
    ].join('\n')

  return (
    <div className="meet-detail">
      <div className="reader-head">
        <button className="icon-btn" title="Back" onClick={onBack}>
          <Icon name="back" size={15} />
        </button>
        <div className="reader-meta">
          <strong className="reader-subject">{rec.title}</strong>
          <span className="muted small">
            {rec.app} · {new Date(rec.startedAt).toLocaleString()} · {fmtDuration(rec.endedAt - rec.startedAt)}
            {rec.language ? ` · ${rec.language}` : ''}
          </span>
        </div>
      </div>
      <div className="reader-actions">
        <button className="btn primary sm" onClick={() => void window.island.playMeetingVideo(rec.id)}>
          <Icon name="play" size={12} /> {rec.videoFile ? 'Play video' : 'Play audio'}
        </button>
        <button className="btn ghost sm" onClick={() => void window.island.openMeetingFolder(rec.id)}>
          <Icon name="folder" size={12} /> Show in folder
        </button>
        {rec.status === 'done' && (
          <button
            className="btn ghost sm"
            onClick={() =>
              void window.island.copyText(asText()).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }
          >
            <Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'Copied' : 'Copy summary'}
          </button>
        )}
        {(rec.status === 'error' || rec.status === 'recorded') && (
          <button
            className="btn ghost sm"
            disabled={!snap.settings.meetings.hasGeminiKey}
            title={snap.settings.meetings.hasGeminiKey ? 'Transcript + summary with Gemini' : 'Add a free Gemini key first'}
            onClick={() => void window.island.meetingRetry(rec.id)}
          >
            <Icon name="spark" size={12} /> Transcribe & summarize
          </button>
        )}
        <span className="spacer" />
        <button
          className="btn ghost sm"
          onClick={() => {
            if (confirm('Delete this meeting and its recording files?')) void window.island.deleteMeeting(rec.id).then(onBack)
          }}
        >
          Delete
        </button>
      </div>
      {rec.status === 'error' && <div className="alert error">{rec.error}</div>}
      {rec.status === 'processing' && <div className="alert info">{snap.meeting.step ?? 'Summarizing…'}</div>}
      {rec.status === 'recorded' && rec.kind === 'meeting' && !snap.settings.meetings.hasGeminiKey && (
        <div className="alert info">Recorded. Add a free Gemini key (Recordings tab) to get the transcript and summary.</div>
      )}
      {rec.status === 'done' && (
        <>
          <div className="segmented" role="radiogroup">
            <button className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>
              Summary
            </button>
            <button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>
              Transcript
            </button>
          </div>
          {tab === 'summary' ? (
            <div className="meet-summary">
              <h4>Summary</h4>
              <ul>{rec.summary.map((x, i) => <li key={i}>{x}</li>)}</ul>
              <h4>Decisions</h4>
              {rec.decisions.length ? <ul>{rec.decisions.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="muted small">None recorded.</p>}
              <h4>Action items</h4>
              {rec.actionItems.length ? (
                <ul className="actions-list">
                  {rec.actionItems.map((a, i) => (
                    <li key={i}>
                      <span>[ ] {a.task}</span>
                      {a.owner && <b>{a.owner}</b>}
                      {a.due && <em>{a.due}</em>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">None.</p>
              )}
            </div>
          ) : (
            <pre className="reader-body">{rec.transcript ?? '(No transcript.)'}</pre>
          )}
        </>
      )}
    </div>
  )
}

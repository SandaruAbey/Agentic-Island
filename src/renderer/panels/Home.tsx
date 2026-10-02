import { useEffect, useRef, useState } from 'react'
import type { AskContext, AskResult, IslandSnapshot, MediaState, PanelId, Suggestion } from '@shared/types'
import { NowPlaying } from '../components/Media'
import { actOn, actionLabel } from '../suggest'
import { Icon, Segmented, cleanErr, joinLabel, shortPath, timeUntil } from '../components/ui'
import { RunCard } from './Agent'
import { Markdown } from '../components/Markdown'
import { MailList, MailReader } from './Mail'

type Turn = { id: number; q: string | null; result: AskResult }

/** Home is rebuilt every time the island opens: keep the conversation, its thread and the unsent draft here. */
const memo: { convo: Turn[]; threadId: string | null; prompt: string; seq: number; focus: string | null } = {
  convo: [],
  threadId: null,
  prompt: '',
  seq: 0,
  focus: null
}

const EXAMPLES: Record<AskContext, string[]> = {
  general: ['Summarize this email', 'Draft a reply to this', 'Find my CV on this PC', 'Open YouTube and find lofi music'],
  project: ['Explain what changed today', 'Review my uncommitted changes', 'Write tests for the last change'],
  computer: ['Go and read my emails and tell me what matters', 'Find my CV on this PC', 'Open YouTube and find lofi music']
}

export function HomePanel({
  snap,
  open,
  onTyping,
  openMail,
  focusRun,
  media
}: {
  snap: IslandSnapshot
  open: (p: PanelId) => void
  onTyping: (v: boolean) => void
  openMail: (uid: string) => void
  focusRun?: string | null
  media?: MediaState | null
}) {
  const s = snap.settings
  const [ctx, setCtx] = useState<'general' | 'project'>(() => (snap.activity?.kind === 'ide' && s.activeWorkspace ? 'project' : 'general'))
  const computerOn = s.computer.enabled
  const [prompt, setPrompt] = useState(memo.prompt)
  const [busy, setBusy] = useState(false)
  // The conversation on Home: each question with its answer. Follow-ups continue the same thread.
  const [convo, setConvo] = useState<Turn[]>(memo.convo)
  const [threadId, setThreadId] = useState<string | null>(memo.threadId)
  const turnSeq = useRef(memo.seq)
  useEffect(() => {
    memo.convo = convo
    memo.threadId = threadId
    memo.prompt = prompt
    memo.seq = turnSeq.current
  }, [convo, threadId, prompt])
  const [info, setInfo] = useState<string | null>(null)
  const locked = snap.security.locked
  const endRef = useRef<HTMLDivElement>(null)

  const push = (q: string | null, result: AskResult, fresh = false) => {
    const turn = { id: ++turnSeq.current, q, result }
    setConvo(c => (fresh ? [turn] : [...c, turn].slice(-20)))
    if (result.type === 'run') setThreadId(t => (fresh || !t ? (result.run.threadId ?? result.run.id) : t))
    else if (fresh) setThreadId(null)
    window.setTimeout(() => endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60)
  }
  const newChat = () => {
    setConvo([])
    setThreadId(null)
    setInfo(null)
  }

  // A proactive suggestion was run from the island peek — show its answer here as a new conversation.
  useEffect(() => {
    // Only once per suggestion — not again every time the island reopens.
    if (!focusRun || memo.focus === focusRun) return
    memo.focus = focusRun
    const run = snap.runs.find(r => r.id === focusRun)
    if (run) push(run.title, { type: 'run', run }, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRun])

  const projectProvider = snap.providers.find(p => p.id === s.activeProvider)
  const generalProvider = snap.providers.find(p => p.id === snap.assistantProvider)
  const provider = ctx === 'project' ? projectProvider : generalProvider
  const model = provider ? s.providers[provider.id].model : ''
  const mode = ctx === 'project' ? s.providers[s.activeProvider].mode : 'readonly'

  const submit = async (text = prompt) => {
    if (!text.trim() || busy) return
    setBusy(true)
    setInfo(null)
    try {
      const r = await window.island.ask(text, ctx, threadId)
      push(text.trim(), r)
      if (r.type !== 'error') setPrompt('')
    } catch (e) {
      push(text.trim(), { type: 'error', message: cleanErr(e) })
    } finally {
      setBusy(false)
    }
  }

  const [askFor, setAskFor] = useState<string | null>(null)
  const [askText, setAskText] = useState('')
  const act = async (sug: Suggestion, request?: string) => {
    setInfo(null)
    if (sug.action.type === 'do' && sug.action.askUser && !request) {
      setAskFor(sug.id)
      return
    }
    setAskFor(null)
    setAskText('')
    const out = await actOn(sug, snap, request)
    if (out.kind === 'run') push(sug.title, { type: 'run', run: out.run }, true)
    else if (out.kind === 'ask') push(sug.title, out.result, true)
    else if (out.kind === 'panel') open(out.panel)
    else if (out.kind === 'info') setInfo(out.text)
    else if (out.kind === 'error') push(sug.title, { type: 'error', message: out.text }, true)
  }

  // Runs shown in the conversation stay live from the snapshot; everything else still working is listed below.
  const convoRunIds = new Set(convo.flatMap(t => (t.result.type === 'run' ? [t.result.run.id] : [])))
  useEffect(() => {
    // While a message is being sent its own run is not in the conversation yet — don't add it twice.
    if (!threadId || busy) return
    const extra = snap.runs.filter(r => r.threadId === threadId && !convoRunIds.has(r.id)).reverse()
    for (const r of extra) push(null, { type: 'run', run: r })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.runs, threadId, busy])
  const activeRuns = snap.runs.filter(r => (r.status === 'running' || r.status === 'pending-approval') && !convoRunIds.has(r.id))
  const [openRun, setOpenRun] = useState<string | null>(null)
  const reminders = snap.reminders ?? []
  const following = convo.length > 0 && !!threadId

  const composer = (
    <div className={`composer ${locked ? 'disabled' : ''} ${convo.length ? 'in-convo' : ''}`}>
      <textarea
        value={prompt}
        disabled={locked}
        placeholder={
          locked
            ? 'Kill switch engaged — resume to use Isla'
            : following
              ? 'Reply to Isla — ask a follow-up, or anything else…'
              : ctx !== 'project'
                ? computerOn
                  ? 'Ask Isla anything, or tell it what to do — “summarize my inbox”, “find my CV”, “open YouTube…”'
                  : 'Ask Isla anything — “read my last mail”, “summarize my inbox”, “explain this error”…'
                : `Ask ${projectProvider?.label ?? 'your agent'} about ${s.activeWorkspace ? shortPath(s.activeWorkspace) : 'your project'}…`
        }
        rows={2}
        onFocus={() => onTyping(true)}
        onBlur={() => onTyping(false)}
        onChange={e => setPrompt(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <div className="composer-bar">
        {following ? (
          <span className="chip" title="Follow-ups keep the earlier questions and answers as context">
            <Icon name="chat" size={12} /> Continuing this chat
          </span>
        ) : (
          <Segmented
            value={ctx}
            onChange={setCtx}
            options={[
              { value: 'general', label: 'General' },
              { value: 'project', label: 'Project' }
            ]}
          />
        )}
        <button className="chip" onClick={() => open('settings')} title="Change agent / model">
          <span className={`dot ${provider?.installed ? 'green' : 'red'}`} />
          {provider ? provider.label : 'No background agent'}
          {provider?.headless && <em>{model || 'default model'}</em>}
        </button>
        {!following && ctx === 'project' && (
          <button className="chip" onClick={() => open('git')} title="Workspace">
            <Icon name="folder" size={12} /> {s.activeWorkspace ? shortPath(s.activeWorkspace) : 'No workspace'}
          </button>
        )}
        {!following && (
          <span
            className={`chip ${mode === 'edit' ? 'warn' : ''}`}
            title={ctx !== 'project' && computerOn ? 'Answers are read-only. Anything done on your PC waits for your approval first.' : undefined}
          >
            {mode === 'edit' ? 'Can edit' : ctx !== 'project' && computerOn ? 'Asks before acting' : 'Read-only'}
          </span>
        )}
        {computerOn && ctx !== 'project' && (
          <button className="chip" onClick={() => void window.island.showBrowser(true)} title="Open Isla’s own browser — watch a task, or sign in to a site once">
            <Icon name="eye" size={12} /> Browser
          </button>
        )}
        <span className="spacer" />
        <button className="btn primary round" disabled={locked || !prompt.trim() || busy} onClick={() => void submit()}>
          <Icon name={ctx === 'project' && projectProvider?.headless === false ? 'play' : 'send'} size={14} />
          {busy ? '…' : following ? 'Reply' : ctx === 'project' && projectProvider?.headless === false ? 'Open' : 'Ask'}
        </button>
      </div>
    </div>
  )

  return (
    <div className="home">
      {media && <NowPlaying m={media} />}
      {(snap.alerts ?? []).map(a => (
        <div key={a.id} className={`alert-ring ${a.kind}`}>
          <span className="alert-ring-ico">
            <Icon name={a.kind === 'meeting' ? 'chat' : 'clock'} size={16} />
          </span>
          <div className="alert-ring-text">
            <strong>{a.title}</strong>
            <span>{a.kind === 'meeting' ? 'Meeting starting now' : a.kind === 'alarm' ? 'Alarm' : 'Reminder'} · {new Date(a.targetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          </div>
          {a.url && (
            <button className="btn green sm" onClick={() => void window.island.ackReminder(a.id, 'open')}>
              {joinLabel(a.url)}
            </button>
          )}
          <button className="btn ghost sm" onClick={() => void window.island.ackReminder(a.id, 'snooze')}>
            Snooze 5m
          </button>
          <button className="icon-btn" title="Done" onClick={() => void window.island.ackReminder(a.id, 'done')}>
            <Icon name="check" size={14} />
          </button>
        </div>
      ))}
      {!convo.length && composer}

      {!convo.length && !locked && (
        <div className="examples">
          {EXAMPLES[ctx].map(x => (
            <button key={x} className="chip" onClick={() => void submit(x)}>
              {x}
            </button>
          ))}
        </div>
      )}

      {info && <div className="alert info">{info}</div>}
      {convo.length > 0 && (
        <div className="answer convo">
          <div className="row-between convo-head">
            <h3 className="label">{following ? 'Conversation' : 'Answer'}</h3>
            <button className="link" onClick={newChat} title="Start over">
              <Icon name="close" size={12} /> New chat
            </button>
          </div>
          {convo.map(turn => (
            <div className="turn" key={turn.id}>
              {turn.q ? (
                <div className="chat-q">{turn.q}</div>
              ) : (
                turn.result.type === 'run' && (
                  <div className="chat-handoff">
                    <Icon name="spark" size={12} /> Isla set up a task: <b>{turn.result.run.title}</b>
                  </div>
                )
              )}
              <TurnResult result={turn.result} snap={snap} open={open} openMail={openMail} setInfo={setInfo} />
            </div>
          ))}
          <div ref={endRef} />
          {composer}
        </div>
      )}

      {snap.pendingActions.length > 0 && (
        <>
          <h3 className="label">Needs your OK · {snap.pendingActions.length}</h3>
          <ul className="suggestions">
            {snap.pendingActions.map(a => (
              <li key={a.id}>
                <span className="sug-icon warn">
                  <Icon name="shield" size={15} />
                </span>
                <div className="sug-main">
                  <strong>{a.summary}</strong>
                  <span>
                    {a.reason} · {a.runTitle}
                  </span>
                </div>
                <button className="btn green sm" onClick={() => void window.island.decideAction(a.id, true)}>
                  Allow
                </button>
                <button className="btn red sm" onClick={() => void window.island.decideAction(a.id, false)}>
                  Deny
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {activeRuns.length > 0 && (
        <>
          <div className="row-between">
            <h3 className="label">Running now · {activeRuns.length}</h3>
            <button className="link" onClick={() => open('agent')}>
              All tasks
            </button>
          </div>
          <div className="runs">
            {activeRuns.map(r => (
              <RunCard key={r.id} run={r} snap={snap} open={openRun === r.id} onToggle={() => setOpenRun(openRun === r.id ? null : r.id)} />
            ))}
          </div>
        </>
      )}

      {reminders.length > 0 && (
        <>
          <h3 className="label">Reminders · {reminders.length}</h3>
          <ul className="suggestions reminders">
            {reminders.map(r => (
              <li key={r.id}>
                <span className={`sug-icon ${r.kind === 'meeting' ? 'spark' : 'clock'}`}>
                  <Icon name={r.kind === 'meeting' ? 'chat' : 'clock'} size={15} />
                </span>
                <div className="sug-main">
                  <strong>{r.title}</strong>
                  <span>
                    {r.kind === 'meeting' ? 'Meeting' : r.kind === 'alarm' ? 'Alarm' : 'Reminder'} ·{' '}
                    {new Date(r.targetAt).toLocaleString([], { weekday: new Date(r.targetAt).toDateString() === new Date().toDateString() ? undefined : 'short', hour: 'numeric', minute: '2-digit' })}{' '}
                    · {timeUntil(r.targetAt)}
                  </span>
                </div>
                {r.url && (
                  <button className="btn ghost sm sug-act" onClick={() => void window.island.openUrl(r.url!)}>
                    Open link
                  </button>
                )}
                <button className="icon-btn subtle" title="Delete reminder" onClick={() => void window.island.deleteReminder(r.id)}>
                  <Icon name="close" size={13} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="label">Up next</h3>
      {snap.suggestions.length === 0 ? (
        <div className="empty">
          {locked
            ? 'Paused. Nothing is running.'
            : 'All caught up. Isla is keeping an eye on things.'}
        </div>
      ) : (
        <ul className="suggestions">
          {snap.suggestions.map(sug => (
            <li key={sug.id}>
              <span className={`sug-icon ${sug.icon}`}>
                <Icon name={sug.icon} size={15} />
              </span>
              <button className="sug-main" onClick={() => void act(sug)}>
                <strong>{sug.title}</strong>
                <span>{sug.detail}</span>
              </button>
              <button className="btn ghost sm sug-act" onClick={() => void act(sug)}>
                {actionLabel(sug)}
              </button>
              <button className="icon-btn subtle" title="Dismiss" onClick={() => void window.island.dismissSuggestion(sug.id)}>
                <Icon name="close" size={13} />
              </button>
              {askFor === sug.id && sug.action.type === 'do' && sug.action.askUser && (
                <form
                  className="sug-ask"
                  onSubmit={e => {
                    e.preventDefault()
                    if (askText.trim()) void act(sug, askText.trim())
                  }}
                >
                  <input
                    autoFocus
                    value={askText}
                    placeholder={sug.action.askUser}
                    onFocus={() => onTyping(true)}
                    onBlur={() => onTyping(false)}
                    onChange={e => setAskText(e.target.value)}
                  />
                  <button className="btn primary sm" type="submit" disabled={!askText.trim()}>
                    <Icon name="send" size={12} /> Go
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** One answer in the conversation: a chat reply, mail, a code, or a live agent run. */
function TurnResult({
  result,
  snap,
  open,
  openMail,
  setInfo
}: {
  result: AskResult
  snap: IslandSnapshot
  open: (p: PanelId) => void
  openMail: (uid: string) => void
  setInfo: (v: string | null) => void
}) {
  switch (result.type) {
    case 'error':
      return <div className="alert error">{result.message}</div>
    case 'opened':
      return <div className="alert info">{result.message}</div>
    case 'chat':
      return (
        <div className="chat-reply md">
          <Markdown text={result.text} previews />
        </div>
      )
    case 'mail':
      return <MailReader message={result.message} open={open} />
    case 'mail-list':
      return (
        <>
          <h3 className="label">{result.title}</h3>
          <MailList messages={result.messages} onOpen={openMail} />
        </>
      )
    case 'otp':
      return result.otp ? (
        <div className="otp">
          <div className="otp-meta">
            <strong>{result.otp.from}</strong>
            <span className="muted">{result.otp.subject}</span>
          </div>
          <code className="otp-code">{result.otp.code}</code>
          <button className="btn primary round" onClick={() => void window.island.copyOtp(result.otp!.id).then(() => setInfo('Copied — the clipboard clears automatically.'))}>
            <Icon name="copy" size={14} /> Copy
          </button>
        </div>
      ) : (
        <div className="empty">{'No verification code in the last 10 minutes.'}</div>
      )
    case 'run': {
      const live = snap.runs.find(r => r.id === result.run.id) ?? result.run
      return <RunCard run={live} snap={snap} open chat />
    }
  }
}

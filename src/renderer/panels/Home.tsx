import { useEffect, useState } from 'react'
import type { AskResult, IslandSnapshot, MediaState, PanelId, RunContext, Suggestion } from '@shared/types'
import { NowPlaying } from '../components/Media'
import { actOn, actionLabel } from '../suggest'
import { Icon, Segmented, cleanErr, shortPath } from '../components/ui'
import { RunCard } from './Agent'
import { MailList, MailReader } from './Mail'

const EXAMPLES: Record<RunContext, string[]> = {
  general: ['Read my last mail', 'Any unread emails?', 'Summarize my inbox', 'Copy my verification code'],
  project: ['Explain what changed today', 'Review my uncommitted changes', 'Write tests for the last change']
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
  const [ctx, setCtx] = useState<RunContext>(() => (snap.activity?.kind === 'ide' && s.activeWorkspace ? 'project' : 'general'))
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AskResult | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const locked = snap.security.locked

  // A proactive suggestion was run from the island peek — show its answer here.
  useEffect(() => {
    const run = focusRun && snap.runs.find(r => r.id === focusRun)
    if (run) setResult({ type: 'run', run })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRun])

  const projectProvider = snap.providers.find(p => p.id === s.activeProvider)
  const generalProvider = snap.providers.find(p => p.id === snap.assistantProvider)
  const provider = ctx === 'general' ? generalProvider : projectProvider
  const model = provider ? s.providers[provider.id].model : ''
  const mode = ctx === 'general' ? 'readonly' : s.providers[s.activeProvider].mode

  const submit = async (text = prompt) => {
    if (!text.trim() || busy) return
    setBusy(true)
    setInfo(null)
    try {
      const r = await window.island.ask(text, ctx)
      setResult(r)
      if (r.type !== 'error') setPrompt('')
    } catch (e) {
      setResult({ type: 'error', message: cleanErr(e) })
    } finally {
      setBusy(false)
    }
  }

  const act = async (sug: Suggestion) => {
    setInfo(null)
    const out = await actOn(sug, snap)
    if (out.kind === 'run') setResult({ type: 'run', run: out.run })
    else if (out.kind === 'ask') setResult(out.result)
    else if (out.kind === 'panel') open(out.panel)
    else if (out.kind === 'info') setInfo(out.text)
    else if (out.kind === 'error') setResult({ type: 'error', message: out.text })
  }

  // Keep the inline run card live from the snapshot.
  const liveRun = result?.type === 'run' ? (snap.runs.find(r => r.id === result.run.id) ?? result.run) : null

  return (
    <div className="home">
      {media && <NowPlaying m={media} />}
      <div className={`composer ${locked ? 'disabled' : ''}`}>
        <textarea
          value={prompt}
          disabled={locked}
          placeholder={
            locked
              ? 'Kill switch engaged — resume to use Isla'
              : ctx === 'general'
                ? 'Ask Isla anything — “read my last mail”, “summarize my inbox”, “explain this error”…'
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
          <Segmented
            value={ctx}
            onChange={setCtx}
            options={[
              { value: 'general', label: 'General' },
              { value: 'project', label: 'Project' }
            ]}
          />
          <button className="chip" onClick={() => open('settings')} title="Change agent / model">
            <span className={`dot ${provider?.installed ? 'green' : 'red'}`} />
            {provider ? provider.label : 'No background agent'}
            {provider?.headless && <em>{model || 'default model'}</em>}
          </button>
          {ctx === 'project' && (
            <button className="chip" onClick={() => open('git')} title="Workspace">
              <Icon name="folder" size={12} /> {s.activeWorkspace ? shortPath(s.activeWorkspace) : 'No workspace'}
            </button>
          )}
          <span className={`chip ${mode === 'edit' ? 'warn' : ''}`}>{mode === 'edit' ? 'Can edit' : 'Read-only'}</span>
          <span className="spacer" />
          <button className="btn primary round" disabled={locked || !prompt.trim() || busy} onClick={() => void submit()}>
            <Icon name={ctx === 'project' && projectProvider?.headless === false ? 'play' : 'send'} size={14} />
            {busy ? '…' : ctx === 'project' && projectProvider?.headless === false ? 'Open' : 'Ask'}
          </button>
        </div>
      </div>

      {!result && !locked && (
        <div className="examples">
          {EXAMPLES[ctx].map(x => (
            <button key={x} className="chip" onClick={() => void submit(x)}>
              {x}
            </button>
          ))}
        </div>
      )}

      {info && <div className="alert info">{info}</div>}
      {result && (
        <div className="answer">
          <button className="icon-btn subtle answer-close" title="Clear" onClick={() => setResult(null)}>
            <Icon name="close" size={13} />
          </button>
          {result.type === 'error' && <div className="alert error">{result.message}</div>}
          {result.type === 'opened' && <div className="alert info">{result.message}</div>}
          {result.type === 'chat' && <p className="chat-reply">{result.text}</p>}
          {result.type === 'mail' && <MailReader message={result.message} open={open} />}
          {result.type === 'mail-list' && (
            <>
              <h3 className="label">{result.title}</h3>
              <MailList messages={result.messages} onOpen={openMail} />
            </>
          )}
          {result.type === 'otp' &&
            (result.otp ? (
              <div className="otp">
                <div className="otp-meta">
                  <strong>{result.otp.from}</strong>
                  <span className="muted">{result.otp.subject}</span>
                </div>
                <code className="otp-code">{result.otp.code}</code>
                <button
                  className="btn primary round"
                  onClick={() => void window.island.copyOtp(result.otp!.id).then(() => setInfo('Copied — the clipboard clears automatically.'))}
                >
                  <Icon name="copy" size={14} /> Copy
                </button>
              </div>
            ) : (
              <div className="empty">
                {snap.mailStatus === 'watching' ? 'No verification code in the last 10 minutes.' : 'Connect your inbox first so Isla can catch codes.'}
              </div>
            ))}
          {liveRun && <RunCard run={liveRun} snap={snap} open />}
        </div>
      )}

      <div className="row-between">
        <h3 className="label">Up next</h3>
        <button
          className="link"
          disabled={locked || !s.activeWorkspace}
          onClick={() =>
            void window.island
              .predictNext()
              .then(() => open('agent'))
              .catch(e => setResult({ type: 'error', message: cleanErr(e) }))
          }
        >
          <Icon name="spark" size={13} /> Predict my next steps
        </button>
      </div>
      {snap.suggestions.length === 0 ? (
        <div className="empty">
          {locked
            ? 'Paused. Nothing is running.'
            : snap.mailStatus === 'watching' || s.activeWorkspace
              ? 'All caught up. Isla is keeping an eye on things.'
              : 'Connect your inbox or add a project in Settings so Isla can start helping.'}
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
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}


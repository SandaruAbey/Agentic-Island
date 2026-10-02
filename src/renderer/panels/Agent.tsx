import { useEffect, useRef, useState } from 'react'
import type { AgentRun, IslandSnapshot } from '@shared/types'
import { Icon, fmtTokens, shortPath, timeAgo, cleanErr } from '../components/ui'
import { Markdown, toPlainText } from '../components/Markdown'

const STATUS_LABEL: Record<AgentRun['status'], string> = {
  'pending-approval': 'Needs approval',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  killed: 'Stopped',
  rejected: 'Rejected'
}

export function AgentPanel({ snap }: { snap: IslandSnapshot }) {
  const [openId, setOpenId] = useState<string | null>(snap.runs[0]?.id ?? null)

  if (!snap.runs.length) {
    return <div className="empty tall">No tasks yet. Ask Isla something from Home or pick a suggestion.</div>
  }

  return (
    <div className="runs">
      <div className="row-between">
        <h3 className="label">Tasks</h3>
        <button className="link" onClick={() => void window.island.clearRuns()}>
          Clear finished
        </button>
      </div>
      {snap.runs.map(run => (
        <RunCard
          key={run.id}
          run={run}
          snap={snap}
          open={openId === run.id}
          onToggle={() => setOpenId(openId === run.id ? null : run.id)}
        />
      ))}
    </div>
  )
}

/** `chat`: shown as an answer in a Home conversation — no title row, details in a quiet footer. */
export function RunCard({ run, snap, open, onToggle, chat = false }: { run: AgentRun; snap: IslandSnapshot; open: boolean; onToggle?: () => void; chat?: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const [pasted, setPasted] = useState<string | null>(null)
  const label = snap.providers.find(p => p.id === run.provider)?.label ?? run.provider
  const isOpen = open || run.status === 'pending-approval'
  const where = run.context === 'general' ? 'a private scratch folder' : run.workspace

  if (chat) return <ChatAnswer run={run} snap={snap} label={label} />

  return (
    <article className={`run ${run.status} ${chat ? 'chat' : ''}`}>
      {!chat && (
        <button className="run-head" onClick={onToggle} disabled={!onToggle}>
          <span className={`status-pill ${run.status}`}>{STATUS_LABEL[run.status]}</span>
          <strong>{run.title}</strong>
          <span className="muted">{timeAgo(run.startedAt)}</span>
        </button>
      )}
      {(isOpen || chat) && (
        <div className="run-body">
          <div className={`meta ${chat ? 'chat-meta' : ''}`}>
            {chat && <span className={`status-pill ${run.status}`}>{STATUS_LABEL[run.status]}</span>}
            {chat && run.computer && <span className="warn">PC task</span>}
            <span>{run.context === 'general' ? 'General' : shortPath(run.workspace)}</span>
            <span>{label}</span>
            <span>{run.model || 'default model'}</span>
            <span className={run.mode === 'edit' ? 'warn' : ''}>{run.mode === 'edit' ? 'can edit files' : 'read-only'}</span>
            {run.hasMail && <span className="mailtag">includes emails · codes hidden</span>}
            {run.allowWeb && <span>web search</span>}
            {run.usage && (
              <span>
                {fmtTokens(run.usage.input + run.usage.cacheRead)} in · {fmtTokens(run.usage.output)} out
              </span>
            )}
            {run.costUsd !== undefined && <span>${run.costUsd.toFixed(4)}</span>}
          </div>

          {run.status === 'pending-approval' ? (
            <>
              <p className="approve-note">
                Isla will send this to <b>{label}</b> in <b>{where}</b>.
                {run.mode === 'edit'
                  ? ` This looks like a change request and ${label} is set to “Can edit” (Settings → Agents), so it may modify files in this folder — that's why Isla asks first.`
                  : ' The agent can only read — it cannot change anything.'}
                {run.hasMail && ' The emails below will be shown to the AI, with any verification codes removed. Web access is off for this task.'}
              </p>
              {chat ? (
                <button className="link" onClick={() => setShowPrompt(v => !v)}>
                  {showPrompt ? 'Hide' : 'Show'} exactly what will be sent
                </button>
              ) : null}
              {(!chat || showPrompt) && <pre className="prompt-preview">{run.prompt}</pre>}
              {error && <div className="alert error">{error}</div>}
              <div className="actions">
                <button className="btn ghost" onClick={() => void window.island.rejectRun(run.id)}>
                  Reject
                </button>
                <button
                  className={`btn ${run.mode === 'edit' ? 'orange' : 'primary'}`}
                  onClick={() => window.island.approveRun(run.id).catch(e => setError(cleanErr(e)))}
                >
                  <Icon name="check" size={14} /> Approve & run
                </button>
              </div>
            </>
          ) : (
            <>
              <Output run={run} chat={chat} />
              {showPrompt && <pre className="prompt-preview">{run.prompt}</pre>}
              {pasted && <div className="alert info">{pasted}</div>}
              <div className="actions">
                <button className="link" onClick={() => setShowPrompt(v => !v)}>
                  {showPrompt ? 'Hide' : 'Show'} what was sent
                </button>
                <span className="spacer" />
                {run.status === 'running' ? (
                  <button className="btn red" onClick={() => void window.island.cancelRun(run.id)}>
                    <Icon name="stop" size={13} /> Stop
                  </button>
                ) : (
                  run.output && (
                    <>
                      <button className="btn ghost" onClick={() => void window.island.copyText(answerText(run.output))}>
                        <Icon name="copy" size={13} /> Copy answer
                      </button>
                      {/* Paste straight into the app you were using (WhatsApp, Teams, Gmail…). You still press Enter yourself. */}
                      {run.context === 'general' && run.status === 'done' && snap.activity && snap.activity.kind !== 'ide' && (
                        <button
                          className="btn primary"
                          title={`Switch to ${snap.activity.app} and paste — you press Enter to send`}
                          onClick={() => void window.island.pasteToApp(answerText(run.output)).then(r => setPasted(r.message))}
                        >
                          <Icon name="send" size={13} /> Paste into {snap.activity.app}
                        </button>
                      )}
                    </>
                  )
                )}
              </div>
            </>
          )}
        </div>
      )}
    </article>
  )
}

/** An answer inside a Home conversation: the message bubble, then one small row with status and actions. */
function ChatAnswer({ run, snap, label }: { run: AgentRun; snap: IslandSnapshot; label: string }) {
  const [error, setError] = useState<string | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const pending = run.status === 'pending-approval'
  const needsConnect = pending && !!run.computer && run.provider === 'antigravity' && snap.antigravityComputer === false
  const canPaste = run.context === 'general' && run.status === 'done' && !!run.output && !!snap.activity && snap.activity.kind !== 'ide'
  return (
    <div className={`chat-a ${run.status}`}>
      {pending ? (
        <div className="chat-approve">
          <p>
            {run.computer ? (
              <>
                Isla wants to <b>do this on your PC</b> with {label}. It works in the background and asks again before anything risky.
              </>
            ) : (
              <>
                Isla will ask <b>{label}</b>
                {run.mode === 'edit' ? ' — it may change files in your project.' : ' — read-only, nothing gets changed.'}
              </>
            )}
            {run.hasMail && ' Your emails are included, with codes hidden.'}
          </p>
          {showPrompt && <pre className="prompt-preview">{run.prompt}</pre>}
          {error && <div className="alert error">{error}</div>}
          <div className="chat-approve-actions">
            <button className="link" onClick={() => setShowPrompt(v => !v)}>
              {showPrompt ? 'Hide details' : 'Details'}
            </button>
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => void window.island.rejectRun(run.id)}>
              Not now
            </button>
            {needsConnect ? (
              // Your click is the consent: register Isla's tools with Antigravity once, then run the task.
              <button
                className="btn sm primary"
                title="Adds Isla's tools to Antigravity (rule mcp(isla/*)). Your own agy sessions never see them."
                onClick={() =>
                  void window.island
                    .connectAntigravity()
                    .then(r => {
                      if (!r.ok) throw new Error(r.message)
                      setError(null)
                      return window.island.approveRun(run.id)
                    })
                    .catch(e => setError(cleanErr(e)))
                }
              >
                <Icon name="check" size={13} /> Connect & approve
              </button>
            ) : (
              <button className={`btn sm ${run.mode === 'edit' ? 'orange' : 'primary'}`} onClick={() => window.island.approveRun(run.id).catch(e => setError(cleanErr(e)))}>
                <Icon name="check" size={13} /> Approve
              </button>
            )}
          </div>
        </div>
      ) : (
        <Output run={run} chat />
      )}
      {snap.pendingActions
        .filter(a => a.runId === run.id)
        .map(a => (
          <div key={a.id} className="chat-approve">
            <p>
              <b>{a.summary}</b>
              <br />
              <span className="muted">{a.reason}</span>
            </p>
            <div className="chat-approve-actions">
              <span className="spacer" />
              <button className="btn ghost sm" onClick={() => void window.island.decideAction(a.id, false)}>
                Deny
              </button>
              <button className="btn sm primary" onClick={() => void window.island.decideAction(a.id, true)}>
                <Icon name="check" size={13} /> Allow
              </button>
            </div>
          </div>
        ))}
      {note && <div className="chat-note">{note}</div>}
      <div className="chat-foot">
        <span className={`chat-dot ${run.status}`} />
        <span className="chat-foot-meta">
          {STATUS_LABEL[run.status]} · {label}
          {run.model ? ` · ${run.model}` : ''}
          {run.computer && /(^|\n)▸ /.test(run.output) ? ' · used your PC' : ''}
        </span>
        <span className="spacer" />
        {run.computer && !pending && /(^|\n)▸ /.test(run.output) && (
          <button className="chat-act" title="Open Isla’s browser to watch or help (e.g. sign in)" onClick={() => void window.island.showBrowser(true)}>
            <Icon name="eye" size={12} /> Browser
          </button>
        )}
        {run.status === 'running' && (
          <button className="chat-act stop" title="Stop" onClick={() => void window.island.cancelRun(run.id)}>
            <Icon name="stop" size={11} /> Stop
          </button>
        )}
        {!pending && run.status !== 'running' && run.output && (
          <button className="chat-act" title="Copy answer" onClick={() => void window.island.copyText(answerText(run.output)).then(() => setNote('Copied.'))}>
            <Icon name="copy" size={12} />
          </button>
        )}
        {canPaste && (
          <button
            className="chat-act"
            title={`Paste into ${snap.activity!.app} — you press Enter to send`}
            onClick={() => void window.island.pasteToApp(answerText(run.output)).then(r => setNote(r.message))}
          >
            <Icon name="send" size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

/** The answer as clean plain text (no tool-call lines or markdown symbols) for copying or pasting into chat apps. */
const answerText = (out: string) => toPlainText(out)

function Output({ run, chat = false }: { run: AgentRun; chat?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (run.status === 'running' && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [run.output, run.status])
  return (
    <div ref={ref} className={`output md ${run.context === 'general' || chat ? 'prose' : ''} ${chat ? 'chat-bubble' : ''}`}>
      {run.output ? (
        <Markdown text={run.output} previews={run.status !== 'running'} />
      ) : run.status === 'running' ? (
        <span className="thinking">Thinking</span>
      ) : (
        <span className="muted">(no output)</span>
      )}
    </div>
  )
}

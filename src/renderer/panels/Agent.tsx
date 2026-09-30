import { useEffect, useRef, useState } from 'react'
import type { AgentRun, IslandSnapshot } from '@shared/types'
import { Icon, fmtTokens, shortPath, timeAgo, cleanErr } from '../components/ui'

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

export function RunCard({ run, snap, open, onToggle }: { run: AgentRun; snap: IslandSnapshot; open: boolean; onToggle?: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const label = snap.providers.find(p => p.id === run.provider)?.label ?? run.provider
  const isOpen = open || run.status === 'pending-approval'
  const where = run.context === 'general' ? 'a private scratch folder' : run.workspace

  return (
    <article className={`run ${run.status}`}>
      <button className="run-head" onClick={onToggle} disabled={!onToggle}>
        <span className={`status-pill ${run.status}`}>{STATUS_LABEL[run.status]}</span>
        <strong>{run.title}</strong>
        <span className="muted">{timeAgo(run.startedAt)}</span>
      </button>
      {isOpen && (
        <div className="run-body">
          <div className="meta">
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
              <pre className="prompt-preview">{run.prompt}</pre>
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
              <Output run={run} />
              {showPrompt && <pre className="prompt-preview">{run.prompt}</pre>}
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
                    <button className="btn ghost" onClick={() => void window.island.copyText(run.output.replace(/^▸ .*\n/gm, '').trim())}>
                      <Icon name="copy" size={13} /> Copy answer
                    </button>
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

function Output({ run }: { run: AgentRun }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (run.status === 'running' && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [run.output, run.status])
  return (
    <pre ref={ref} className={`output ${run.context === 'general' ? 'prose' : ''}`}>
      {run.output || (run.status === 'running' ? 'Thinking…' : '(no output)')}
    </pre>
  )
}

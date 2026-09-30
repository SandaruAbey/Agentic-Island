import { useEffect, useState } from 'react'
import type { AuditEntry, IslandSnapshot } from '@shared/types'
import { Icon, timeAgo } from '../components/ui'

const PROTECTIONS = [
  ['Approval before every task', 'Nothing reaches an agent until you read the exact prompt and click Approve.'],
  ['Read-only by default', 'Agents may only read files and run read-only git commands unless you switch a provider to "Can edit".'],
  ['Workspace allowlist', 'Agents and git actions only run inside folders you added.'],
  ['No shell injection', 'Prompts are sent on stdin, never as command-line arguments.'],
  ['Secrets encrypted', 'Your mail password is encrypted with Windows DPAPI and never leaves the main process.'],
  ['Codes stay local', 'Verification codes live in memory only, expire in 10 min, are never sent to AI, and the clipboard is wiped.'],
  ['Hardened app', 'Sandboxed renderer, context isolation, strict CSP, no navigation or pop-ups, all permissions denied.'],
  ['Context stays local', 'Which app you are in is only used on this PC to pick suggestions — never logged or sent to an AI.'],
  ['Mail is read-only', 'Isla never sends, deletes or marks mail as read. Mail goes to an AI only when you ask, with web access switched off.'],
  ['Plan usage, not your data', 'To show real Claude limits, Isla uses Claude Code’s local sign-in only to ask api.anthropic.com for your own usage. It can be switched off in Settings → General.'],
  ['Audit log', 'Every task, approval, git action and security event is recorded locally.']
]

export function SecurityPanel({ snap }: { snap: IslandSnapshot }) {
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const sec = snap.security
  useEffect(() => {
    void window.island.getAudit().then(setAudit)
  }, [snap])

  return (
    <div className="security">
      <div className={`sec-hero ${sec.locked ? 'locked' : ''}`}>
        <div>
          <span className="label">Status</span>
          <strong>{sec.locked ? 'Kill switch engaged' : 'Protected & running'}</strong>
          <span className="muted small">
            {sec.locked
              ? `Everything paused ${sec.lockedAt ? timeAgo(sec.lockedAt) : ''}. No agent, git or inbox activity.`
              : `${sec.activeRuns} agent process${sec.activeRuns === 1 ? '' : 'es'} running · kill switch: ${sec.killShortcut}`}
          </span>
        </div>
        <div className="sec-buttons">
          {sec.locked ? (
            <button className="btn green" onClick={() => void window.island.resume()}>
              <Icon name="play" size={14} /> Resume
            </button>
          ) : (
            <button className="btn red big" onClick={() => void window.island.killSwitch()}>
              <Icon name="stop" size={14} /> Kill switch
            </button>
          )}
          <button
            className="btn ghost"
            onClick={() => {
              if (confirm('Stop every agent and shut down Agentic Island?')) void window.island.shutdown()
            }}
          >
            <Icon name="power" size={14} /> Shut down
          </button>
        </div>
      </div>

      <ul className="protections">
        {PROTECTIONS.map(([t, d]) => (
          <li key={t}>
            <Icon name="check" size={14} />
            <div>
              <strong>{t}</strong>
              <span>{d}</span>
            </div>
          </li>
        ))}
      </ul>

      <h3 className="label">Audit log</h3>
      <ul className="audit">
        {audit.slice(0, 60).map((a, i) => (
          <li key={i} className={a.kind.startsWith('security') ? 'sec' : ''}>
            <time>{new Date(a.at).toLocaleTimeString()}</time>
            <code>{a.kind}</code>
            <span>{a.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

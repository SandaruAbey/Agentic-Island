import { useEffect, useState } from 'react'
import type { IslandSnapshot } from '@shared/types'
import { Icon, shortPath, timeAgo } from '../components/ui'

const CODE_LABEL = (code: string) => {
  if (code === '??') return { t: 'U', c: 'untracked', title: 'Untracked' }
  if (code === 'UU') return { t: '!', c: 'conflict', title: 'Conflict' }
  const x = code[0] !== '.' ? code[0] : code[1]
  return { t: x, c: code[0] !== '.' ? 'staged' : 'modified', title: code[0] !== '.' ? 'Staged' : 'Modified' }
}

export function GitPanel({ snap }: { snap: IslandSnapshot }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const s = snap.settings
  const g = snap.git

  const op = async (o: 'push' | 'pull' | 'fetch') => {
    if (o === 'push' && !confirm(`Run "git push" in ${s.activeWorkspace}?`)) return
    setBusy(o)
    const r = await window.island.gitAction(o)
    setBusy(null)
    setMsg({ ok: r.ok, text: r.message })
  }

  return (
    <div className="git">
      <div className="ws-row">
        <select
          value={s.activeWorkspace ?? ''}
          onChange={e => void window.island.setActiveWorkspace(e.target.value)}
          aria-label="Active workspace"
        >
          {!s.workspaces.length && <option value="">No workspaces</option>}
          {s.workspaces.map(w => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        <button className="btn ghost" onClick={() => void window.island.addWorkspace()}>
          <Icon name="folder" size={13} /> Add
        </button>
      </div>

      {!g ? (
        <div className="empty tall">Add a workspace folder to follow its version control.</div>
      ) : !g.isRepo ? (
        <div className="empty tall">{shortPath(g.workspace)} is not a git repository.{g.error ? ` (${g.error})` : ''}</div>
      ) : (
        <>
          <div className="git-hero">
            <div>
              <span className="label">Branch</span>
              <strong className="branch">
                <Icon name="git" size={15} /> {g.branch}
              </strong>
              <span className="muted">{g.upstream ? `tracking ${g.upstream}` : 'no upstream'}</span>
            </div>
            <div className="stats">
              <Stat n={g.ahead} label="ahead" tone="blue" />
              <Stat n={g.behind} label="behind" tone="orange" />
              <Stat n={g.staged} label="staged" tone="green" />
              <Stat n={g.modified} label="modified" tone="yellow" />
              <Stat n={g.untracked} label="new" tone="gray" />
              {g.conflicted > 0 && <Stat n={g.conflicted} label="conflicts" tone="red" />}
            </div>
            <div className="git-actions">
              {(['fetch', 'pull', 'push'] as const).map(o => (
                <button key={o} className="btn ghost sm" disabled={!!busy || snap.security.locked} onClick={() => void op(o)}>
                  <Icon name={o === 'fetch' ? 'refresh' : o} size={12} /> {busy === o ? '…' : o}
                </button>
              ))}
            </div>
          </div>
          {msg && <div className={`alert ${msg.ok ? 'info' : 'error'}`}>{msg.text}</div>}
          {g.staged + g.modified + g.untracked > 0 && <CommitBox snap={snap} onResult={setMsg} />}

          <div className="git-cols">
            <div>
              <h3 className="label">Changes ({g.files.length})</h3>
              {g.files.length === 0 ? (
                <div className="empty">Working tree clean</div>
              ) : (
                <ul className="files">
                  {g.files.map(f => {
                    const l = CODE_LABEL(f.code)
                    return (
                      <li key={f.path + f.code} title={`${l.title}: ${f.path}`}>
                        <b className={l.c}>{l.t}</b>
                        <span>{f.path}</span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            <div>
              <h3 className="label">Recent commits</h3>
              <ul className="commits">
                {g.commits.map(c => (
                  <li key={c.hash}>
                    <code>{c.hash}</code>
                    <span className="subject">{c.subject}</span>
                    <span className="muted">
                      {c.author} · {c.relative}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="muted small">Updated {timeAgo(g.updatedAt)}</p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function CommitBox({ snap, onResult }: { snap: IslandSnapshot; onResult: (m: { ok: boolean; text: string }) => void }) {
  const p = snap.proposal && snap.proposal.workspace === snap.settings.activeWorkspace ? snap.proposal : null
  const [message, setMessage] = useState(p?.message ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    if (p?.message) setMessage(p.message)
  }, [p?.diffHash])

  const review = async () => {
    setBusy('review')
    await window.island.reviewChanges()
    setBusy(null)
  }
  const commit = async (push: boolean) => {
    let allow = false
    if (p?.secrets.length) {
      if (!confirm(`Possible secret found: ${p.secrets.join(', ')}.\n\nCommit anyway? This is recorded in the audit log.`)) return
      allow = true
    }
    if (push && !p && !confirm(`Commit all changes and push to ${snap.git?.upstream ?? 'the remote'}?`)) return
    setBusy(push ? 'push' : 'commit')
    const r = await window.island.commit(message, push, p?.diffHash ?? 'manual', allow)
    setBusy(null)
    onResult({ ok: r.ok, text: r.message })
  }

  return (
    <div className={`commit-box ${p ? (p.secrets.length ? 'danger' : p.ok ? 'good' : 'check') : ''}`}>
      <div className="row-between">
        <strong>
          {p
            ? p.secrets.length
              ? 'Possible secret in your changes'
              : p.ok
                ? 'Looks good to commit'
                : 'Check before committing'
            : 'Commit your changes'}
        </strong>
        <button className="link" disabled={!!busy || snap.security.locked} onClick={() => void review()}>
          <Icon name="spark" size={12} /> {busy === 'review' ? 'Reviewing…' : p ? 'Review again' : 'Review & write message'}
        </button>
      </div>
      {p && (p.secrets.length > 0 || p.issues.length > 0) && (
        <ul className="issues">
          {p.secrets.map(x => (
            <li key={x} className="bad">
              {x}
            </li>
          ))}
          {p.issues.map(x => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      <div className="inline">
        <input value={message} placeholder="Commit message" spellCheck={false} onChange={e => setMessage(e.target.value)} />
        <button className="btn ghost" disabled={!!busy || !message.trim() || snap.security.locked} onClick={() => void commit(false)}>
          {busy === 'commit' ? '…' : 'Commit'}
        </button>
        <button className="btn green" disabled={!!busy || !message.trim() || snap.security.locked} onClick={() => void commit(true)}>
          <Icon name="push" size={13} /> {busy === 'push' ? '…' : 'Commit & push'}
        </button>
      </div>
      <p className="muted small">
        Commits every change listed below (git add -A).{p ? ` Reviewed ${timeAgo(p.createdAt)}${p.source === 'ai' ? ' by AI' : ''} — if files change, you’ll be asked to review again.` : ''}
      </p>
    </div>
  )
}

function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <div className={`stat ${tone} ${n === 0 ? 'zero' : ''}`}>
      <b>{n}</b>
      <span>{label}</span>
    </div>
  )
}

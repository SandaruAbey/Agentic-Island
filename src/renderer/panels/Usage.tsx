import { useEffect, useState } from 'react'
import type { AiLimit, AiProcess, ModelUsage, UsageReport } from '@shared/types'
import { LimitCards } from '../components/Rings'
import { Segmented, fmtTokens, timeAgo } from '../components/ui'

export function UsagePanel({ limits }: { limits: AiLimit[] }) {
  const [report, setReport] = useState<UsageReport | null>(null)
  const [procs, setProcs] = useState<AiProcess[] | null>(null)
  const [range, setRange] = useState<'today' | 'week'>('today')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const loadUsage = () =>
      window.island
        .getUsage()
        .then(r => alive && setReport(r))
        .finally(() => alive && setLoading(false))
    const loadProcs = () => window.island.getProcesses().then(p => alive && setProcs(p))
    void loadUsage()
    void loadProcs()
    const a = window.setInterval(loadProcs, 4000)
    const b = window.setInterval(loadUsage, 60_000)
    return () => {
      alive = false
      window.clearInterval(a)
      window.clearInterval(b)
    }
  }, [])

  const rows = report ? report[range] : []
  const total = rows.reduce((s, r) => s + r.input + r.output + r.cacheWrite, 0)
  const maxDay = Math.max(1, ...(report?.daily.map(d => d.tokens) ?? [1]))

  return (
    <div className="usage">
      <LimitCards limits={limits} />
      <div className="usage-top">
        <div className="big-number">
          <span className="label">{range === 'today' ? 'Tokens today' : 'Tokens · 7 days'}</span>
          <strong>{loading ? '…' : fmtTokens(total)}</strong>
          <span className="muted small">
            input + output + cache writes{report && report.islandCostUsd > 0 ? ` · Isla runs today $${report.islandCostUsd.toFixed(3)}` : ''}
          </span>
        </div>
        {report && (
          <div className="bars" role="img" aria-label="Tokens per day, last 7 days">
            {report.daily.map(d => (
              <div key={d.date} className="bar-col" title={`${d.date}: ${fmtTokens(d.tokens)} tokens`}>
                <div className="bar" style={{ height: `${Math.max(3, (d.tokens / maxDay) * 100)}%` }} />
                <span>{new Date(d.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
              </div>
            ))}
          </div>
        )}
        <Segmented
          value={range}
          onChange={setRange}
          options={[
            { value: 'today', label: 'Today' },
            { value: 'week', label: '7 days' }
          ]}
        />
      </div>

      <h3 className="label">By model</h3>
      {rows.length === 0 ? (
        <div className="empty">{loading ? 'Reading local agent logs…' : 'No usage recorded for this period.'}</div>
      ) : (
        <table className="usage-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Model</th>
              <th className="num">Input</th>
              <th className="num">Output</th>
              <th className="num">Cache read</th>
              <th className="num">Requests</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: ModelUsage) => (
              <tr key={r.source + r.model}>
                <td>
                  <span className={`src ${r.source.replace(/\s/g, '').toLowerCase()}`}>{r.source}</span>
                </td>
                <td className="model">{r.model}</td>
                <td className="num">{fmtTokens(r.input)}</td>
                <td className="num">{fmtTokens(r.output)}</td>
                <td className="num muted">{fmtTokens(r.cacheRead)}</td>
                <td className="num muted">{r.requests}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="label">AI running on this PC</h3>
      {procs === null ? (
        <div className="empty">Scanning processes…</div>
      ) : procs.length === 0 ? (
        <div className="empty">No AI agents or AI apps are running right now.</div>
      ) : (
        <ul className="procs">
          {procs.map(p => (
            <li key={p.kind}>
              <span className="dot green pulse" />
              <strong>{p.name}</strong>
              <span className="muted small">
                {p.count} process{p.count > 1 ? 'es' : ''}
              </span>
              <span className="meter" title={`${p.cpuPercent}% CPU`}>
                <i style={{ width: `${Math.min(100, p.cpuPercent)}%` }} />
              </span>
              <span className="num">{p.cpuPercent.toFixed(1)}% CPU</span>
              <span className="num">{p.memoryMb >= 1024 ? `${(p.memoryMb / 1024).toFixed(1)} GB` : `${p.memoryMb} MB`}</span>
            </li>
          ))}
        </ul>
      )}
      {report && (
        <p className="muted small notes">
          {report.notes.join(' ')} Scanned {timeAgo(report.scannedAt)}.
        </p>
      )}
    </div>
  )
}

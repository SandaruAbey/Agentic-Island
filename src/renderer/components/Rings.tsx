import type { AiLimit, AudioDevice, UsageRing } from '@shared/types'
import { Icon, fmtTokens } from './ui'

/** "4h", "35m", "2d" until a reset. */
export function untilShort(ts: number): string {
  const m = Math.max(0, Math.round((ts - Date.now()) / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

function untilLong(ts: number): string {
  const d = new Date(ts)
  const m = Math.max(0, Math.round((ts - Date.now()) / 60_000))
  if (m < 60) return `in ${m} min`
  if (m < 24 * 60) return `in ${Math.floor(m / 60)}h ${m % 60}m`
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

const ringColor = (pct: number, base: string) => (pct >= 90 ? '#ff453a' : pct >= 75 ? '#ffd60a' : base)

function describe(r: UsageRing): string {
  const amount = r.used !== null && r.limit !== null ? ` (${fmtTokens(r.used)} of ${fmtTokens(r.limit)} tokens)` : ''
  return `${r.label}: ${r.pct}%${amount} · resets ${untilLong(r.resetsAt)}`
}

export function Ring({ l, size = 32 }: { l: AiLimit; size?: number }) {
  const c = size / 2
  const sw = Math.max(2.5, size * 0.1)
  const rOuter = c - sw / 2
  const rInner = rOuter - sw - 1.5
  const arc = (r: number, pct: number, color: string, opacity = 1) => {
    const circ = 2 * Math.PI * r
    return (
      <>
        <circle cx={c} cy={c} r={r} fill="none" stroke="#2c2c2e" strokeWidth={sw} />
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={ringColor(pct, color)}
          strokeOpacity={opacity}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - Math.max(pct, 1) / 100)}
          transform={`rotate(-90 ${c} ${c})`}
          style={{ transition: 'stroke-dashoffset .6s ease' }}
        />
      </>
    )
  }
  const tip = `${l.label}${l.reported ? ' (real plan usage)' : ' (estimate from local logs)'}\n${describe(l.outer)}\n${describe(l.inner)}`
  return (
    <div className="ring" title={tip} aria-label={tip} role="img">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {arc(rOuter, l.outer.pct, l.color)}
        {arc(rInner, l.inner.pct, l.color, 0.65)}
        <text x={c} y={c} textAnchor="middle" dominantBaseline="central" fontSize={size * 0.26} fill="#d1d1d6" fontWeight={600}>
          {untilShort(l.inner.resetsAt)}
        </text>
      </svg>
    </div>
  )
}

export function UsageRings({ limits, size }: { limits: AiLimit[]; size?: number }) {
  if (!limits.length) return null
  return (
    <div className="rings">
      {limits.map(l => (
        <Ring key={l.id} l={l} size={size} />
      ))}
    </div>
  )
}

/** Bigger version with labels, for the Usage panel. */
export function LimitCards({ limits }: { limits: AiLimit[] }) {
  if (!limits.length) return null
  return (
    <div className="limit-cards">
      {limits.map(l => (
        <div key={l.id} className="limit-card">
          <Ring l={l} size={64} />
          <div>
            <strong style={{ color: l.color }}>{l.label}</strong>
            <span>{describe(l.outer)}</span>
            <span>{describe(l.inner)}</span>
            <em>{l.reported ? (l.id === 'claude' ? 'Real plan usage from your Claude account' : l.id === 'codex' ? 'Limits reported by Codex' : 'Real usage from Antigravity logs') : l.id === 'antigravity' ? 'From Antigravity local logs · set limits in Settings → General (0 = your busiest day/week)' : 'Estimate from local logs · set limits in Settings → General (0 = your busiest day/week)'}</em>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Battery colour: green, yellow when getting low, red when it needs charging. */
export const batteryColor = (pct: number) => (pct <= 20 ? '#ff453a' : pct <= 40 ? '#ffd60a' : '#30d158')

/** Earbuds/headphones battery as a ring in the same style as the AI-usage rings, with the earbuds icon in the middle. */
export function BudsRing({ d, size = 32 }: { d: AudioDevice; size?: number }) {
  const c = size / 2
  const sw = Math.max(2.5, size * 0.1)
  const r = c - sw / 2
  const circ = 2 * Math.PI * r
  const pct = d.battery
  const tip = `${d.name}${pct !== null ? ` · ${pct}% battery` : ' · connected'}`
  return (
    <div className="ring buds-ring" title={tip} aria-label={tip} role="img" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="#2c2c2e" strokeWidth={sw} />
        {pct !== null && (
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={batteryColor(pct)}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - Math.max(pct, 1) / 100)}
            transform={`rotate(-90 ${c} ${c})`}
            style={{ transition: 'stroke-dashoffset .6s ease, stroke .6s ease' }}
          />
        )}
      </svg>
      <Icon name="buds" size={Math.round(size * 0.44)} className="buds-ring-ico" />
    </div>
  )
}

/** Home: connected earbuds/headphones in detail. */
export function BudsCards({ devices }: { devices: AudioDevice[] }) {
  if (!devices.length) return null
  return (
    <div className="buds-cards">
      {devices.map(d => {
        const pct = d.battery
        const state = pct === null ? 'Battery level not reported by this device' : pct <= 20 ? 'Low — charge soon' : pct <= 40 ? 'Getting low' : 'Good'
        return (
          <div key={d.name} className="buds-card">
            <BudsRing d={d} size={56} />
            <div className="buds-card-meta">
              <strong>{d.name}</strong>
              <span>
                {pct !== null && (
                  <b style={{ color: batteryColor(pct) }}>{pct}%</b>
                )}
                {pct !== null && ' battery · '}
                {state}
              </span>
              <em>Connected over Bluetooth</em>
            </div>
            {pct !== null && (
              <div className="buds-bar" aria-hidden="true">
                <i style={{ width: `${Math.max(pct, 2)}%`, background: batteryColor(pct) }} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

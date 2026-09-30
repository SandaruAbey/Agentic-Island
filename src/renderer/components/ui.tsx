import type { ReactNode } from 'react'

const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  agent: 'M12 2a4 4 0 0 1 4 4v1h1a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3h1V6a4 4 0 0 1 4-4zm-3 11a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM12 4a2 2 0 0 0-2 2v1h4V6a2 2 0 0 0-2-2z',
  git: 'M6 3a3 3 0 0 1 1 5.83v6.34A3 3 0 1 1 5 15.17V8.83A3 3 0 0 1 6 3zm12 3a3 3 0 0 1 1 5.83V12a4 4 0 0 1-4 4H9.83a3 3 0 0 0 0-2H15a2 2 0 0 0 2-2v-.17A3 3 0 0 1 18 6z',
  key: 'M14.5 2a7.5 7.5 0 1 1-2.83 14.45L10 18.12V20H8v2H4a1 1 0 0 1-1-1v-3.59l6.55-6.55A7.5 7.5 0 0 1 14.5 2zm2 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  usage: 'M4 20V10h3v10zm6.5 0V4h3v16zM17 20v-7h3v7z',
  settings:
    'M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zm8.6 5.1-1.7-.4a7 7 0 0 1-.6 1.5l.9 1.5-1.9 1.9-1.5-.9a7 7 0 0 1-1.5.6l-.4 1.7h-2.8l-.4-1.7a7 7 0 0 1-1.5-.6l-1.5.9-1.9-1.9.9-1.5a7 7 0 0 1-.6-1.5l-1.7-.4v-2.8l1.7-.4a7 7 0 0 1 .6-1.5l-.9-1.5 1.9-1.9 1.5.9a7 7 0 0 1 1.5-.6l.4-1.7h2.8l.4 1.7a7 7 0 0 1 1.5.6l1.5-.9 1.9 1.9-.9 1.5a7 7 0 0 1 .6 1.5l1.7.4z',
  shield: 'M12 2 4 5v6c0 5 3.4 9.5 8 11 4.6-1.5 8-6 8-11V5z',
  power: 'M11 2h2v10h-2zM6.3 5.3l1.4 1.4A7 7 0 1 0 16.3 6.7l1.4-1.4A9 9 0 1 1 6.3 5.3z',
  stop: 'M6 6h12v12H6z',
  send: 'M3 20.5 21 12 3 3.5 3 10l12 2-12 2z',
  copy: 'M8 3h10a2 2 0 0 1 2 2v12h-2V5H8zM5 7h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z',
  close: 'm6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  commit: 'M12 8a4 4 0 0 1 3.87 3H22v2h-6.13a4 4 0 0 1-7.74 0H2v-2h6.13A4 4 0 0 1 12 8z',
  push: 'M12 3 5 10l1.4 1.4L11 6.8V21h2V6.8l4.6 4.6L19 10z',
  pull: 'M12 21l7-7-1.4-1.4-4.6 4.6V3h-2v14.2l-4.6-4.6L5 14z',
  conflict: 'M12 2 1 21h22zm-1 7h2v6h-2zm0 8h2v2h-2z',
  warn: 'M12 2 1 21h22zm-1 7h2v6h-2zm0 8h2v2h-2z',
  spark: 'M12 2l2.2 6.3L20 10l-5.8 1.7L12 18l-2.2-6.3L4 10l5.8-1.7zM19 15l1 2.5 2.5 1-2.5 1L19 22l-1-2.5-2.5-1 2.5-1z',
  review: 'M12 5c5 0 9 4.5 10 7-1 2.5-5 7-10 7S3 14.5 2 12c1-2.5 5-7 10-7zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  pin: 'M16 3v2l-1 1v5l3 3v2h-5v6h-2v-6H6v-2l3-3V6L8 5V3z',
  folder: 'M3 5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  refresh: 'M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.76-4.24L13 11h7V4z',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1zm2 0h6V7a3 3 0 0 0-6 0z',
  play: 'M7 4v16l13-8z',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm.3 3.2v1.3L12 13.6l7.7-5.1V7.2L12 12.3z',
  back: 'M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z',
  chevron: 'M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z',
  pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
  prev: 'M6 5h2v14H6zm3.5 7L19 5v14z',
  next: 'M16 5h2v14h-2zM5 5l9.5 7L5 19z',
  music: 'M12 3v10.6A4 4 0 1 0 14 17V7h4V3z',
  translate: 'M4 5h7V3h2v2h7v2h-2.2c-.6 2.2-1.8 4.3-3.4 6l2.6 2.6-1.4 1.4L13 14.4 9 18.4 7.6 17l4-4c-.9-1-1.7-2.2-2.2-3.5h2.2c.4.8.9 1.6 1.5 2.3 1.2-1.4 2.1-3 2.6-4.8H4zm13 9h2l4 9h-2.2l-.9-2h-3.8l-.9 2H13zm1 2.5L16.8 19h2.4z',
  chat: 'M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2z',
  eye: 'M12 5c5 0 9 4.5 10 7-1 2.5-5 7-10 7S3 14.5 2 12c1-2.5 5-7 10-7zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z'
}
const EVENODD = new Set(['mail', 'eye'])

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.spark} fill="currentColor" fillRule={EVENODD.has(name) ? 'evenodd' : undefined} />
    </svg>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="section">
      <header>
        <h3>{title}</h3>
        {right}
      </header>
      {children}
    </section>
  )
}

export const fmtTokens = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export const shortPath = (p: string) => {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : p
}

export const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

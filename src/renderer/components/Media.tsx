import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MediaState } from '@shared/types'
import { Icon } from './ui'

/** Text that scrolls sideways (like a car stereo) only when it doesn't fit. */
export function Marquee({ text, className }: { text: string; className?: string }) {
  const box = useRef<HTMLSpanElement>(null)
  const inner = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)
  useLayoutEffect(() => {
    const b = box.current
    const i = inner.current
    if (!b || !i) return
    const measure = () => setOverflow(i.scrollWidth > b.clientWidth + 2 ? i.scrollWidth : 0)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(b)
    return () => ro.disconnect()
  }, [text])
  const gap = 40
  return (
    <span ref={box} className={`marquee ${overflow ? 'moving' : ''} ${className ?? ''}`} title={text}>
      <span
        className="marquee-track"
        style={overflow ? ({ '--dist': `${overflow + gap}px`, animationDuration: `${Math.max(6, (overflow + gap) / 30)}s` } as React.CSSProperties) : undefined}
      >
        <span ref={inner}>{text}</span>
        {overflow > 0 && (
          <span aria-hidden="true" style={{ paddingLeft: gap }}>
            {text}
          </span>
        )}
      </span>
    </span>
  )
}

export const isPlaying = (m: MediaState | null) => m?.status === 'Playing'

/** Live position in seconds (interpolated between updates while playing). */
export function usePosition(m: MediaState | null): number {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!isPlaying(m)) return
    const t = window.setInterval(() => tick(x => x + 1), 1000)
    return () => window.clearInterval(t)
  }, [m?.status, m?.receivedAt])
  if (!m) return 0
  const p = m.position + (isPlaying(m) ? (Date.now() - m.receivedAt) / 1000 : 0)
  return m.duration > 0 ? Math.min(m.duration, p) : p
}

const fmt = (s: number) => {
  const t = Math.max(0, Math.floor(s))
  const h = Math.floor(t / 3600)
  const mm = Math.floor((t % 3600) / 60)
  const ss = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

export function Art({ m, size }: { m: MediaState; size: number }) {
  return m.thumbnail ? (
    <img className="media-art" src={m.thumbnail} alt="" width={size} height={size} draggable={false} />
  ) : (
    <span className="media-art placeholder" style={{ width: size, height: size }}>
      <Icon name="music" size={Math.round(size * 0.5)} />
    </span>
  )
}

export function Controls({ m, big }: { m: MediaState; big?: boolean }) {
  const s = big ? 18 : 13
  return (
    <div className={`media-controls ${big ? 'big' : ''}`} onPointerDown={e => e.stopPropagation()}>
      <button className="mc" title="Previous" disabled={!m.canPrev} onClick={e => { e.currentTarget.blur(); window.island.mediaControl('prev') }}>
        <Icon name="prev" size={s} />
      </button>
      <button className="mc play" title={isPlaying(m) ? 'Pause' : 'Play'} disabled={!m.canToggle} onClick={e => { e.currentTarget.blur(); window.island.mediaControl('toggle') }}>
        <Icon name={isPlaying(m) ? 'pause' : 'play'} size={s} />
      </button>
      <button className="mc" title="Next" disabled={!m.canNext} onClick={e => { e.currentTarget.blur(); window.island.mediaControl('next') }}>
        <Icon name="next" size={s} />
      </button>
    </div>
  )
}

/** Compact pill content: art · scrolling title/artist · ⏮ ⏯ ⏭ */
export function MediaPill({ m, vertical }: { m: MediaState; vertical: boolean }) {
  if (vertical) {
    return (
      <>
        <Art m={m} size={30} />
        {isPlaying(m) && <Equalizer />}
        {/* Side edges: the same three controls, stacked. */}
        <div className="media-controls vertical">
          <Controls m={m} />
        </div>
      </>
    )
  }
  return (
    <>
      <Art m={m} size={30} />
      <span className="media-text">
        <Marquee text={m.title} className="media-title" />
        <span className="media-sub">
          {m.artist ? `${m.artist} · ` : ''}
          {m.appName}
        </span>
      </span>
      {isPlaying(m) && <Equalizer />}
      <Controls m={m} />
    </>
  )
}

function Equalizer() {
  return (
    <span className="eq" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}

/** Bigger card for Home. */
export function NowPlaying({ m }: { m: MediaState }) {
  const pos = usePosition(m)
  return (
    <div className="now-playing">
      <Art m={m} size={64} />
      <div className="np-main">
        <Marquee text={m.title} className="np-title" />
        <span className="muted small">
          {m.artist ? `${m.artist} · ` : ''}
          {m.appName}
        </span>
        {m.duration > 0 && (
          <div className="np-progress">
            <span>{fmt(pos)}</span>
            <div className="np-bar">
              <i style={{ width: `${(pos / m.duration) * 100}%` }} />
            </div>
            <span>{fmt(m.duration)}</span>
          </div>
        )}
      </div>
      <Controls m={m} big />
    </div>
  )
}

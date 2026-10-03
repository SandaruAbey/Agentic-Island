import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DockState, IslandEvent, IslandSnapshot, MediaState, PanelId } from '@shared/types'
import { IslaAvatar, type IslaAnimation } from './avatar'
import { Icon, chime, cleanErr, joinLabel, Shimmer } from './components/ui'
import { BudsRing, UsageRings } from './components/Rings'
import { MediaPill, isPlaying } from './components/Media'
import { SUGGEST_FACE, actOn, actionLabel } from './suggest'
import { HomePanel } from './panels/Home'
import { AgentPanel } from './panels/Agent'
import { GitPanel } from './panels/Git'
import { MailPanel } from './panels/Mail'
import { MeetingsPanel, fmtDuration } from './panels/Meetings'
import { UsagePanel } from './panels/Usage'
import { SchedulerPanel } from './panels/Scheduler'
import { PluginsPanel } from './panels/Plugins'
import { SettingsPanel } from './panels/Settings'
import { SecurityPanel } from './panels/Security'

type Mode = 'compact' | 'peek' | 'expanded'

const COMPACT_H = 44
const RING = 38
type Notice = Extract<IslandEvent, { type: 'notify' }>

const TABS: { id: PanelId; icon: string; label: string }[] = [
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'agent', icon: 'agent', label: 'Agent' },
  { id: 'git', icon: 'git', label: 'Git' },
  { id: 'meetings', icon: 'rec', label: 'Recordings' },
  { id: 'usage', icon: 'usage', label: 'AI usage' },
  { id: 'scheduler', icon: 'clock', label: 'Scheduler' },
  { id: 'plugins', icon: 'plugin', label: 'Plugins' },
  { id: 'settings', icon: 'settings', label: 'Settings' },
  { id: 'security', icon: 'shield', label: 'Security' }
]

const REACTION: Record<Notice['kind'], IslaAnimation> = {
  otp: 'excited',
  mail: 'happy',
  suggest: 'thinking',
  commit: 'happy',
  'run-done': 'success',
  'run-error': 'error',
  security: 'alert',
  info: 'surprised',
  reminder: 'excited',
  action: 'alert',
  device: 'happy',
  meeting: 'surprised',
  'meeting-done': 'success',
  approval: 'suspicious'
}

/** Live updates leave out outputs that didn't change — keep the copy we already have (including streamed text). */
function mergeSnapshot(prev: IslandSnapshot | null, next: IslandSnapshot): IslandSnapshot {
  if (!next.runs.some(r => r.outputOmitted)) return next
  const old = new Map((prev?.runs ?? []).map(r => [r.id, r.output]))
  return { ...next, runs: next.runs.map(r => (r.outputOmitted ? { ...r, output: old.get(r.id) ?? '', outputOmitted: false } : r)) }
}

export function App() {
  const [snap, setSnap] = useState<IslandSnapshot | null>(null)
  const [mode, setMode] = useState<Mode>('compact')
  const [panel, setPanel] = useState<PanelId>('home')
  const [pinned, setPinned] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [fromNotice, setFromNotice] = useState(false)
  const [reaction, setReaction] = useState<IslaAnimation | null>(null)
  const [typing, setTyping] = useState(false)
  const [mailUid, setMailUid] = useState<string | null>(null)
  const [meetingId, setMeetingId] = useState<string | null>(null)
  const [focusRun, setFocusRun] = useState<string | null>(null)
  const [peekMsg, setPeekMsg] = useState<string | null>(null)
  const [askText, setAskText] = useState('')
  const sugIdx = useRef(0)
  const [lastActivity, setLastActivity] = useState(Date.now())
  const [now, setNow] = useState(Date.now())
  const recording = snap?.meeting.phase === 'recording'
  useEffect(() => {
    if (!recording) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [recording])
  const collapseTimer = useRef<number>(0)
  const noticeTimer = useRef<number>(0)
  const reactionTimer = useRef<number>(0)
  const islandRef = useRef<HTMLDivElement>(null)
  const wasAsleep = useRef(false)
  const [dock, setDock] = useState<DockState | null>(null)
  const [media, setMedia] = useState<MediaState | null>(null)
  const mediaModeRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [landing, setLanding] = useState(false)
  const draggingRef = useRef(false)
  const press = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const hoverTimer = useRef<number>(0)
  const interactive = useRef(false)
  const setInteractive = (v: boolean) => {
    if (interactive.current === v) return
    interactive.current = v
    window.island.setInteractive(v)
  }

  const react = useCallback((a: IslaAnimation, ms = 3500) => {
    setReaction(a)
    window.clearTimeout(reactionTimer.current)
    reactionTimer.current = window.setTimeout(() => setReaction(null), ms)
  }, [])

  useEffect(() => {
    void window.island.getSnapshot().then(s => {
      setSnap(s)
      setDock(s.settings.dock)
      setMedia(s.media)
    })
    const off = window.island.onEvent(e => {
      if (e.type === 'snapshot') setSnap(prev => mergeSnapshot(prev, e.snapshot))
      else if (e.type === 'media') setMedia(e.media)
      else if (e.type === 'dock') {
        // Landed on an edge (or hidden/shown): new layout + a little squash-and-stretch.
        setDock(e.dock)
        if (e.dock.hidden) {
          setNotice(null)
          setFromNotice(false)
          window.clearTimeout(noticeTimer.current)
          window.clearTimeout(hoverTimer.current)
          window.clearTimeout(collapseTimer.current)
          setMode('compact')
        }
        setFromNotice(false)
        draggingRef.current = false
        setDragging(false)
        interactive.current = false
        setLanding(true)
        window.setTimeout(() => setLanding(false), 650)
      }
      else if (e.type === 'run-output') {
        setSnap(s =>
          s ? { ...s, runs: s.runs.map(r => (r.id === e.id ? { ...r, output: r.output + e.chunk } : r)) } : s
        )
      } else if (e.type === 'notify') {
        if (e.kind === 'reminder') chime()
        setNotice(e)
        react(e.kind === 'suggest' && e.icon ? SUGGEST_FACE[e.icon] : REACTION[e.kind])
        setLastActivity(Date.now())
        setMode(m => (m === 'expanded' ? m : 'peek'))
        window.clearTimeout(noticeTimer.current)
        noticeTimer.current = window.setTimeout(() => {
          setNotice(null)
          setMode(m => (m === 'peek' ? 'compact' : m))
        }, e.kind === 'approval' ? 120_000 : e.kind === 'meeting' ? 60_000 : e.kind === 'meeting-done' ? 15_000 : e.kind === 'reminder' ? 45_000 : e.kind === 'device' ? 4000 : e.kind === 'action' ? 120_000 : e.kind === 'otp' ? 20_000 : e.kind === 'suggest' || e.kind === 'commit' ? 9000 : e.kind === 'mail' ? 12_000 : 6000)
      }
    })
    const t = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => {
      off()
      window.clearInterval(t)
    }
  }, [react])

  useEffect(() => {
    if (mode === 'peek' && !notice) setMode('compact')
  }, [mode, notice])

  // A suggestion belongs to the window it was made for: when it disappears (you switched window/tab), so does its peek.
  useEffect(() => {
    if (notice?.kind !== 'suggest' || !notice.suggestionId || !snap) return
    if (!snap.suggestions.some(x => x.id === notice.suggestionId)) {
      setNotice(null)
      setAskText('')
    }
  }, [snap, notice])

  useEffect(() => {
    if (mode === 'compact' && fromNotice) setFromNotice(false)
  }, [mode, fromNotice])

  // Click-through: the window only captures the mouse while the pointer is over the island itself.
  const enter = () => {
    setInteractive(true)
    window.clearTimeout(collapseTimer.current)
    setLastActivity(Date.now())
    // Hover opens after a short pause, so a quick grab-and-drag doesn't expand it.
    // With media showing, the pill holds the controls — open it by clicking instead of hovering.
    if (mode === 'compact' && !dock?.hidden && !mediaModeRef.current) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = window.setTimeout(() => {
        if (!press.current && !draggingRef.current) setMode('expanded')
      }, 450)
    }
  }
  const collapseNow = () => {
    // Let go of the text box too, so "typing" can't keep the island open (the draft is kept).
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    setTyping(false)
    setMode(m => (m === 'expanded' || m === 'peek' ? (notice ? 'peek' : 'compact') : m))
  }
  const leave = () => {
    window.clearTimeout(hoverTimer.current)
    if (draggingRef.current) return
    setInteractive(false)
    if (pinned || dock?.hidden) return
    // While typing, wait a little longer — a quick mouse slip outside shouldn't close it.
    collapseTimer.current = window.setTimeout(() => {
      if (dock?.hidden) return
      collapseNow()
    }, typing ? 2500 : 700)
  }

  // Clicking into another app also folds the island away (unless it's pinned or the mouse is still on it).
  const blurState = useRef({ pinned, mode })
  blurState.current = { pinned, mode }
  useEffect(() => {
    const onBlur = () => {
      const st = blurState.current
      if (st.pinned || st.mode !== 'expanded' || interactive.current) return
      window.clearTimeout(collapseTimer.current)
      collapseTimer.current = window.setTimeout(collapseNow, 300)
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- drag to any edge
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, textarea, select, a')) return
    const r = islandRef.current!.getBoundingClientRect()
    press.current = { x: e.screenX, y: e.screenY, ox: e.clientX - r.left, oy: e.clientY - r.top }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* capture is best-effort */
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current
    if (!p || draggingRef.current) return
    if (Math.hypot(e.screenX - p.x, e.screenY - p.y) < 6) return
    window.clearTimeout(hoverTimer.current)
    draggingRef.current = true
    setDragging(true)
    setFromNotice(false)
    setNotice(null)
    setMode('compact')
    // While dragging the pill is always horizontal and compact.
    const w = pillWidth
    window.island.dragStart(w, COMPACT_H, Math.min(Math.max(p.ox, 20), w - 20), Math.min(p.oy, COMPACT_H - 6))
  }
  const onPointerUp = () => {
    const p = press.current
    press.current = null
    if (draggingRef.current) {
      window.island.dragEnd()
      return
    }
    if (p && mode === 'compact') {
      window.clearTimeout(hoverTimer.current)
      setMode('expanded')
    }
  }

  const running = snap?.runs.filter(r => r.status === 'running') ?? []
  const pending = snap?.runs.filter(r => r.status === 'pending-approval') ?? []
  const locked = !!snap?.security.locked
  const idleMin = (now - lastActivity) / 60_000

  const activityKind = snap?.activity?.kind ?? null

  const baseAnimation: IslaAnimation = useMemo(() => {
    if (locked) return 'sleeping'
    if (snap?.meeting.phase === 'recording') return 'listening'
    if (snap?.meeting.phase === 'processing') return 'thinking'
    if (typing) return 'listening'
    // Music on → Isla dances (sways to the beat, happy squints, little jumps) — even while a task runs or waits;
    // the orange/green dot on the pill still shows that.
    if (isPlaying(media)) return 'dancing'
    if (pending.length) return 'suspicious'
    if (running.length) return 'working'
    if (mode === 'expanded' && panel === 'git') return 'searching'
    if (mode === 'expanded') return 'idle'
    if (snap?.git?.conflicted) return 'confused'
    if (idleMin > 20) return 'sleeping'
    if (idleMin > 8) return 'drowsy'
    // Context-aware: react to what app the user is working in.
    if (activityKind === 'ide') return 'searching'     // Watching code — attentive, scanning
    if (activityKind === 'terminal') return 'working'   // Terminal work — focused
    if (activityKind === 'browser') return 'idle'        // Web browsing — relaxed watching
    if (activityKind === 'mail') return 'thinking'       // Reading mail — thoughtful
    if (activityKind === 'chat') return 'listening'      // Chat app — listening in
    if (activityKind === 'office') return 'idle'          // Documents — calm
    return 'idle'
  }, [locked, pending.length, running, typing, mode, panel, snap?.git?.conflicted, idleMin, media?.status, activityKind, snap?.meeting.phase])

  useEffect(() => {
    if (baseAnimation === 'sleeping') wasAsleep.current = true
    else if (wasAsleep.current) {
      wasAsleep.current = false
      react('waking', 2200)
    }
  }, [baseAnimation, react])

  const animation = reaction ?? baseAnimation
  type EdgePhase = 'docked' | 'retracting-dock' | 'relocating' | 'top' | 'retracting-top'
  const [edgePhase, setEdgePhase] = useState<EdgePhase>('docked')
  const transitSeq = useRef(0)

  const atTopForNotice = !!dock && dock.edge !== 'top' && ((mode !== 'expanded' && !!notice) || (mode === 'expanded' && fromNotice))

  useEffect(() => {
    if (!dock || dock.edge === 'top') {
      if (edgePhase !== 'docked') setEdgePhase('docked')
      return
    }

    const seq = ++transitSeq.current

    if (atTopForNotice) {
      if (edgePhase === 'top' || edgePhase === 'retracting-dock' || edgePhase === 'relocating') return
      setEdgePhase('retracting-dock')
      const t = window.setTimeout(async () => {
        if (transitSeq.current !== seq) return
        setEdgePhase('relocating')
        await window.island.setPeekActive(true)
        if (transitSeq.current !== seq) return
        setLanding(true)
        setEdgePhase('top')
        window.setTimeout(() => setLanding(false), 650)
      }, 220)
      return () => window.clearTimeout(t)
    } else {
      if (edgePhase === 'docked' || edgePhase === 'retracting-top' || edgePhase === 'relocating') return
      setEdgePhase('retracting-top')
      const t = window.setTimeout(async () => {
        if (transitSeq.current !== seq) return
        setEdgePhase('relocating')
        await window.island.setPeekActive(false)
        if (transitSeq.current !== seq) return
        setLanding(true)
        setEdgePhase('docked')
        window.setTimeout(() => setLanding(false), 650)
      }, 220)
      return () => window.clearTimeout(t)
    }
  }, [atTopForNotice, dock?.edge])

  if (!snap || !dock) return null

  if (edgePhase === 'relocating') {
    return <div className="stage" style={{ opacity: 0, pointerEvents: 'none' }} />
  }

  // At the side dock (left/right/bottom), while not yet at the top, NEVER render as 'peek'.
  // Keep the compact pill or tab shape so it simply tucks into the edge without flashing the notification banner at the side.
  // Expanded mode is always allowed so the user can open/interact with Isla at any docked edge.
  const effectiveMode = (dock.edge !== 'top' && edgePhase !== 'top' && mode === 'peek') ? 'compact' : mode
  const edge = (edgePhase === 'top' || edgePhase === 'retracting-top') ? 'top' : dock.edge
  const isRetractingTop = edgePhase === 'retracting-top'
  const vertical = (edge === 'left' || edge === 'right') && !dragging
  // When docked right, flip the avatar so Isla looks toward the screen (left).
  const facingLeft = edge === 'right' && !dragging
  const idle = !locked && !running.length && !pending.length && !snap.otps.length
  const mediaMode = !!snap.settings.mediaControls && !!media && (media.status === 'Playing' || media.status === 'Paused') && idle
  mediaModeRef.current = mediaMode
  // Usage rings stay visible next to the music.
  const rings = idle ? snap.limits : []
  const sugCount = locked ? 0 : snap.suggestions.length
  // Connected earbuds/headphones: icon + battery on the pill.
  const buds = snap.audioDevices?.[0] ?? null
  const meetingChip = snap.meeting.phase === 'recording' || snap.meeting.phase === 'processing'
  const pillWidth = (pending.length && !vertical ? 72 : 0) + (mediaMode ? 470 : 250) + rings.length * RING + 26 + (sugCount ? 46 : 0) + (buds ? RING : 0) + (meetingChip ? 118 : 0)
  const compactStyle = vertical
    ? { height: (mediaMode ? 232 : 84) + rings.length * (RING + 4) + 30 + (sugCount ? 40 : 0) + (buds ? RING + 4 : 0) }
    : { width: pillWidth }
  const showTab = ((dock.hidden && !dragging && edgePhase !== 'top') || edgePhase === 'retracting-dock') && edgePhase !== 'retracting-top'
  const hideArrow = { top: 'up', bottom: 'down', left: 'left', right: 'right' }[edge]
  const showArrow = { top: 'down', bottom: 'up', left: 'right', right: 'left' }[edge]

  const git = snap.git
  const changes = git ? git.staged + git.modified + git.untracked : 0
  const status = locked
    ? 'Paused — kill switch'
    : running.length
      ? `Working · ${running[0].title}`
      : pending.length
        ? `${pending.length} awaiting approval`
        : snap.otps.length
          ? `Code ready · ${snap.otps[0].from}`
          : snap.activity?.signIn && snap.mailStatus === 'watching'
            ? 'Watching for your sign-in code…'
            : snap.inbox.some(m => m.unread) && snap.activity?.kind !== 'ide'
              ? `${snap.inbox.filter(m => m.unread).length} unread mail`
              : git?.isRepo
            ? `${git.branch ?? 'HEAD'}${changes ? ` · ${changes} changed` : ''}`
            : 'Agentic Island'

  const open = (p: PanelId) => {
    setPanel(p)
    setMode('expanded')
  }
  /** Run any suggestion from the peek: answers open on Home, quick results show right in the peek. */
  const runSuggestion = async (id: string, request?: string) => {
    const sug = snap.suggestions.find(x => x.id === id)
    if (!sug) {
      setPeekMsg('That suggestion is no longer available.')
      return
    }
    setPeekMsg('Working on it…')
    setAskText('')
    const out = await actOn(sug, snap, request)
    setPeekMsg(null)
    if (out.kind === 'run' || (out.kind === 'ask' && out.result.type === 'run')) {
      setFocusRun(out.kind === 'run' ? out.run.id : (out.result as { run: { id: string } }).run.id)
      setNotice(null)
      setFromNotice(true)
      open('home')
    } else if (out.kind === 'ask' || out.kind === 'panel') {
      setNotice(null)
      setFromNotice(true)
      open(out.kind === 'panel' ? out.panel : 'home')
    } else if (out.kind === 'info' || out.kind === 'error') {
      setPeekMsg(out.text)
      window.setTimeout(() => {
        setPeekMsg(null)
        setNotice(null)
        setMode(m => (m === 'peek' ? 'compact' : m))
      }, out.kind === 'info' ? 4000 : 8000)
    } else setNotice(null)
  }

  /** ✨ on the pill: bring suggestions back one by one. */
  const reopenSuggestion = () => {
    const list = snap.suggestions
    if (!list.length) return
    const sug = list[sugIdx.current % list.length]
    sugIdx.current++
    const isCommit = sug.id.startsWith('commit:') && !!snap.proposal
    setNotice({ type: 'notify', kind: isCommit ? 'commit' : 'suggest', title: isCommit ? 'Ready to commit' : 'Isla suggests', body: isCommit ? snap.proposal!.message : sug.title, suggestionId: sug.id, icon: sug.icon })
    react(SUGGEST_FACE[sug.icon])
    setMode('peek')
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => {
      setNotice(null)
      setMode(m => (m === 'peek' ? 'compact' : m))
    }, 9000)
  }
  const commitNow = async () => {
    const p = snap?.proposal
    if (!p) return
    setPeekMsg('Committing…')
    const r = await window.island.commit(p.message, true, p.diffHash)
    setPeekMsg(r.message)
    window.setTimeout(() => {
      setPeekMsg(null)
      setNotice(null)
      setMode(m => (m === 'peek' ? 'compact' : m))
    }, r.ok ? 4000 : 8000)
  }

  const openMail = (uid: string) => {
    setMailUid(uid)
    open('mail')
  }

  return (
    <div className={`stage dock-${edge} ${dragging ? 'dragging' : ''} ${landing ? 'landing' : ''} ${isRetractingTop ? 'retracting-top' : ''}`}>
      {showTab ? (
        <div
          className={`island tab ${edgePhase === 'retracting-dock' ? 'transit' : ''}`}
          role={dock.hidden && edgePhase !== 'retracting-dock' ? 'button' : undefined}
          aria-label="Show Agentic Island"
          title={dock.hidden && edgePhase !== 'retracting-dock' ? 'Show Isla' : undefined}
          onMouseEnter={() => dock.hidden && edgePhase !== 'retracting-dock' && setInteractive(true)}
          onMouseMove={() => dock.hidden && edgePhase !== 'retracting-dock' && setInteractive(true)}
          onMouseLeave={() => dock.hidden && edgePhase !== 'retracting-dock' && setInteractive(false)}
          onClick={() => dock.hidden && edgePhase !== 'retracting-dock' && window.island.setHidden(false)}
        >
          <Icon name="chevron" size={14} className={`chev-${showArrow}`} />
          {pending.length > 0 && <i className="tab-dot orange" />}
        </div>
      ) : (
      <div
        ref={islandRef}
        className={`island ${effectiveMode} ${locked ? 'locked' : ''} ${vertical ? 'vertical' : ''}`}
        style={effectiveMode === 'compact' ? compactStyle : undefined}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onMouseMove={() => setInteractive(true)}
        onKeyDown={() => setLastActivity(Date.now())}
      >
        {effectiveMode === 'compact' && (
          <div className="compact-row" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
            <IslaAvatar animation={animation} size={30} ariaLabel={`Isla is ${animation}`} className={facingLeft ? 'face-left' : ''} />
            {snap.meeting.phase === 'recording' ? (
              <button className="rec-pill" title="Recording — click to stop and summarize" onClick={() => void window.island.meetingStop()}>
                <i className="rec-dot" />
                {!vertical && <span>REC {fmtDuration(now - (snap.meeting.recordingSince ?? now))}</span>}
                <Icon name="stop" size={10} />
              </button>
            ) : snap.meeting.phase === 'processing' ? (
              <span className="rec-pill working" title={snap.meeting.step ?? 'Summarizing'}>
                <span className="spinner small" />
                {!vertical && <Shimmer tint>Summarizing…</Shimmer>}
              </span>
            ) : null}
            {mediaMode && media ? (
              <>
                <MediaPill m={media} vertical={vertical} />
                <UsageRings limits={rings} size={RING - 6} />
              </>
            ) : (
            <>
            {!vertical && <span className="compact-text">{running.length && !locked ? <Shimmer>{status}</Shimmer> : status}</span>}
            {vertical && rings.length === 0 && <span className="compact-spacer" />}
            <UsageRings limits={rings} size={RING - 6} />
            {!vertical && !rings.length && snap.screen && !snap.screen.skipped && !locked && (
              <span className="watching" title={`Reading ${snap.screen.app} on-device`}>
                <Icon name="eye" size={13} />
              </span>
            )}
            <span className={`dot ${locked ? 'red' : running.length ? 'green pulse' : pending.length ? 'orange pulse' : snap.otps.length ? 'blue' : ''}`} />
            </>
            )}
            {buds && (
              // Battery ring like the AI-usage rings; click for the details on Home.
              <span className="buds-pill" onClick={() => setPanel('home')}>
                <BudsRing d={buds} size={RING - 6} />
              </span>
            )}
            {/* Tuck away straight from the pill — no need to open the island first. */}
            {pending.length > 0 && !vertical && (
              <button
                className="pill-review"
                title="A task is waiting for your approval"
                onClick={() => {
                  const r = pending[0]
                  setNotice({ type: 'notify', kind: 'approval', runId: r.id, title: r.mode === 'edit' ? 'Approve — can edit files' : 'Approve this task?', body: r.title })
                  react('suspicious')
                  setMode('peek')
                  window.clearTimeout(noticeTimer.current)
                  noticeTimer.current = window.setTimeout(() => {
                    setNotice(null)
                    setMode(m => (m === 'peek' ? 'compact' : m))
                  }, 120_000)
                }}
              >
                Review{pending.length > 1 ? ` ${pending.length}` : ''}
              </button>
            )}
            {sugCount > 0 && (
              <button className="pill-sugg" title={`${sugCount} suggestion${sugCount > 1 ? 's' : ''} — click to see`} onClick={reopenSuggestion}>
                <Icon name="spark" size={12} />
                {sugCount}
              </button>
            )}
            <button
              className="pill-hide"
              title="Tuck into the edge"
              aria-label="Tuck into the edge"
              onClick={() => {
                setInteractive(false)
                setNotice(null)
                setFromNotice(false)
                window.clearTimeout(noticeTimer.current)
                window.clearTimeout(hoverTimer.current)
                window.clearTimeout(collapseTimer.current)
                window.island.setHidden(true)
              }}
            >
              <Icon name="chevron" size={13} className={`chev-${hideArrow}`} />
            </button>
          </div>
        )}

        {effectiveMode === 'peek' && notice && (
          <div className="peek-row">
            <IslaAvatar animation={animation} size={52} className={facingLeft ? 'face-left' : ''} />
            <div className="peek-text">
              <strong>{notice.title}</strong>
              <span className={notice.kind === 'otp' ? 'otp-inline' : ''}>{peekMsg?.endsWith('…') ? <Shimmer>{peekMsg}</Shimmer> : peekMsg ?? notice.body}</span>
            </div>
            {notice.kind === 'approval' && notice.runId ? (
              snap.runs.some(r => r.id === notice.runId && r.status === 'pending-approval') ? (
                <div className="peek-actions">
                  <button
                    className="btn green round"
                    onClick={() => {
                      window.clearTimeout(noticeTimer.current)
                      void window.island.approveRun(notice.runId!).catch(e => setPeekMsg(cleanErr(e)))
                      setNotice(null)
                      setMode(m => (m === 'peek' ? 'compact' : m))
                    }}
                  >
                    <Icon name="check" size={12} /> Approve
                  </button>
                  <button
                    className="btn ghost round"
                    onClick={() => {
                      window.clearTimeout(noticeTimer.current)
                      void window.island.rejectRun(notice.runId!)
                      setNotice(null)
                      setMode(m => (m === 'peek' ? 'compact' : m))
                    }}
                  >
                    Reject
                  </button>
                  <button
                    className="icon-btn"
                    title="See exactly what will be sent"
                    onClick={() => {
                      window.clearTimeout(noticeTimer.current)
                      setNotice(null)
                      open('agent')
                    }}
                  >
                    <Icon name="eye" size={14} />
                  </button>
                </div>
              ) : (
                <button className="icon-btn" title="Dismiss" onClick={() => setNotice(null)}>
                  <Icon name="close" size={13} />
                </button>
              )
            ) : notice.kind === 'meeting' && snap.meeting.phase === 'detected' ? (
              <div className="peek-actions">
                <button
                  className="btn red round"
                  title="Let everyone know you are recording"
                  onClick={() => {
                    window.clearTimeout(noticeTimer.current)
                    void window.island.meetingRecord()
                    setNotice(null)
                    setMode(m => (m === 'peek' ? 'compact' : m))
                  }}
                >
                  <Icon name="rec" size={12} /> Record
                </button>
                <button
                  className="icon-btn"
                  title="Not now"
                  onClick={() => {
                    window.clearTimeout(noticeTimer.current)
                    window.island.meetingDismiss()
                    setNotice(null)
                    setMode(m => (m === 'peek' ? 'compact' : m))
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            ) : notice.kind === 'meeting-done' && notice.meetingId ? (
              <button
                className="btn primary round"
                onClick={() => {
                  window.clearTimeout(noticeTimer.current)
                  setMeetingId(notice.meetingId!)
                  setNotice(null)
                  open('meetings')
                }}
              >
                Open
              </button>
            ) : notice.kind === 'suggest' && notice.suggestionId ? (
              <div className="peek-actions">
                {(() => {
                  const sug = snap.suggestions.find(x => x.id === notice.suggestionId)
                  if (!sug) return null
                  // "Need help with this page?" — you say what you want; Isla doesn't guess.
                  if (sug.action.type === 'do' && sug.action.askUser) {
                    const go = () => askText.trim() && void runSuggestion(sug.id, askText.trim())
                    return (
                      <form
                        className="peek-ask"
                        onSubmit={e => {
                          e.preventDefault()
                          go()
                        }}
                      >
                        <input
                          autoFocus
                          value={askText}
                          disabled={!!peekMsg}
                          placeholder={sug.action.askUser}
                          onFocus={() => {
                            setTyping(true)
                            window.clearTimeout(noticeTimer.current)
                          }}
                          onBlur={() => setTyping(false)}
                          onChange={e => setAskText(e.target.value)}
                        />
                        <button className="btn primary round" type="submit" disabled={!!peekMsg || !askText.trim()}>
                          <Icon name="send" size={13} />
                        </button>
                      </form>
                    )
                  }
                  return (
                    <button className="btn primary round" disabled={!!peekMsg} onClick={() => void runSuggestion(sug.id)}>
                      {actionLabel(sug)}
                    </button>
                  )
                })()}
                <button className="icon-btn" title="Not now" onClick={() => void window.island.dismissSuggestion(notice.suggestionId!).then(() => { setNotice(null); setMode('compact') })}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            ) : notice.kind === 'commit' && snap.proposal ? (
              <div className="peek-actions">
                {snap.proposal.ok && !snap.proposal.secrets.length && (
                  <button className="btn green round" disabled={!!peekMsg} onClick={() => void commitNow()}>
                    <Icon name="push" size={13} /> Commit & push
                  </button>
                )}
                <button className="btn ghost round" onClick={() => {
                  window.clearTimeout(noticeTimer.current)
                  setNotice(null)
                  setFromNotice(true)
                  open('git')
                }}>
                  Details
                </button>
              </div>
            ) : notice.kind === 'mail' && notice.uid ? (
              <button className="btn primary round" onClick={() => {
                window.clearTimeout(noticeTimer.current)
                setNotice(null)
                setFromNotice(true)
                openMail(notice.uid!)
              }}>
                Read
              </button>
            ) : notice.kind === 'otp' && snap.otps[0] ? (
              <button className="btn primary round" onClick={() => {
                window.clearTimeout(noticeTimer.current)
                void window.island.copyOtp(snap.otps[0].id).then(() => {
                  setNotice(null)
                  setFromNotice(false)
                  setMode('compact')
                })
              }}>
                <Icon name="copy" /> Copy
              </button>
            ) : notice.kind === 'action' && notice.actionId ? (
              <div className="peek-actions">
                {snap.pendingActions.some(a => a.id === notice.actionId) ? (
                  <>
                    <button className="btn green round" onClick={() => {
                      window.clearTimeout(noticeTimer.current)
                      void window.island.decideAction(notice.actionId!, true)
                      setNotice(null)
                      setMode(m => (m === 'peek' ? 'compact' : m))
                    }}>
                      Allow
                    </button>
                    <button className="btn red round" onClick={() => {
                      window.clearTimeout(noticeTimer.current)
                      void window.island.decideAction(notice.actionId!, false)
                      setNotice(null)
                      setMode(m => (m === 'peek' ? 'compact' : m))
                    }}>
                      Deny
                    </button>
                  </>
                ) : (
                  <button className="icon-btn" title="Dismiss" onClick={() => setNotice(null)}>
                    <Icon name="close" size={13} />
                  </button>
                )}
              </div>
            ) : notice.kind === 'device' ? (
              <span className="peek-device">
                <Icon name="buds" size={20} />
              </span>
            ) : notice.kind === 'reminder' && notice.reminderId && snap.alerts.some(a => a.id === notice.reminderId) ? (
              (() => {
                const al = snap.alerts.find(a => a.id === notice.reminderId)!
                const ack = (action: 'done' | 'snooze' | 'open') => {
                  window.clearTimeout(noticeTimer.current)
                  void window.island.ackReminder(al.id, action)
                  setNotice(null)
                  setFromNotice(false)
                  setMode(m => (m === 'peek' ? 'compact' : m))
                }
                return (
                  <div className="peek-actions">
                    {al.url && (
                      <button className="btn green round" onClick={() => ack('open')}>
                        {joinLabel(al.url)}
                      </button>
                    )}
                    <button className="btn ghost round" onClick={() => ack('snooze')} title="Remind me again in 5 minutes">
                      Snooze 5m
                    </button>
                    <button className="icon-btn" title={al.kind === 'alarm' ? 'Stop alarm' : 'Done'} onClick={() => ack('done')}>
                      <Icon name="check" size={14} />
                    </button>
                  </div>
                )
              })()
            ) : notice.kind === 'reminder' || notice.url ? (
              <div className="peek-actions">
                {notice.url && (
                  <button className="btn green round" onClick={() => {
                    window.clearTimeout(noticeTimer.current)
                    void window.island.openUrl(notice.url!)
                    setNotice(null)
                    setFromNotice(false)
                    setMode('compact')
                  }}>
                    Join / Open
                  </button>
                )}
                <button className="icon-btn" title="Dismiss" onClick={() => {
                  window.clearTimeout(noticeTimer.current)
                  setNotice(null)
                  setFromNotice(false)
                  setMode('compact')
                }}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            ) : (
              <button className="btn ghost round" onClick={() => {
                window.clearTimeout(noticeTimer.current)
                setNotice(null)
                setFromNotice(true)
                open(notice.panel ?? (notice.kind === 'security' ? 'security' : 'agent'))
              }}>
                Open
              </button>
            )}
          </div>
        )}

        {effectiveMode === 'expanded' && (
          <div className="expanded">
            <header className="ex-head" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
              <IslaAvatar animation={animation} size={46} className={facingLeft ? 'face-left' : ''} />
              <div className="ex-title" title="Drag to move Isla to any screen edge">
                <strong>Isla</strong>
                <span>{locked || running.length || pending.length || snap.otps.length ? status : 'Product by FiveNeurals'}</span>
              </div>
              {buds && (
                <div className="head-buds" title={`${buds.name}${buds.battery !== null ? ` · ${buds.battery}% battery` : ' · connected'}`}>
                  <BudsRing d={buds} size={30} />
                  <span>
                    <strong>{buds.name}</strong>
                    <em>{buds.battery !== null ? `${buds.battery}% battery` : 'Connected'}</em>
                  </span>
                </div>
              )}
              <nav className="tabs" aria-label="Panels">
                {TABS.map(t => (
                  <button
                    key={t.id}
                    className={`tab ${panel === t.id ? 'active' : ''}`}
                    title={t.label}
                    aria-label={t.label}
                    onClick={() => {
                      if (t.id === 'mail') setMailUid(null)
                      if (t.id === 'meetings') setMeetingId(null)
                      setPanel(t.id)
                    }}
                  >
                    <Icon name={t.icon} size={17} />
                    {t.id === 'agent' && pending.length > 0 && <i className="badge">{pending.length}</i>}
                    {t.id === 'mail' && (snap.otps.length > 0 || snap.inbox.some(m => m.unread)) && (
                      <i className="badge blue">{snap.otps.length || snap.inbox.filter(m => m.unread).length}</i>
                    )}
                    {t.id === 'scheduler' && snap.scheduledTasks.some(x => x.lastRunStatus === 'error') && <i className="badge">!</i>}
                    {t.id === 'plugins' && snap.plugins.some(x => x.running) && <i className="badge blue">•</i>}
                  </button>
                ))}
              </nav>
              <button className={`icon-btn ${pinned ? 'active' : ''}`} title={pinned ? 'Unpin' : 'Keep open'} onClick={() => setPinned(p => !p)}>
                <Icon name="pin" />
              </button>
              <button
                className="icon-btn"
                title="Tuck into the edge"
                onClick={() => {
                  setInteractive(false)
                  setNotice(null)
                  setFromNotice(false)
                  window.clearTimeout(noticeTimer.current)
                  window.clearTimeout(hoverTimer.current)
                  window.clearTimeout(collapseTimer.current)
                  setMode('compact')
                  window.island.setHidden(true)
                }}
              >
                <Icon name="chevron" size={15} className={`chev-${hideArrow}`} />
              </button>
              {locked ? (
                <button className="btn green round sm" onClick={() => void window.island.resume()}>
                  Resume
                </button>
              ) : (
                <button className="kill" title={`Kill switch (${snap.security.killShortcut})`} onClick={() => void window.island.killSwitch()}>
                  <Icon name="stop" size={14} />
                </button>
              )}
            </header>
            <main className="ex-body">
              {panel === 'home' && <HomePanel snap={snap} open={open} onTyping={setTyping} openMail={openMail} focusRun={focusRun} media={snap.settings.mediaControls ? media : null} />}
              {panel === 'agent' && <AgentPanel snap={snap} />}
              {panel === 'git' && <GitPanel snap={snap} />}
              {panel === 'meetings' && <MeetingsPanel key={meetingId ?? 'list'} snap={snap} initialId={meetingId} onTyping={setTyping} />}
              {panel === 'mail' && <MailPanel key={mailUid ?? 'inbox'} snap={snap} open={open} initialUid={mailUid} />}
              {panel === 'usage' && <UsagePanel limits={snap.limits} />}
              {panel === 'scheduler' && <SchedulerPanel snap={snap} onTyping={setTyping} />}
              {panel === 'plugins' && <PluginsPanel snap={snap} onTyping={setTyping} />}
              {panel === 'settings' && <SettingsPanel snap={snap} onTyping={setTyping} />}
              {panel === 'security' && <SecurityPanel snap={snap} />}
            </main>
          </div>
        )}
      </div>
      )}
    </div>
  )
}

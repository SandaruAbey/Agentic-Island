/**
 * Procedural avatar with the same public API as `@bible-strong/avatar-react`
 * (createAvatar, Avatar props, AvatarController ref). When that package is published you can
 * swap the import in `./index.ts` without touching the rest of the app.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties, type Ref } from 'react'

export interface EyeShape {
  x: number
  y: number
  w: number
  h: number
  r: number
}
export interface BodyShape {
  sx: number
  sy: number
  rot: number
  bob: number
  wobble: number
  speed: number
}
export interface ExpressionDef {
  eyes: [EyeShape, EyeShape]
  body?: Partial<BodyShape>
}
export interface AnimationDef {
  loop?: boolean
  next?: string
  steps: { expression: string; duration: number }[]
}
export interface AvatarDefinition {
  name: string
  palette: { body: string; eye: string; shade?: string }
  expressions: Record<string, ExpressionDef>
  animations: Record<string, AnimationDef>
}

export type AnimationKey = string
export type ExpressionKey = string
export interface AvatarRuntimeError {
  code: 'UNKNOWN_ANIMATION' | 'UNKNOWN_EXPRESSION' | 'CONTROLLED'
  key: string
  message: string
}
export type AvatarCommandResult = { ok: true } | { ok: false; error: AvatarRuntimeError }
export interface AvatarPlaybackState {
  animation: string | null
  expression: string
  status: 'playing' | 'paused' | 'stopped'
}
export interface AvatarController<A extends string = string, E extends string = string> {
  play(animation: A): AvatarCommandResult
  pause(): void
  stop(): void
  setExpression(expression: E): AvatarCommandResult
  getState(): AvatarPlaybackState
}

export interface AvatarProps<A extends string = string, E extends string = string> {
  definition: AvatarDefinition
  animation?: A
  expression?: E
  defaultAnimation?: A
  defaultExpression?: E
  autoplay?: boolean
  size?: number | string
  className?: string
  style?: CSSProperties
  ariaLabel?: string
  onAnimationEnd?: (animation: A) => void
  onExpressionChange?: (expression: E) => void
  onError?: (error: AvatarRuntimeError) => void
}

const DEFAULT_BODY: BodyShape = { sx: 1, sy: 1, rot: 0, bob: 0.8, wobble: 0.035, speed: 1 }
const NEUTRAL = 'neutral'

export function validateDefinition(def: AvatarDefinition): AvatarDefinition {
  if (!def?.expressions || !def.animations) throw new Error('Avatar definition needs expressions and animations')
  if (!def.expressions[NEUTRAL]) throw new Error('Avatar definition needs a "neutral" expression')
  for (const [k, a] of Object.entries(def.animations)) {
    if (!a.steps?.length) throw new Error(`Animation "${k}" has no steps`)
    for (const s of a.steps) if (!def.expressions[s.expression]) throw new Error(`Animation "${k}" references unknown expression "${s.expression}"`)
    if (a.next && !def.animations[a.next]) throw new Error(`Animation "${k}" chains to unknown animation "${a.next}"`)
  }
  return def
}

// Flattened numeric state so interpolation is a simple loop.
type Vec = number[] // [L.x,L.y,L.w,L.h,L.r, R.x..R.r, sx,sy,rot,bob,wobble,speed]
function toVec(e: ExpressionDef): Vec {
  const b = { ...DEFAULT_BODY, ...e.body }
  const [l, r] = e.eyes
  return [l.x, l.y, l.w, l.h, l.r, r.x, r.y, r.w, r.h, r.r, b.sx, b.sy, b.rot, b.bob, b.wobble, b.speed]
}

/** Smooth closed path through points (Catmull-Rom → cubic Bézier). */
function blobPath(pts: [number, number][]): string {
  const n = pts.length
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const p3 = pts[(i + 2) % n]
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`
  }
  return d + 'Z'
}

export const Avatar = forwardRef(function Avatar(props: AvatarProps, ref: Ref<AvatarController>) {
  const { definition, size = 240, className, style, ariaLabel = 'Procedural avatar', autoplay = true } = props
  const bodyRef = useRef<SVGPathElement>(null)
  const shadeRef = useRef<SVGPathElement>(null)
  const eyeRefs = [useRef<SVGRectElement>(null), useRef<SVGRectElement>(null)]
  const groupRef = useRef<SVGGElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  const controlled = props.animation !== undefined || props.expression !== undefined
  const st = useRef({
    animation: null as string | null,
    step: 0,
    stepElapsed: 0,
    status: 'stopped' as AvatarPlaybackState['status'],
    expression: NEUTRAL,
    current: toVec(definition.expressions[NEUTRAL]),
    target: toVec(definition.expressions[NEUTRAL]),
    time: Math.random() * 100,
    nextBlink: 2500,
    blinkLeft: 0
  })

  const err = (code: AvatarRuntimeError['code'], key: string): AvatarCommandResult => {
    const error: AvatarRuntimeError = { code, key, message: `${code}: ${key}` }
    propsRef.current.onError?.(error)
    return { ok: false, error }
  }

  const showExpression = (key: string) => {
    const s = st.current
    const e = definition.expressions[key]
    if (!e) return
    s.target = toVec(e)
    if (s.expression !== key) {
      s.expression = key
      propsRef.current.onExpressionChange?.(key)
    }
  }

  const playInternal = (key: string): AvatarCommandResult => {
    const a = definition.animations[key]
    if (!a) return err('UNKNOWN_ANIMATION', key)
    const s = st.current
    if (s.animation !== key || s.status === 'stopped') {
      s.animation = key
      s.step = 0
      s.stepElapsed = 0
      showExpression(a.steps[0].expression)
    }
    s.status = 'playing'
    return { ok: true }
  }

  const setExpressionInternal = (key: string): AvatarCommandResult => {
    if (!definition.expressions[key]) return err('UNKNOWN_EXPRESSION', key)
    const s = st.current
    s.animation = null
    s.status = 'stopped'
    showExpression(key)
    return { ok: true }
  }

  useImperativeHandle(ref, () => ({
    play: a => (controlled ? err('CONTROLLED', a) : playInternal(a)),
    pause: () => {
      if (st.current.status === 'playing') st.current.status = 'paused'
    },
    stop: () => {
      if (controlled) return
      st.current.animation = null
      st.current.status = 'stopped'
      showExpression(NEUTRAL)
    },
    setExpression: e => (controlled ? err('CONTROLLED', e) : setExpressionInternal(e)),
    getState: () => ({ animation: st.current.animation, expression: st.current.expression, status: st.current.status })
  }))

  // Initial (uncontrolled) target
  useEffect(() => {
    if (props.animation !== undefined || props.expression !== undefined) return
    if (props.defaultAnimation && autoplay) playInternal(props.defaultAnimation)
    else if (props.defaultExpression) setExpressionInternal(props.defaultExpression)
    else if (props.defaultAnimation) {
      const a = definition.animations[props.defaultAnimation]
      if (a) showExpression(a.steps[0].expression)
      else err('UNKNOWN_ANIMATION', props.defaultAnimation)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Controlled target
  useEffect(() => {
    if (props.animation !== undefined) playInternal(props.animation)
    else if (props.expression !== undefined) setExpressionInternal(props.expression)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.animation, props.expression])

  // Render loop — mutates SVG attributes directly, no React re-render per frame.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const frame = (now: number) => {
      // rAF timestamps can be slightly older than performance.now() on the first frame — never step backwards.
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
      last = now
      const s = st.current

      // Timeline
      if (s.status === 'playing' && s.animation) {
        const a = definition.animations[s.animation]
        s.stepElapsed += dt * 1000
        if (s.stepElapsed >= a.steps[s.step].duration) {
          s.stepElapsed = 0
          s.step++
          if (s.step >= a.steps.length) {
            if (a.loop) s.step = 0
            else {
              const ended = s.animation
              s.step = a.steps.length - 1
              s.status = 'stopped'
              propsRef.current.onAnimationEnd?.(ended)
              if (a.next && !controlled) playInternal(a.next)
              else if (a.next && controlled) {
                s.animation = a.next
                s.step = 0
                s.status = 'playing'
              }
            }
          }
          if (s.animation) showExpression(definition.animations[s.animation].steps[s.step].expression)
        }
      }

      // Spring toward target
      const k = 1 - Math.exp(-dt * 14)
      for (let i = 0; i < s.current.length; i++) s.current[i] += (s.target[i] - s.current[i]) * k
      const v = s.current
      s.time += dt * v[15]

      // Idle blinking (only while eyes are open)
      const open = v[3] > 5 && v[8] > 5
      s.nextBlink -= dt * 1000
      if (s.nextBlink <= 0 && open) {
        s.blinkLeft = 130
        s.nextBlink = 2200 + Math.random() * 4000
      }
      const blink = s.blinkLeft > 0 ? 0.15 : 1
      if (s.blinkLeft > 0) s.blinkLeft -= dt * 1000

      // Body
      const wob = reduced ? 0 : v[14]
      const pts: [number, number][] = []
      const N = 14
      for (let i = 0; i < N; i++) {
        const th = (i / N) * Math.PI * 2
        const r =
          38 *
          (1 +
            0.06 * Math.sin(th * 2 + 0.9) + // organic, slightly egg-shaped base
            0.03 * Math.cos(th * 3 - 0.4) +
            wob * Math.sin(th * 3 + s.time * 1.7) +
            wob * 0.6 * Math.cos(th * 2 - s.time * 1.3))
        pts.push([50 + Math.cos(th) * r * v[10], 54 + Math.sin(th) * r * v[11]])
      }
      const d = blobPath(pts)
      bodyRef.current?.setAttribute('d', d)
      shadeRef.current?.setAttribute('d', d)
      const bob = reduced ? 0 : Math.sin(s.time * 2.2) * v[13]
      groupRef.current?.setAttribute('transform', `translate(0 ${bob.toFixed(2)}) rotate(${v[12].toFixed(2)} 50 54)`)

      // Eyes
      for (let e = 0; e < 2; e++) {
        const o = e * 5
        const w = v[o + 2]
        const h = Math.max(1.2, v[o + 3] * blink)
        const el = eyeRefs[e].current
        if (!el) continue
        el.setAttribute('x', (v[o] - w / 2).toFixed(2))
        el.setAttribute('y', (v[o + 1] - h / 2).toFixed(2))
        el.setAttribute('width', w.toFixed(2))
        el.setAttribute('height', h.toFixed(2))
        el.setAttribute('rx', (Math.min(w, h) / 2).toFixed(2))
        el.setAttribute('transform', `rotate(${v[o + 4].toFixed(2)} ${v[o].toFixed(2)} ${v[o + 1].toFixed(2)})`)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition])

  const dim = typeof size === 'number' ? `${size}px` : size
  const id = useRef(`av${Math.random().toString(36).slice(2, 8)}`).current
  return (
    <div className={`avatar-root ${className ?? ''}`} style={{ ...style, width: dim, height: dim }} role="img" aria-label={ariaLabel}>
      <svg viewBox="0 0 100 100" width="100%" height="100%" overflow="visible">
        <defs>
          <clipPath id={`${id}-clip`}>
            <path ref={shadeRef} />
          </clipPath>
        </defs>
        <g ref={groupRef}>
          <path ref={bodyRef} fill={definition.palette.body} />
          {definition.palette.shade && (
            <ellipse cx="34" cy="80" rx="30" ry="18" fill={definition.palette.shade} opacity="0.55" clipPath={`url(#${id}-clip)`} />
          )}
          <rect ref={eyeRefs[0]} fill={definition.palette.eye} />
          <rect ref={eyeRefs[1]} fill={definition.palette.eye} />
        </g>
      </svg>
    </div>
  )
})

type Keys<T> = Extract<keyof T, string>

/** Validate a definition and return a component with typed animation/expression keys. */
export function createAvatar<D extends AvatarDefinition>(json: D) {
  const def = validateDefinition(json)
  type A = Keys<D['animations']>
  type E = Keys<D['expressions']>
  const Concrete = forwardRef<AvatarController<A, E>, Omit<AvatarProps<A, E>, 'definition'>>(function ConcreteAvatar(p, ref) {
    return <Avatar {...(p as AvatarProps)} definition={def} ref={ref as Ref<AvatarController>} />
  })
  Concrete.displayName = `Avatar(${def.name})`
  return Concrete
}

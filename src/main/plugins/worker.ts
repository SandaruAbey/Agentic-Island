import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { HostCall, HostMessage, WorkerMessage } from './protocol'

/**
 * Runs one plugin tool inside its own utility process (forked by PluginHost). The plugin gets a `ctx` object:
 * Isla-provided powers (AI, notify, storage, reports) are calls back to the main process, which checks permissions;
 * `ctx.http` is a plain, size- and time-limited fetch helper that runs here.
 */

const port = process.parentPort
const post = (m: WorkerMessage) => port.postMessage(m)

let seq = 0
const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()

function call<T>(c: HostCall): Promise<T> {
  const callId = ++seq
  return new Promise<T>((res, rej) => {
    pending.set(callId, { res: res as (v: unknown) => void, rej })
    post({ type: 'call', callId, ...c } as WorkerMessage)
  })
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 IslaPlugin/1.0'

interface HttpResponse {
  ok: boolean
  status: number
  /** Final URL after redirects. */
  url: string
  headers: Record<string, string>
  cookies: string[]
  text: string
  /** Total time, and time until the response headers arrived (server response time). */
  ms: number
  ttfb: number
}

interface HttpOptions {
  method?: 'GET' | 'POST' | 'HEAD'
  /** A string is sent as-is; anything else as JSON. */
  body?: unknown
  timeoutMs?: number
  maxBytes?: number
  headers?: Record<string, string>
  /** 'manual': don't follow redirects (status 301/302 with a location header comes back). */
  redirect?: 'follow' | 'manual'
}

async function request(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
  if (!/^https?:\/\//i.test(url)) throw new Error(`Not a web address: ${url}`)
  const headers: Record<string, string> = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8' }
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = String(v)
  let body: string | undefined
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    if (typeof opts.body !== 'string') headers['content-type'] ??= 'application/json'
  }
  const t0 = Date.now()
  const r = await fetch(url, {
    method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
    body,
    redirect: opts.redirect === 'manual' ? 'manual' : 'follow',
    signal: AbortSignal.timeout(Math.min(opts.timeoutMs ?? 15_000, 180_000)),
    headers
  })
  const ttfb = Date.now() - t0
  const max = Math.min(opts.maxBytes ?? 2_000_000, 20_000_000)
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = r.body?.getReader()
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value)
      size += value.length
      if (size >= max) {
        void reader.cancel()
        break
      }
    }
  }
  return {
    ok: r.ok,
    status: r.status,
    url: r.url || url,
    headers: Object.fromEntries(r.headers),
    cookies: r.headers.getSetCookie?.() ?? [],
    text: Buffer.concat(chunks).toString('utf8'),
    ms: Date.now() - t0,
    ttfb
  }
}

async function run(m: Extract<HostMessage, { type: 'run' }>): Promise<void> {
  const mod = m.entry.endsWith('.mjs') ? await import(pathToFileURL(m.entry).href) : createRequire(m.entry)(m.entry)
  const plugin = mod?.default ?? mod
  const tool = plugin?.tools?.[m.toolId]
  if (typeof tool !== 'function') throw new Error(`The plugin has no tool "${m.toolId}" (export it as tools.${m.toolId}).`)

  const ctx = {
    pluginId: m.pluginId,
    toolId: m.toolId,
    input: m.input,
    settings: Object.freeze({ ...m.settings }),
    log: (...parts: unknown[]) => post({ type: 'log', text: parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ').slice(0, 500) }),
    progress: (value: number | null, text?: string) => post({ type: 'progress', value: value === null ? null : Math.max(0, Math.min(1, Number(value) || 0)), text }),
    http: {
      get: (url: string, opts: Omit<HttpOptions, 'method' | 'body'> = {}) => request(url, { ...opts, method: 'GET' }),
      post: (url: string, body: unknown, opts: Omit<HttpOptions, 'method' | 'body'> = {}) => request(url, { ...opts, method: 'POST', body }),
      request
    },
    ai: {
      /** Cheap, tool-less call with the background model (no web). Needs the "ai" permission. */
      ask: (prompt: string, opts: { system?: string } = {}) => call<string>({ method: 'ai.ask', args: [String(prompt), String(opts.system ?? '')] }),
      /** A read-only agent run with web search, shown in Isla's task list. Needs "ai-web". */
      research: (prompt: string, opts: { title?: string } = {}) => call<string>({ method: 'ai.research', args: [String(prompt), String(opts.title ?? '')] })
    },
    /** Permission "browser": a private Isla browser window (its own profile — never your signed-in sites). */
    browser: {
      open: (url: string, opts: { width?: number; height?: number; timeoutMs?: number; fresh?: boolean } = {}) =>
        call<{ url: string; title: string; status: number | null }>({ method: 'browser.open', args: [String(url), opts] }),
      eval: <T = unknown>(script: string, timeoutMs = 30_000) => call<T>({ method: 'browser.eval', args: [String(script), timeoutMs] }),
      show: (show = true) => call<void>({ method: 'browser.show', args: [show === true] }),
      close: () => call<void>({ method: 'browser.close', args: [] })
    },
    notify: (title: string, body = '') => call<void>({ method: 'notify', args: [String(title), String(body)] }),
    storage: {
      get: <T = unknown>(key: string) => call<T | null>({ method: 'storage.get', args: [String(key)] }),
      set: (key: string, value: unknown) => call<void>({ method: 'storage.set', args: [String(key), value] })
    },
    report: {
      /** Saves report.md (+ extra files like a CSV) to Documents\Agentic Island\Reports. Returns the folder. */
      save: (r: { title: string; markdown: string; files?: Record<string, string> }) => call<string>({ method: 'report.save', args: [r] })
    }
  }

  const out = await tool(ctx)
  const summary = typeof out === 'string' ? out : typeof out?.summary === 'string' ? out.summary : 'Done.'
  post({ type: 'done', summary: summary.slice(0, 8000) })
}

port.on('message', e => {
  const m = e.data as HostMessage
  if (m.type === 'reply') {
    const p = pending.get(m.callId)
    if (!p) return
    pending.delete(m.callId)
    if (m.ok) p.res(m.value)
    else p.rej(new Error(m.error))
    return
  }
  // The host ends this process once it has the result (a plugin may leave timers or sockets open).
  if (m.type === 'run')
    run(m).catch(err =>
      post({ type: 'error', message: String((err as Error)?.message ?? err).slice(0, 1000), stack: String((err as Error)?.stack ?? '').slice(0, 2000) })
    )
})

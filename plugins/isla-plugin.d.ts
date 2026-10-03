/**
 * Types for Isla plugins. In a plugin's index.js add `// @ts-check` and
 *   /** @typedef {import('../isla-plugin').PluginContext} Ctx *\/
 * to get autocomplete. (Copy this file next to your plugin folder if you develop it elsewhere.)
 */

export type PluginValue = string | number | boolean

export interface HttpResponse {
  ok: boolean
  status: number
  /** Final URL after redirects. */
  url: string
  /** Lower-case header names. */
  headers: Record<string, string>
  /** Raw Set-Cookie values. */
  cookies: string[]
  /** Body as text (cut at maxBytes). */
  text: string
  /** Total time, in ms. */
  ms: number
  /** Time until the response headers arrived (server response time), in ms. */
  ttfb: number
}

export interface HttpOptions {
  /** Default 15 s, max 180 s. */
  timeoutMs?: number
  /** Default 2 MB, max 20 MB. */
  maxBytes?: number
  headers?: Record<string, string>
  /** 'manual' returns redirects (301/302 + location header) instead of following them. */
  redirect?: 'follow' | 'manual'
}

export interface PluginContext {
  pluginId: string
  toolId: string
  /** text: the chat message that started the tool ('' when run from the panel or a schedule). */
  input: { text: string; trigger: 'manual' | 'chat' | 'schedule' }
  /** The user's values for the "settings" in isla-plugin.json (defaults filled in; "secret" ones decrypted). */
  settings: Readonly<Record<string, PluginValue>>
  /** A line in the live log on the plugin card. console.log works too. */
  log(...parts: unknown[]): void
  /** 0–1 (or null for "unknown"), with an optional log line. */
  progress(value: number | null, text?: string): void
  http: {
    /** GET with a browser-like user agent. */
    get(url: string, opts?: HttpOptions): Promise<HttpResponse>
    /** POST; a string body is sent as-is, anything else as JSON. */
    post(url: string, body: unknown, opts?: HttpOptions): Promise<HttpResponse>
    request(url: string, opts?: HttpOptions & { method?: 'GET' | 'POST' | 'HEAD'; body?: unknown }): Promise<HttpResponse>
  }
  ai: {
    /** Permission "ai". A cheap, tool-less call with the user's background model — no web. Max 30 per run. */
    ask(prompt: string, opts?: { system?: string }): Promise<string>
    /** Permission "ai-web". A read-only agent run with web search; it shows in Isla's task list. Max 5 per run. */
    research(prompt: string, opts?: { title?: string }): Promise<string>
  }
  /**
   * Permission "browser". A real Chromium window with its own private profile (never the user's signed-in Isla browser).
   * Hidden unless you call show(); closed automatically when the run ends.
   */
  browser: {
    /** Load a page (fresh: clear the cache first, e.g. to measure speed). Returns the final URL, title and HTTP status. */
    open(url: string, opts?: { width?: number; height?: number; timeoutMs?: number; fresh?: boolean }): Promise<{ url: string; title: string; status: number | null }>
    /** Run JavaScript in the page; returns its JSON result (promises are awaited). */
    eval<T = unknown>(script: string, timeoutMs?: number): Promise<T>
    show(show?: boolean): Promise<void>
    close(): Promise<void>
  }
  /** Permission "notify". A peek on the island. Max 3 per run. */
  notify(title: string, body?: string): Promise<void>
  /** This plugin's own JSON storage (1 MB), kept between runs. */
  storage: {
    get<T = unknown>(key: string): Promise<T | null>
    /** null/undefined deletes the key. */
    set(key: string, value: unknown): Promise<void>
  }
  report: {
    /**
     * Saves report.md (+ extra .md/.csv/.json/.txt/.html files) to Documents\Agentic Island\Reports\<plugin>\<date time>\.
     * The Plugins tab gets "Open report" for this run. Returns the folder.
     */
    save(report: { title: string; markdown: string; files?: Record<string, string> }): Promise<string>
  }
}

/** What a tool returns: a short Markdown summary for the panel and chat (or just a string). */
export type ToolResult = string | { summary: string } | void

export interface IslaPlugin {
  /** One function per tool id listed in isla-plugin.json. */
  tools: Record<string, (ctx: PluginContext) => Promise<ToolResult> | ToolResult>
}

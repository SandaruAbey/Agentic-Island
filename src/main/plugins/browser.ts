import { app, BrowserWindow, session } from 'electron'

/**
 * A browser window a plugin can drive (open a page, run a script in it, read the result).
 * Its own saved profile — never Isla's main browser profile — so a plugin can't see the sites you signed in to.
 * Hidden unless the plugin (or its settings) asks to show it; closed when the run ends.
 * A hidden window is rendered offscreen: Chromium doesn't paint a plain hidden window, and without painting
 * pages never report paint timings (FCP, LCP) — so speed measurements need real (offscreen) rendering.
 */
const PARTITION = 'persist:isla-plugins'
let sessionReady = false

const timeout = (ms: number, what: string) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} took longer than ${Math.round(ms / 1000)} s.`)), ms))

export class PluginBrowser {
  private win: BrowserWindow | null = null
  /** Show a real window the user can watch (otherwise: offscreen). */
  private visible = false

  constructor(
    private title: string,
    private icon?: string
  ) {}

  private ensure(width?: number, height?: number): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) {
      if (width && height) this.win.setContentSize(width, height)
      return this.win
    }
    const ses = session.fromPartition(PARTITION)
    if (!sessionReady) {
      sessionReady = true
      // Look like plain Chrome — some sites refuse "Electron".
      ses.setUserAgent(app.userAgentFallback.replace(/\s(Electron|agentic-island|Agentic Island)\/\S+/gi, ''))
      ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
      ses.setPermissionCheckHandler(() => false)
      ses.on('will-download', e => e.preventDefault())
    }
    const win = new BrowserWindow({
      width: width ?? 1280,
      height: height ?? 900,
      useContentSize: true,
      show: false,
      skipTaskbar: !this.visible,
      title: this.title,
      icon: this.icon,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: PARTITION,
        offscreen: !this.visible,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        backgroundThrottling: false,
        spellcheck: false
      }
    })
    const wc = win.webContents
    if (!this.visible) wc.setFrameRate(30)
    else win.showInactive()
    wc.setAudioMuted(true)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (e, url) => {
      if (!/^https?:/i.test(url)) e.preventDefault()
    })
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    this.win = win
    return win
  }

  /** Load a page and wait for it (a page that never "finishes" — maps, feeds — is fine: we go on after the timeout). */
  async open(url: string, opts: { width?: number; height?: number; timeoutMs?: number; fresh?: boolean } = {}): Promise<{ url: string; title: string; status: number | null }> {
    if (!/^https?:\/\//i.test(url)) throw new Error(`Not a web address: ${url}`)
    const win = this.ensure(opts.width, opts.height)
    const wc = win.webContents
    if (opts.fresh) await wc.session.clearCache()
    let status: number | null = null
    const onNav = (_e: unknown, _url: string, code: number) => {
      status = code
    }
    wc.once('did-navigate', onNav)
    try {
      await Promise.race([
        wc.loadURL(url).catch((e: Error) => {
          // ERR_ABORTED = the page redirected itself; the new page is what we want.
          if (!/ERR_ABORTED|\(-3\)/.test(e.message)) throw new Error(`Could not open ${url}: ${e.message.replace(/^.*?(ERR_\w+).*$/, '$1')}`)
        }),
        timeout(Math.min(opts.timeoutMs ?? 45_000, 120_000), 'Loading the page').catch(() => undefined)
      ])
    } finally {
      wc.removeListener('did-navigate', onNav)
    }
    return { url: wc.getURL(), title: wc.getTitle(), status }
  }

  /** Run a script in the page and return its (JSON) result. Promises are awaited. */
  async eval(script: string, timeoutMs = 30_000): Promise<unknown> {
    const wc = this.win && !this.win.isDestroyed() ? this.win.webContents : null
    if (!wc) throw new Error('Open a page first (ctx.browser.open).')
    const v = await Promise.race([wc.executeJavaScript(String(script), true), timeout(Math.min(timeoutMs, 120_000), 'The page script')])
    const json = JSON.stringify(v ?? null)
    if (json.length > 5_000_000) throw new Error('The page script returned more than 5 MB.')
    return JSON.parse(json)
  }

  /** Switch between a window the user can watch and offscreen rendering (the next page opens in the new mode). */
  show(on: boolean): void {
    if (on === this.visible) return
    this.visible = on
    this.close()
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}

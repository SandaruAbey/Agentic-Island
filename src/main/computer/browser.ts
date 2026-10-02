import { app, BrowserWindow, session, WebContentsView, type WebContents } from 'electron'

/**
 * Isla's own browser for computer-use tasks: a separate Chromium window with its own saved profile
 * (sign in once — cookies persist). It works hidden, so it never takes over your screen, mouse or keyboard;
 * you can show it any time to watch or to sign in.
 */
const PARTITION = 'persist:isla-browser'

/** Runs in the page: number the visible interactive elements and return the page as text. */
const READ_PAGE = `(() => {
  const vis = el => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const sel = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=switch], [role=checkbox], [role=option], [role=row], [role=listitem], [role=treeitem], [role=searchbox], [role=textbox], [role=combobox], [contenteditable=""], [contenteditable=true], [onclick], tr[jsaction]'
  let n = 0
  const els = []
  document.querySelectorAll('[data-isla-ref]').forEach(e => e.removeAttribute('data-isla-ref'))
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el) || n >= 250) continue
    const ref = String(++n)
    el.setAttribute('data-isla-ref', ref)
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('value') || '').replace(/\\s+/g, ' ').trim().slice(0, 100)
    const value = type === 'password' ? '' : ('value' in el && typeof el.value === 'string' ? el.value.slice(0, 100) : '')
    els.push('[' + ref + '] ' + (el.getAttribute('role') || tag) + (type ? ':' + type : '') + ' "' + label + '"' + (value ? ' value="' + value + '"' : '') + (tag === 'a' && el.href ? ' -> ' + el.href.slice(0, 120) : ''))
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 15000)
  return { url: location.href, title: document.title, text, elements: els }
})()`

/** Runs in the page: describe element [ref] (for the risk check) and scroll it into view. */
const DESCRIBE = (ref: string) => `(() => {
  const el = document.querySelector('[data-isla-ref="${ref}"]')
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  const form = el.closest('form')
  const type = (el.getAttribute('type') || '').toLowerCase()
  return {
    label: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('value') || el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
    tag: el.tagName.toLowerCase(),
    type,
    role: el.getAttribute('role') || '',
    password: type === 'password' || !!(form && form.querySelector('input[type=password]')),
    search: type === 'search' || /search|combobox/.test(el.getAttribute('role') || '') || /(^q$|search|query)/i.test((el.getAttribute('name') || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '')),
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    w: r.width,
    h: r.height
  }
})()`

export interface ElementInfo {
  label: string
  tag: string
  type: string
  role: string
  password: boolean
  search: boolean
  x: number
  y: number
  w: number
  h: number
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Height of the toolbar strip (back · forward · reload · address bar · home). */
const BAR = 46
const HOME = 'https://www.google.com'

/**
 * The toolbar is a tiny local page. It never gets Node or an IPC bridge: it asks for things by "navigating" to
 * isla-ui://<action>?u=…, which the main process intercepts (and cancels). The main process pushes state back in.
 */
const TOOLBAR_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; font-family: 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif; }
  html, body { height: 100%; background: #1c1c1e; color: #f5f5f7; overflow: hidden; user-select: none; }
  body { display: flex; align-items: center; gap: 4px; padding: 7px 10px; border-bottom: 1px solid rgba(255,255,255,.08); }
  button { width: 32px; height: 32px; flex: none; border: 0; border-radius: 8px; background: transparent; color: #e5e5ea; cursor: pointer;
    display: grid; place-items: center; }
  button:hover:not(:disabled) { background: rgba(255,255,255,.08); }
  button:disabled { color: #48484a; cursor: default; }
  svg { width: 18px; height: 18px; fill: currentColor; }
  form { flex: 1; display: flex; min-width: 0; }
  input { flex: 1; min-width: 0; height: 32px; padding: 0 14px; border-radius: 999px; border: 1px solid transparent; background: #2c2c2e;
    color: #f5f5f7; font-size: 13.5px; outline: none; }
  input:focus { border-color: #0a84ff; background: #1c1c1e; }
  .lock { position: absolute; }
  #load { position: fixed; left: 0; bottom: 0; height: 2px; width: 0; background: #0a84ff; transition: width .4s ease, opacity .3s; opacity: 0; }
  #load.on { width: 70%; opacity: 1; }
</style></head><body>
  <button id="back" title="Back (Alt+Left)" disabled><svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg></button>
  <button id="fwd" title="Forward (Alt+Right)" disabled><svg viewBox="0 0 24 24"><path d="M4 11h12.2l-5.6-5.6L12 4l8 8-8 8-1.4-1.4 5.6-5.6H4z"/></svg></button>
  <button id="reload" title="Reload (F5)"><svg viewBox="0 0 24 24"><path d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.76-4.24L13 11h7V4z"/></svg></button>
  <form id="f"><input id="url" spellcheck="false" placeholder="Search Google or type a web address" /></form>
  <button id="home" title="Home"><svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg></button>
  <div id="load"></div>
<script>
  const $ = id => document.getElementById(id)
  const ask = (action, u) => { location.href = 'isla-ui://' + action + (u !== undefined ? '?u=' + encodeURIComponent(u) : '') }
  $('back').onclick = () => ask('back')
  $('fwd').onclick = () => ask('forward')
  $('reload').onclick = () => ask('reload')
  $('home').onclick = () => ask('go', '${HOME}')
  $('f').onsubmit = e => { e.preventDefault(); const v = $('url').value.trim(); if (v) { ask('go', v); $('url').blur() } }
  $('url').onfocus = () => setTimeout(() => $('url').select(), 0)
  window.islaUpdate = s => {
    $('back').disabled = !s.back
    $('fwd').disabled = !s.fwd
    if (document.activeElement !== $('url')) $('url').value = s.url || ''
    $('load').className = s.loading ? 'on' : ''
  }
  window.islaFocus = () => { $('url').focus() }
</script></body></html>`

/** Address-bar text → a URL: a web address as typed, anything else becomes a Google search. */
function toUrl(input: string): string {
  const v = input.trim()
  if (/^https?:\/\//i.test(v)) return v
  if (!/\s/.test(v) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/i.test(v)) return `https://${v}`
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`
}

export class IslaBrowser {
  private win: BrowserWindow | null = null
  /** The web page itself (under the toolbar) — everything the AI reads and clicks is in here. */
  private page: WebContentsView | null = null
  /** webContents ids that may navigate freely (the app's own window may not). */
  readonly contentIds = new Set<number>()

  constructor(
    private onChange: () => void,
    private icon?: string
  ) {}

  get open(): boolean {
    return !!this.win && !this.win.isDestroyed() && !!this.page
  }

  private ensure(): WebContents {
    if (this.open) return this.page!.webContents
    const ses = session.fromPartition(PARTITION)
    // Look like plain Chrome — some sites (Google sign-in) refuse "Electron".
    ses.setUserAgent(app.userAgentFallback.replace(/\s(Electron|agentic-island|Agentic Island)\/\S+/gi, ''))
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    // Never drop files on the PC from an automated task.
    ses.on('will-download', e => e.preventDefault())

    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      show: false,
      title: 'Isla browser',
      icon: this.icon,
      autoHideMenuBar: true,
      backgroundColor: '#1c1c1e',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false }
    })
    const page = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        backgroundThrottling: false,
        spellcheck: false
      }
    })
    win.contentView.addChildView(page)
    const layout = () => {
      const [w, h] = win.getContentSize()
      page.setBounds({ x: 0, y: BAR, width: w, height: Math.max(0, h - BAR) })
    }
    layout()
    win.on('resize', layout)

    const wc = page.webContents
    const bar = win.webContents
    void bar.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(TOOLBAR_HTML)}`)

    // Toolbar → main: "navigations" to isla-ui://… are requests, never real navigations.
    bar.on('will-navigate', (e, url) => {
      e.preventDefault()
      if (!url.startsWith('isla-ui://')) return
      const u = new URL(url)
      const action = u.hostname
      if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
      else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
      else if (action === 'reload') wc.reload()
      else if (action === 'go') {
        const target = toUrl(u.searchParams.get('u') ?? '')
        if (/^https?:/i.test(target)) void wc.loadURL(target).catch(() => {})
        wc.focus()
      }
    })
    bar.setWindowOpenHandler(() => ({ action: 'deny' }))

    // Main → toolbar: address, back/forward and loading state.
    const sync = () => {
      if (bar.isDestroyed() || wc.isDestroyed()) return
      const state = { url: wc.getURL(), back: wc.navigationHistory.canGoBack(), fwd: wc.navigationHistory.canGoForward(), loading: wc.isLoading() }
      void bar.executeJavaScript(`window.islaUpdate && window.islaUpdate(${JSON.stringify(state)})`).catch(() => {})
      win.setTitle(wc.getTitle() ? `${wc.getTitle()} — Isla browser` : 'Isla browser')
    }
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated'] as const) {
      wc.on(ev as 'did-stop-loading', sync)
    }
    bar.on('did-finish-load', sync)

    // Usual browser keys in the page: Ctrl+L / Alt+D address bar, Alt+←/→, F5 / Ctrl+R.
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return
      const k = input.key.toLowerCase()
      if ((input.control && k === 'l') || (input.alt && k === 'd')) {
        e.preventDefault()
        bar.focus()
        void bar.executeJavaScript('window.islaFocus && window.islaFocus()').catch(() => {})
      } else if (input.alt && k === 'arrowleft' && wc.navigationHistory.canGoBack()) {
        e.preventDefault()
        wc.navigationHistory.goBack()
      } else if (input.alt && k === 'arrowright' && wc.navigationHistory.canGoForward()) {
        e.preventDefault()
        wc.navigationHistory.goForward()
      } else if (k === 'f5' || (input.control && k === 'r')) {
        e.preventDefault()
        wc.reload()
      }
    })

    this.contentIds.add(wc.id)
    const id = wc.id
    // Pop-ups open in the same view.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void wc.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })
    wc.on('will-navigate', (e, url) => {
      if (!/^https?:/i.test(url)) e.preventDefault()
    })
    win.on('closed', () => {
      this.contentIds.delete(id)
      if (!wc.isDestroyed()) wc.close()
      if (this.win === win) {
        this.win = null
        this.page = null
      }
      this.onChange()
    })
    this.win = win
    this.page = page
    this.onChange()
    return wc
  }

  /** Show the window (for watching, or signing in) or tuck it away again. */
  show(visible: boolean, focus = false): void {
    if (!visible) {
      if (this.open) this.win!.hide()
      return
    }
    const wc = this.ensure()
    if (wc.getURL() === '') void wc.loadURL(HOME).catch(() => {})
    if (focus) this.win!.show()
    else this.win!.showInactive()
  }

  async goto(url: string): Promise<void> {
    let u: URL
    try {
      u = new URL(/^[a-z]+:/i.test(url) ? url : `https://${url}`)
    } catch {
      throw new Error('That is not a valid web address.')
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) pages can be opened.')
    const wc = this.ensure()
    try {
      await wc.loadURL(u.toString())
    } catch {
      // Redirects/aborted sub-loads reject loadURL even though the page is usable.
    }
    await this.settle()
  }

  async back(): Promise<void> {
    const wc = this.ensure()
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    await this.settle()
  }

  url(): string {
    return this.open ? this.page!.webContents.getURL() : ''
  }

  title(): string {
    return this.open ? this.page!.webContents.getTitle() : ''
  }

  async read(): Promise<{ url: string; title: string; text: string; elements: string[] }> {
    return this.need().executeJavaScript(READ_PAGE, true)
  }

  async describe(ref: string): Promise<ElementInfo | null> {
    if (!/^\d{1,4}$/.test(ref)) throw new Error('Use an element number from browser_read.')
    return this.need().executeJavaScript(DESCRIBE(ref), true)
  }

  /** A click inside Isla's browser only — your own mouse is not touched. */
  async click(ref: string): Promise<void> {
    const wc = this.need()
    const el = await this.describe(ref)
    if (!el) throw new Error(`Element ${ref} is gone — call browser_read again.`)
    if (this.win!.isVisible() && el.w >= 1 && el.h >= 1) {
      // Visible: a real (trusted) click inside Isla's page view.
      const { x, y } = el
      wc.sendInputEvent({ type: 'mouseMove', x, y })
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    } else {
      // Hidden windows don't hit-test real input: replay the whole pointer/mouse sequence a click produces on the element
      // (Gmail and other web apps listen for mousedown/mouseup, not just click).
      await wc.executeJavaScript(
        `(() => {
          const el = document.querySelector('[data-isla-ref="${ref}"]')
          if (!el) return false
          const r = el.getBoundingClientRect()
          const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
          if (typeof el.focus === 'function') el.focus()
          for (const t of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, { ...o, pointerType: 'mouse', isPrimary: true }) : new MouseEvent(t, o))
          }
          return true
        })()`,
        true
      )
    }
    await this.settle()
  }

  async type(ref: string, text: string, submit: boolean): Promise<void> {
    if (!/^\d{1,4}$/.test(ref)) throw new Error('Use an element number from browser_read.')
    const wc = this.need()
    const ok = await wc.executeJavaScript(
      `(() => {
        const el = document.querySelector('[data-isla-ref="${ref}"]')
        if (!el) return false
        el.scrollIntoView({ block: 'center' })
        el.focus()
        if (typeof el.select === 'function') el.select()
        else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r) }
        return true
      })()`,
      true
    )
    if (!ok) throw new Error(`Element ${ref} is gone — call browser_read again.`)
    // insertText fires real input events, so React/Gmail-style editors pick it up.
    await wc.insertText(text)
    if (submit) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      wc.sendInputEvent({ type: 'char', keyCode: '\r' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      await this.settle()
    }
  }

  async scroll(direction: 'up' | 'down'): Promise<void> {
    await this.need().executeJavaScript(`window.scrollBy(0, ${direction === 'up' ? -1 : 1} * window.innerHeight * 0.85)`, true)
    await sleep(300)
  }

  async screenshot(): Promise<{ png: string; width: number; height: number }> {
    const img = await this.need().capturePage(undefined, { stayHidden: true })
    const small = img.getSize().width > 1280 ? img.resize({ width: 1280 }) : img
    const { width, height } = small.getSize()
    return { png: small.toPNG().toString('base64'), width, height }
  }

  close(): void {
    if (this.open) this.win!.destroy()
    this.win = null
    this.page = null
  }

  private need(): WebContents {
    if (!this.open || this.page!.webContents.getURL() === '') throw new Error('No page is open — call browser_open first.')
    return this.page!.webContents
  }

  /** Wait for the page to finish loading (and a beat for scripts to render). */
  private async settle(): Promise<void> {
    const wc = this.page?.webContents
    if (!wc) return
    const t0 = Date.now()
    await sleep(250)
    while (wc.isLoading() && Date.now() - t0 < 15_000) await sleep(200)
    await sleep(500)
  }
}

import { app, BrowserWindow, session } from 'electron'

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

export class IslaBrowser {
  private win: BrowserWindow | null = null
  /** webContents ids that may navigate freely (the app's own window may not). */
  readonly contentIds = new Set<number>()

  constructor(
    private onChange: () => void,
    private icon?: string
  ) {}

  get open(): boolean {
    return !!this.win && !this.win.isDestroyed()
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
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
    this.contentIds.add(win.webContents.id)
    const id = win.webContents.id
    // Pop-ups open in the same window.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void win.loadURL(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e, url) => {
      if (!/^https?:/i.test(url)) e.preventDefault()
    })
    win.on('closed', () => {
      this.contentIds.delete(id)
      if (this.win === win) this.win = null
      this.onChange()
    })
    this.win = win
    this.onChange()
    return win
  }

  /** Show the window (for watching, or signing in) or tuck it away again. */
  show(visible: boolean, focus = false): void {
    if (!visible) {
      if (this.open) this.win!.hide()
      return
    }
    const w = this.ensure()
    if (w.webContents.getURL() === '') void w.loadURL('https://www.google.com')
    if (focus) w.show()
    else w.showInactive()
  }

  async goto(url: string): Promise<void> {
    let u: URL
    try {
      u = new URL(/^[a-z]+:/i.test(url) ? url : `https://${url}`)
    } catch {
      throw new Error('That is not a valid web address.')
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) pages can be opened.')
    const w = this.ensure()
    try {
      await w.loadURL(u.toString())
    } catch {
      // Redirects/aborted sub-loads reject loadURL even though the page is usable.
    }
    await this.settle()
  }

  async back(): Promise<void> {
    const w = this.ensure()
    if (w.webContents.navigationHistory.canGoBack()) w.webContents.navigationHistory.goBack()
    await this.settle()
  }

  url(): string {
    return this.open ? this.win!.webContents.getURL() : ''
  }

  title(): string {
    return this.open ? this.win!.webContents.getTitle() : ''
  }

  async read(): Promise<{ url: string; title: string; text: string; elements: string[] }> {
    const w = this.need()
    return w.webContents.executeJavaScript(READ_PAGE, true)
  }

  async describe(ref: string): Promise<ElementInfo | null> {
    if (!/^\d{1,4}$/.test(ref)) throw new Error('Use an element number from browser_read.')
    return this.need().webContents.executeJavaScript(DESCRIBE(ref), true)
  }

  /** A real (trusted) click inside Isla's window only — your own mouse is not touched. */
  async click(ref: string): Promise<void> {
    const w = this.need()
    const el = await this.describe(ref)
    if (!el) throw new Error(`Element ${ref} is gone — call browser_read again.`)
    if (w.isVisible() && el.w >= 1 && el.h >= 1) {
      // Visible: a real (trusted) click inside Isla's window.
      const { x, y } = el
      w.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    } else {
      // Hidden windows don't hit-test real input: replay the whole pointer/mouse sequence a click produces on the element
      // (Gmail and other web apps listen for mousedown/mouseup, not just click).
      await w.webContents.executeJavaScript(
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
    const w = this.need()
    const ok = await w.webContents.executeJavaScript(
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
    await w.webContents.insertText(text)
    if (submit) {
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      w.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      await this.settle()
    }
  }

  async scroll(direction: 'up' | 'down'): Promise<void> {
    await this.need().webContents.executeJavaScript(`window.scrollBy(0, ${direction === 'up' ? -1 : 1} * window.innerHeight * 0.85)`, true)
    await sleep(300)
  }

  async screenshot(): Promise<{ png: string; width: number; height: number }> {
    const img = await this.need().webContents.capturePage(undefined, { stayHidden: true })
    const small = img.getSize().width > 1280 ? img.resize({ width: 1280 }) : img
    const { width, height } = small.getSize()
    return { png: small.toPNG().toString('base64'), width, height }
  }

  close(): void {
    if (this.open) this.win!.destroy()
    this.win = null
  }

  private need(): BrowserWindow {
    if (!this.open || this.win!.webContents.getURL() === '') throw new Error('No page is open — call browser_open first.')
    return this.win!
  }

  /** Wait for the page to finish loading (and a beat for scripts to render). */
  private async settle(): Promise<void> {
    const wc = this.win?.webContents
    if (!wc) return
    const t0 = Date.now()
    await sleep(250)
    while (wc.isLoading() && Date.now() - t0 < 15_000) await sleep(200)
    await sleep(500)
  }
}

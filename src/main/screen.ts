import { desktopCapturer, screen as eScreen } from 'electron'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActivityContext, AppPermission } from '@shared/types'
import type { WinRect } from './context'
import { winHelper } from './winhelper'

/**
 * Reads the window in front using Windows' built-in OCR (Windows.Media.Ocr) — fully on-device, zero tokens.
 * Only the display holding that window is captured (never every open window), then cropped to the window.
 * Screenshots are written to one private file that is overwritten each time and deleted on kill switch/quit.
 */

/** Never look at these — the capture is skipped entirely. */
const PRIVATE = /(1password|bitwarden|keepass|lastpass|dashlane|nordpass|password|passwort|credential|bank|banking|paypal|wallet|incognito|inprivate|private browsing|authenticator|recovery code|seed phrase)/i

/** Longest side of the capture; plenty for OCR and keeps the bitmap small. */
const MAX_SIDE = 1500

export class ScreenReader {
  private file: string

  constructor(
    private dir: string,
    /** Bounds of the window in front, in physical pixels (null = unknown → read the whole display). */
    private getRect: () => WinRect | null = () => null
  ) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'screen.png')
  }

  /** Capture the foreground window and return its text, or a skip reason. */
  async read(activity: ActivityContext, permissions?: AppPermission[]): Promise<{ text: string; skipped: string | null }> {
    if (PRIVATE.test(activity.title) || PRIVATE.test(activity.process)) return { text: '', skipped: 'Private window — not read' }
    // Check per-app permissions: if the user has explicitly blocked this app, skip it.
    if (permissions) {
      const proc = activity.process.toLowerCase()
      const perm = permissions.find(p => p.process === proc)
      if (perm && !perm.allowed) return { text: '', skipped: `Blocked by your app permissions — ${perm.name || activity.app} is not allowed` }
    }
    const phys = this.getRect()
    let win: Electron.Rectangle | null = null
    try {
      win = phys ? eScreen.screenToDipRect(null, phys) : null
    } catch {
      win = null
    }
    const display = win ? eScreen.getDisplayMatching(win) : eScreen.getPrimaryDisplay()
    const { width, height } = display.size
    const scale = Math.min(1, MAX_SIDE / Math.max(width * display.scaleFactor, height * display.scaleFactor)) * display.scaleFactor
    let sources: Electron.DesktopCapturerSource[] = []
    try {
      sources = await Promise.race([
        desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
          fetchWindowIcons: false
        }),
        new Promise<Electron.DesktopCapturerSource[]>((_, rej) => setTimeout(() => rej(new Error('Capture timed out')), 4000))
      ])
    } catch {
      return { text: '', skipped: 'Window could not be captured' }
    }
    const src = sources.find(s => s.display_id === String(display.id)) ?? sources[0]
    if (!src || src.thumbnail.isEmpty()) return { text: '', skipped: 'Window could not be captured' }
    let img = src.thumbnail
    // Crop to the window in front so other windows (and their text) are not read.
    if (win) {
      const sz = img.getSize()
      const k = sz.width / display.bounds.width
      const x = Math.max(0, Math.round((win.x - display.bounds.x) * k))
      const y = Math.max(0, Math.round((win.y - display.bounds.y) * k))
      const w = Math.min(sz.width - x, Math.round((win.x + win.width - display.bounds.x) * k) - x)
      const h = Math.min(sz.height - y, Math.round((win.y + win.height - display.bounds.y) * k) - y)
      if (w > 80 && h > 40) img = img.crop({ x, y, width: w, height: h })
    }
    writeFileSync(this.file, img.toPNG())
    const line = await winHelper.ocr(this.file)
    if (line.startsWith('ERR:')) throw new Error(line.slice(4))
    return { text: Buffer.from(line.slice(3), 'base64').toString('utf8'), skipped: null }
  }

  /** Delete the screenshot and unload the OCR engine. */
  wipe(): void {
    try {
      rmSync(this.file, { force: true })
    } catch {
      /* ignore */
    }
    winHelper.disable('ocr')
  }
}

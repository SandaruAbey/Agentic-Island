// TEMP: dev-only test driver. Removed before packaging.
import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

export function devShot(win: BrowserWindow): void {
  win.webContents.on('console-message', e => e.level === 'error' && console.log('[renderer]', e.message))
  win.webContents.once('did-finish-load', async () => {
    const dir = process.env.ISLAND_SHOT!
    const js = (code: string) => win.webContents.executeJavaScript(code)
    const snap = async (name: string, rect?: Electron.Rectangle) => writeFileSync(`${dir}/${name}.png`, (await win.webContents.capturePage(rect)).toPNG())
    // 1) A suggestion should peek by itself.
    let peeked = false
    for (let i = 0; i < 40 && !peeked; i++) {
      await wait(1000)
      peeked = await js(`!!document.querySelector('.island.peek .peek-actions')`)
    }
    console.log('peek shown:', peeked, await js(`document.querySelector('.peek-text')?.innerText || ''`))
    await snap('s1-peek', { x: 0, y: 0, width: 800, height: 100 })
    // 2) …then it folds back into the pill with a ✨ chip.
    for (let i = 0; i < 15; i++) {
      await wait(1000)
      if (await js(`!!document.querySelector('.pill-sugg')`)) break
    }
    await wait(800)
    console.log('chip:', await js(`document.querySelector('.pill-sugg')?.innerText || 'none'`))
    await snap('s2-chip', { x: 0, y: 0, width: 800, height: 70 })
    // 3) Translate via the composer.
    await js(`(() => { const el = document.querySelector('.compact-row'); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 })); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })) })()`)
    await wait(1200)
    await js(`(() => {
      const t = document.querySelector('.composer textarea')
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      set.call(t, 'translate to English: මම හෙට උදේ ඔෆිස් එකට එනවා, මීටින් එක දහයට තියන්න'); t.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await wait(200)
    await js(`document.querySelector('.composer .btn.primary').click()`)
    for (let i = 0; i < 60; i++) {
      await wait(1000)
      const st = await js(`window.island.getSnapshot().then(s => s.runs[0] && s.runs[0].status)`)
      if (st && st !== 'running') break
    }
    await wait(800)
    console.log('translate:', await js(`window.island.getSnapshot().then(s => JSON.stringify({ title: s.runs[0].title, status: s.runs[0].status, out: s.runs[0].output, tokens: s.runs[0].usage, cost: s.runs[0].costUsd }))`))
    await snap('s3-translate')
    app.exit(0)
  })
}

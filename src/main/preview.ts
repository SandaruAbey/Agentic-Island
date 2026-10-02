import { nativeImage, shell } from 'electron'
import { lookup } from 'node:dns/promises'
import { stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { basename, dirname } from 'node:path'
import type { FileInfo, LinkPreview } from '@shared/types'
import { checkUserPath, isRunnable } from './computer'

/**
 * Cards for files and links that appear in answers.
 * Files: only inside the user folder / workspaces (never secrets or app data); programs are revealed, never launched.
 * Links: fetched here — never by the island page — over http(s) only, to public addresses only (no localhost, LAN or
 * cloud-metadata hosts, re-checked on every redirect), with small size and time limits. Images come back as data URLs.
 */

// ---------------------------------------------------------------- files

export async function fileInfo(p: string, extraRoots: string[]): Promise<FileInfo | null> {
  let full: string
  try {
    full = checkUserPath(p, extraRoots)
  } catch {
    return null
  }
  try {
    const st = await stat(full)
    let thumb: string | null = null
    try {
      // Windows shell thumbnails: photos, PDFs, videos, Office documents, folders…
      const img = await nativeImage.createThumbnailFromPath(full, { width: 192, height: 192 })
      if (!img.isEmpty()) thumb = img.toDataURL()
    } catch {
      /* no thumbnail for this type */
    }
    return { path: full, name: basename(full), dir: dirname(full), isDir: st.isDirectory(), size: st.size, modified: st.mtimeMs, thumb }
  } catch {
    return null
  }
}

export async function openFile(p: string, reveal: boolean, extraRoots: string[]): Promise<{ ok: boolean; message: string }> {
  let full: string
  try {
    full = checkUserPath(p, extraRoots)
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
  if (reveal || isRunnable(full)) {
    shell.showItemInFolder(full)
    return { ok: true, message: reveal ? 'Shown in File Explorer.' : 'This is a program — shown in its folder instead of running it.' }
  }
  const err = await shell.openPath(full)
  return err ? { ok: false, message: err } : { ok: true, message: `Opened ${basename(full)}.` }
}

// ---------------------------------------------------------------- links

const MAX_HTML = 512 * 1024
const MAX_IMAGE = 2 * 1024 * 1024
const TIMEOUT_MS = 7000
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 IslaPreview'

const cache = new Map<string, Promise<LinkPreview | null>>()

/** Private, loopback, link-local, CGNAT, multicast and metadata ranges — never fetched. */
function privateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase()
    if (v === '::' || v === '::1' || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('ff')) return true
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    return mapped ? privateIp(mapped[1]) : false
  }
  const [a, b] = ip.split('.').map(Number)
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

async function publicUrl(raw: string): Promise<URL> {
  const u = new URL(raw)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme')
  if (u.username || u.password) throw new Error('credentials')
  if (u.port && !['80', '443', ''].includes(u.port)) throw new Error('port')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^(localhost|.*\.local|.*\.internal|.*\.lan|metadata\.google\.internal)$/i.test(host)) throw new Error('private host')
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true })
  if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new Error('private address')
  return u
}

/** GET with manual redirects (each hop re-checked) and a byte cap. */
async function get(url: string, maxBytes: number): Promise<{ url: string; type: string; body: Buffer } | null> {
  let current = url
  for (let hop = 0; hop < 4; hop++) {
    const u = await publicUrl(current)
    const res = await fetch(u, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': UA, accept: 'text/html,image/*;q=0.9,*/*;q=0.5' },
      credentials: 'omit'
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return null
      current = new URL(loc, u).toString()
      continue
    }
    if (!res.ok || !res.body) return null
    const len = Number(res.headers.get('content-length') || 0)
    if (len > maxBytes) return null
    const chunks: Buffer[] = []
    let size = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        void reader.cancel()
        // HTML: the head (with the og: tags) is enough. Images: too big, skip.
        if (!/html/i.test(res.headers.get('content-type') ?? '')) return null
        break
      }
      chunks.push(Buffer.from(value))
    }
    return { url: u.toString(), type: (res.headers.get('content-type') ?? '').split(';')[0].trim(), body: Buffer.concat(chunks) }
  }
  return null
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(0x10ffff, Number(n))))
    .replace(/\s+/g, ' ')
    .trim()

function meta(html: string, ...names: string[]): string {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*>`, 'i')
    const tag = html.match(re)?.[0]
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1]
    if (content) return decode(content)
  }
  return ''
}

async function imageData(url: string): Promise<string | null> {
  try {
    const r = await get(url, MAX_IMAGE)
    if (!r || !IMAGE_TYPES.test(r.type) || !r.body.length) return null
    return `data:${r.type.toLowerCase()};base64,${r.body.toString('base64')}`
  } catch {
    return null
  }
}

async function build(url: string): Promise<LinkPreview | null> {
  try {
    const r = await get(url, MAX_HTML)
    if (!r) return null
    const site = new URL(r.url).hostname.replace(/^www\./, '')
    if (IMAGE_TYPES.test(r.type)) {
      // A direct image link: fetch it whole for the preview.
      const image = r.body.length < MAX_IMAGE ? `data:${r.type.toLowerCase()};base64,${r.body.toString('base64')}` : await imageData(url)
      return { url, site, title: decodeURIComponent(new URL(r.url).pathname.split('/').pop() || site), description: '', image }
    }
    if (!/html/i.test(r.type)) return null
    const html = r.body.toString('utf8')
    const title = meta(html, 'og:title', 'twitter:title') || decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '') || site
    const description = meta(html, 'og:description', 'twitter:description', 'description').slice(0, 220)
    const img = meta(html, 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src')
    const image = img ? await imageData(new URL(img, r.url).toString()) : null
    return { url, site, title: title.slice(0, 140), description, image }
  } catch {
    return null
  }
}

export function linkPreview(url: string): Promise<LinkPreview | null> {
  const key = String(url ?? '').slice(0, 2000)
  if (!/^https?:\/\//i.test(key)) return Promise.resolve(null)
  let p = cache.get(key)
  if (!p) {
    p = build(key)
    cache.set(key, p)
    if (cache.size > 200) cache.delete(cache.keys().next().value!)
  }
  return p
}

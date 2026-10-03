import { useEffect, useState } from 'react'
import type { FileInfo, LinkPreview } from '@shared/types'
import { Icon, Shimmer } from './ui'

/** One lookup per path/url for the whole session (thumbnails and previews are small data URLs). */
const fileCache = new Map<string, Promise<FileInfo | null>>()
const linkCache = new Map<string, Promise<LinkPreview | null>>()

function cached<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = map.get(key)
  if (!p) {
    p = load().catch(() => null as T)
    map.set(key, p)
    if (map.size > 150) map.delete(map.keys().next().value!)
  }
  return p
}

function useLoad<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): T | undefined {
  const [v, setV] = useState<T | undefined>(undefined)
  useEffect(() => {
    let alive = true
    setV(undefined)
    void cached(map, key, load).then(x => alive && setV(x))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return v
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** A file or folder named in an answer: click to open, folder button to show it in File Explorer. */
export function FileCard({ path }: { path: string }) {
  const info = useLoad(fileCache, path, () => window.island.fileInfo(path))
  const [msg, setMsg] = useState<string | null>(null)
  // Outside your user folder, a secret, or gone: just show the path.
  if (info === null) return <code className="md-path">{path}</code>
  const name = info?.name ?? baseName(path)
  const ext = info && !info.isDir ? (name.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? '').toUpperCase() : ''
  const go = (reveal: boolean) =>
    void window.island.openFile(info?.path ?? path, reveal).then(r => {
      if (!r.ok || !reveal) setMsg(r.ok ? null : r.message)
    })
  return (
    <span
      className="file-card"
      role="button"
      tabIndex={0}
      title={`${info?.path ?? path}\nClick to open`}
      onClick={() => go(false)}
      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && go(false)}
    >
      {info?.thumb ? <img className="file-thumb" src={info.thumb} alt="" /> : <span className="file-ico"><Icon name={info?.isDir ? 'folder' : 'file'} size={18} /></span>}
      <span className="file-meta">
        <strong>{name}</strong>
        <em>
          {msg ??
            (info
              ? [info.isDir ? 'Folder' : ext || 'File', !info.isDir && fmtSize(info.size), new Date(info.modified).toLocaleDateString()].filter(Boolean).join(' · ')
              : <Shimmer>Loading…</Shimmer>)}
        </em>
      </span>
      <button
        className="icon-btn subtle file-reveal"
        title="Show in folder"
        onClick={e => {
          e.stopPropagation()
          go(true)
        }}
      >
        <Icon name="folder" size={13} />
      </button>
    </span>
  )
}

/** A web link or page referenced in an answer, with its title and picture. */
export function LinkCard({ url }: { url: string }) {
  const p = useLoad(linkCache, url, () => window.island.linkPreview(url))
  let site = url
  try {
    site = new URL(url).hostname.replace(/^www\./, '')
  } catch {
    /* keep raw */
  }
  return (
    <a className={`link-card ${p?.image ? 'has-img' : ''}`} href={url} title={url} onClick={e => (e.preventDefault(), void window.island.openUrl(url))}>
      {p?.image && <img src={p.image} alt="" />}
      <span className="link-meta">
        <strong>{p?.title || site}</strong>
        {p?.description && <span>{p.description}</span>}
        <em>
          <Icon name="search" size={10} /> {p?.site || site}
        </em>
      </span>
    </a>
  )
}

/** An image in an answer (markdown image or a direct image link), loaded through Isla — click to open it. */
export function ImagePreview({ url, alt }: { url: string; alt?: string }) {
  const p = useLoad(linkCache, url, () => window.island.linkPreview(url))
  if (p === undefined) return <span className="md-img loading">{alt || 'Loading image…'}</span>
  if (!p?.image) return <LinkCard url={url} />
  return (
    <a className="md-img" href={url} title={alt || url} onClick={e => (e.preventDefault(), void window.island.openUrl(url))}>
      <img src={p.image} alt={alt ?? ''} />
    </a>
  )
}

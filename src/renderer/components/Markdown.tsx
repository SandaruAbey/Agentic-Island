import { useMemo, type ReactNode } from 'react'
import { Icon } from './ui'
import { FileCard, ImagePreview, LinkCard } from './Cards'

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[]; start: number }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'hr' }
  | { kind: 'tools'; items: string[] }
  | { kind: 'warn'; text: string }

const UL = /^\s*[-*•]\s+(.*)$/
const OL = /^\s*(\d+)[.)]\s+(.*)$/

/** Isla's tool tags ([TOOL:COMPUTER …], [TOOL:REMINDER …]) are instructions for the app, not for the reader. */
const TOOL_TAG = /^\s*\[TOOL:[A-Z]+\b[^\]]*\]\s*$/

function parseBlocks(src: string): Block[] {
  const lines = src
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(l => !TOOL_TAG.test(l))
  const out: Block[] = []
  let i = 0
  const last = () => out[out.length - 1]
  while (i < lines.length) {
    const line = lines[i]
    const t = line.trim()
    if (t.startsWith('```')) {
      const body: string[] = []
      i++
      // An unclosed fence (still streaming) just runs to the end.
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++])
      i++
      out.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    i++
    if (!t) {
      out.push({ kind: 'p', lines: [] })
      continue
    }
    if (t.startsWith('▸ ')) {
      const b = last()
      if (b?.kind === 'tools') b.items.push(t.slice(2))
      else out.push({ kind: 'tools', items: [t.slice(2)] })
      continue
    }
    if (t.startsWith('⚠')) {
      out.push({ kind: 'warn', text: t.replace(/^⚠\s*/, '') })
      continue
    }
    const h = t.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      out.push({ kind: 'h', level: h[1].length, text: h[2].replace(/\s*#+$/, '') })
      continue
    }
    if (/^([-*_])\1{2,}$/.test(t.replace(/\s/g, ''))) {
      out.push({ kind: 'hr' })
      continue
    }
    const ul = line.match(UL)
    if (ul) {
      const b = last()
      if (b?.kind === 'ul') b.items.push(ul[1])
      else out.push({ kind: 'ul', items: [ul[1]] })
      continue
    }
    const ol = line.match(OL)
    if (ol) {
      const b = last()
      if (b?.kind === 'ol') b.items.push(ol[2])
      else out.push({ kind: 'ol', items: [ol[2]], start: Number(ol[1]) || 1 })
      continue
    }
    if (t.startsWith('>')) {
      const text = t.replace(/^>\s?/, '')
      const b = last()
      if (b?.kind === 'quote') b.lines.push(text)
      else out.push({ kind: 'quote', lines: [text] })
      continue
    }
    const b = last()
    // A wrapped continuation of a list item stays in that item.
    if ((b?.kind === 'ul' || b?.kind === 'ol') && /^\s{2,}\S/.test(line)) {
      b.items[b.items.length - 1] += ` ${t}`
      continue
    }
    if (b?.kind === 'p' && b.lines.length) b.lines.push(t)
    else out.push({ kind: 'p', lines: [t] })
  }
  return out.filter(b => b.kind !== 'p' || b.lines.length)
}

/**
 * A Windows path: to a file ("C:\Users\me\CV (1).pdf" — spaces allowed, ends at its extension),
 * or to a folder (no spaces).
 */
const WIN_PATH =
  /(?<![\w])[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\r\n]*?\.[A-Za-z0-9]{1,8}(?=$|[\s)\]"'*,;:!?]|\.(?:\s|$))|(?<![\w])[A-Za-z]:[\\/][^\s*?"<>|:`]*[^\s*?"<>|:`.,;)]/
  .source
const IS_PATH = new RegExp(`^(?:${WIN_PATH})$`)
const IMAGE_URL = /\.(png|jpe?g|gif|webp|avif|bmp)(\?\S*)?$/i

const INLINE = new RegExp(
  [
    /(`[^`\n]+`)/.source,
    /(\*\*[^*\n]+?\*\*|__[^_\n]+?__)/.source,
    /(!\[[^\]\n]*\]\(https?:\/\/[^)\s]+\))/.source,
    /(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/.source,
    `(${WIN_PATH})`,
    /(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*])/.source,
    /(\*[^*\s](?:[^*\n]*[^*\s])?\*|(?<![\w])_[^_\s](?:[^_\n]*[^_\s])?_(?![\w]))/.source
  ].join('|'),
  'g'
)

function openLink(url: string) {
  void window.island.openUrl(url)
}

/** `previews`: the answer is finished, so images may be fetched and shown. */
function inline(text: string, key = 'i', previews = false): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) nodes.push(text.slice(last, at))
    const k = `${key}-${n++}`
    const [all, code, bold, image, link, path, url, italic] = m
    if (code) {
      const c = code.slice(1, -1).trim()
      nodes.push(IS_PATH.test(c) ? <FileCard key={k} path={c} /> : <code key={k}>{code.slice(1, -1)}</code>)
    } else if (bold) nodes.push(<strong key={k}>{inline(bold.slice(2, -2), k, previews)}</strong>)
    else if (path) nodes.push(<FileCard key={k} path={path} />)
    else if (image) {
      const im = image.match(/^!\[([^\]]*)\]\((.+)\)$/)!
      nodes.push(
        previews ? (
          <ImagePreview key={k} url={im[2]} alt={im[1]} />
        ) : (
          <a key={k} className="md-link" href={im[2]} title={im[2]} onClick={e => (e.preventDefault(), openLink(im[2]))}>
            {im[1] || 'image'}
          </a>
        )
      )
    } else if (url && previews && IMAGE_URL.test(url)) nodes.push(<ImagePreview key={k} url={url} />)
    else if (link) {
      const lm = link.match(/^\[([^\]]+)\]\((.+)\)$/)!
      nodes.push(
        <a key={k} className="md-link" href={lm[2]} title={lm[2]} onClick={e => (e.preventDefault(), openLink(lm[2]))}>
          {inline(lm[1], k, previews)}
        </a>
      )
    } else if (url) {
      nodes.push(
        <a key={k} className="md-link" href={url} title={url} onClick={e => (e.preventDefault(), openLink(url))}>
          {url.replace(/^https?:\/\/(www\.)?/, '')}
        </a>
      )
    } else if (italic) nodes.push(<em key={k}>{inline(italic.slice(1, -1), k, previews)}</em>)
    else nodes.push(all)
    last = at + all.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const TOOL_LABEL: Record<string, { label: string; icon: string }> = {
  WebSearch: { label: 'Searched the web', icon: 'search' },
  WebFetch: { label: 'Read a web page', icon: 'search' },
  Read: { label: 'Read', icon: 'eye' },
  Grep: { label: 'Searched code', icon: 'search' },
  Glob: { label: 'Listed files', icon: 'folder' },
  Edit: { label: 'Edited', icon: 'commit' },
  Write: { label: 'Wrote', icon: 'commit' },
  Bash: { label: 'Ran', icon: 'play' },
  edited: { label: 'Edited files', icon: 'commit' }
}

function ToolChip({ raw }: { raw: string }) {
  const [name, ...rest] = raw.split(' ')
  const known = TOOL_LABEL[name]
  const detail = rest.join(' ').trim()
  return (
    <span className="md-tool" title={raw}>
      <Icon name={known?.icon ?? 'spark'} size={11} />
      {known?.label ?? name}
      {detail && <em>{detail}</em>}
    </span>
  )
}

/** Web pages referenced in the answer (not images) — shown as preview cards under it. */
function referencedLinks(blocks: Block[]): string[] {
  const out: string[] = []
  for (const b of blocks) {
    const texts = b.kind === 'p' || b.kind === 'quote' ? b.lines : b.kind === 'ul' || b.kind === 'ol' ? b.items : b.kind === 'h' ? [b.text] : []
    for (const t of texts) {
      for (const m of t.replace(/!\[[^\]\n]*\]\([^)]*\)/g, '').matchAll(/https?:\/\/[^\s<>()\]]*[^\s<>().,;:!?'"*\]]/g)) {
        if (!IMAGE_URL.test(m[0]) && !out.includes(m[0])) out.push(m[0])
      }
    }
  }
  return out.slice(0, 4)
}

/** `previews`: the answer is finished — show link and image previews (they are fetched, so not while streaming). */
export function Markdown({ text, previews = false }: { text: string; previews?: boolean }) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  const links = useMemo(() => (previews ? referencedLinks(blocks) : []), [blocks, previews])
  return (
    <>
      {blocks.map((b, i) => {
        const k = `b${i}`
        switch (b.kind) {
          case 'p':
            return (
              <p key={k}>
                {b.lines.map((l, j) => (
                  <span key={j}>
                    {j > 0 && <br />}
                    {inline(l, `${k}-${j}`, previews)}
                  </span>
                ))}
              </p>
            )
          case 'h': {
            const Tag = (`h${Math.min(4, b.level)}` as 'h1' | 'h2' | 'h3' | 'h4')
            return <Tag key={k}>{inline(b.text, k, previews)}</Tag>
          }
          case 'ul':
            return (
              <ul key={k}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `${k}-${j}`, previews)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={k} start={b.start}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `${k}-${j}`, previews)}</li>
                ))}
              </ol>
            )
          case 'code':
            return (
              <pre key={k}>
                <code>{b.text}</code>
              </pre>
            )
          case 'quote':
            return <blockquote key={k}>{inline(b.lines.join(' '), k, previews)}</blockquote>
          case 'hr':
            return <hr key={k} />
          case 'tools':
            return (
              <div key={k} className="md-tools">
                {b.items.map((it, j) => (
                  <ToolChip key={j} raw={it} />
                ))}
              </div>
            )
          case 'warn':
            return (
              <p key={k} className="md-warn">
                {b.text}
              </p>
            )
        }
      })}
      {links.length > 0 && (
        <div className="link-cards">
          {links.map(u => (
            <LinkCard key={u} url={u} />
          ))}
        </div>
      )}
    </>
  )
}

/** Readable plain text for copying/pasting into chat apps: no markdown symbols, no tool-call lines. */
export function toPlainText(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(l => !/^\s*(▸ |⚠|⏸)/.test(l) && !/^\s*```/.test(l) && !TOOL_TAG.test(l))
    .map(l =>
      l
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^(\s*)[-*•]\s+/, '$1• ')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
        .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
        .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1$2')
        .replace(/`([^`]+)`/g, '$1')
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

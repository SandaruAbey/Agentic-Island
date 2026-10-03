/**
 * report.md → report.html, so any plugin's report opens nicely in the browser (tables you can sort by clicking a header).
 * Small on purpose: headings, paragraphs, lists, quotes, tables, **bold**, *italic*, `code` and [links](https://…).
 * Everything is escaped first, and only http(s)/mailto/tel links become links.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(raw: string): string {
  let s = esc(raw)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|tel:)[^)\s]+)\)/g, (_, t: string, u: string) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
  return s
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim())

export function markdownToHtml(title: string, md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const n = h[1].length
      const id = h[2].toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')
      out.push(`<h${n} id="${esc(id)}">${inline(h[2])}</h${n}>`)
      i++
      continue
    }
    // Table: a header row followed by |---|---|
    if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const head = cells(line)
      const align = cells(lines[i + 1]).map(c => (c.endsWith(':') ? 'right' : 'left'))
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]))
      out.push(
        `<div class="tw"><table class="sortable"><thead><tr>${head.map((c, k) => `<th style="text-align:${align[k] ?? 'left'}">${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map(r => `<tr>${head.map((_, k) => `<td style="text-align:${align[k] ?? 'left'}">${inline(r[k] ?? '')}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>'
      )
      continue
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/).test(lines[i])) items.push(lines[i++].replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''))
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(x => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }
    if (line.startsWith('>')) {
      const q: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''))
      out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`)
      continue
    }
    if (/^---+\s*$/.test(line)) {
      out.push('<hr>')
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*[-*]\s|\s*\d+[.)]\s|>|\|)/.test(lines[i])) para.push(lines[i++])
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`)
    else i++
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--head:#f5f5f7;--accent:#0a66c2;--row:#fafafa}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ececf0;--muted:#9a9aa2;--line:#2c2c30;--head:#1b1b1e;--accent:#6cb4ff;--row:#161619}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:32px 20px 80px}h1{font-size:28px;margin:0 0 8px}h2{margin-top:40px;padding-top:12px;border-top:1px solid var(--line)}
h3{margin-top:28px}a{color:var(--accent)}code{background:var(--head);padding:1px 5px;border-radius:4px}
blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid #ff9f0a;background:var(--head)}
.tw{overflow-x:auto;margin:12px 0;border:1px solid var(--line);border-radius:8px}table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{background:var(--head);position:sticky;top:0;cursor:pointer;white-space:nowrap;user-select:none}
th:hover{color:var(--accent)}tbody tr:nth-child(even){background:var(--row)}li{margin:3px 0}
.foot{margin-top:48px;color:var(--muted);font-size:12px}@media print{th{position:static}}
</style></head><body><main>
<h1>${esc(title)}</h1>
${out.join('\n')}
<p class="foot">Made by Isla. Click a column header to sort.</p>
</main>
<script>
document.querySelectorAll('table.sortable th').forEach(function (th, col) {
  th.addEventListener('click', function () {
    var table = th.closest('table'), body = table.tBodies[0], rows = Array.prototype.slice.call(body.rows)
    var dir = th.dataset.dir === 'asc' ? 'desc' : 'asc'
    table.querySelectorAll('th').forEach(function (x) { delete x.dataset.dir })
    th.dataset.dir = dir
    var idx = Array.prototype.indexOf.call(th.parentNode.children, th)
    rows.sort(function (a, b) {
      var x = a.cells[idx].innerText.trim(), y = b.cells[idx].innerText.trim()
      var nx = parseFloat(x.replace(/[^\\d.-]/g, '')), ny = parseFloat(y.replace(/[^\\d.-]/g, ''))
      var r = !isNaN(nx) && !isNaN(ny) && /^[\\d.,\\s%+-]+/.test(x) ? nx - ny : x.localeCompare(y)
      return dir === 'asc' ? r : -r
    })
    rows.forEach(function (r) { body.appendChild(r) })
  })
})
</script>
</body></html>`
}

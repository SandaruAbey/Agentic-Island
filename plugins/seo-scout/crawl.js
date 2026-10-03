// @ts-check
/**
 * Fetches what the audit needs from one website: the home page and the most useful inner pages (contact, about,
 * services, FAQ, team, blog…), robots.txt, the XML sitemap, llms.txt, the http→https redirect, a made-up URL (does it
 * return a real 404?), and optionally Google PageSpeed Insights (real Lighthouse + Core Web Vitals, mobile).
 */

/** @typedef {import('../isla-plugin').PluginContext} Ctx */
/** @typedef {import('../isla-plugin').HttpResponse} Res */

const SKIP = /\.(pdf|jpe?g|png|gif|webp|avif|svg|zip|rar|docx?|xlsx?|pptx?|mp4|mp3|avi|mov|ico|css|js|xml|json|txt|exe|apk)$/i
/** Inner pages worth reading, in order. */
const PRIORITY = [
  /contact|reach-us|get-in-touch|location|find-us|visit/i,
  /about|who-we-are|our-story|company|history/i,
  /service|practice|treatment|product|solution|what-we-do|menu|rooms|accommodation|offer|pricing|price|package|course/i,
  /faq|questions|help/i,
  /team|staff|people|doctor|attorney|lawyer|expert|specialist|our-/i,
  /blog|news|article|insight|resource|guide/i,
  /review|testimonial|case-stud|portfolio|gallery|project/i
]

const decode = (/** @type {string} */ s) => s.replace(/&amp;/g, '&').replace(/&#0?38;/g, '&')

/** @param {Promise<Res>} p @returns {Promise<Res | null>} */
const safe = p => p.catch(() => null)

/** A small GET that never throws (robots.txt, llms.txt, sitemaps). @param {Ctx} ctx */
async function small(ctx, /** @type {string} */ url, maxBytes = 500_000) {
  const r = await safe(ctx.http.get(url, { timeoutMs: 15_000, maxBytes }))
  return r && r.status === 200 ? r : null
}

/** Same-site links on a page (no files, no #anchors, no ?queries). */
function internalLinks(/** @type {string} */ html, /** @type {string} */ base) {
  const b = new URL(base)
  const host = b.hostname.replace(/^www\./, '')
  /** @type {Map<string, string>} */
  const out = new Map()
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    /** @type {URL} */
    let u
    try {
      u = new URL(decode(m[1]), base)
    } catch {
      continue
    }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, '') !== host || SKIP.test(u.pathname)) continue
    if (b.hostname.endsWith('wixsite.com') || b.hostname === 'sites.google.com') {
      if (!u.pathname.startsWith(b.pathname.split('/').slice(0, b.hostname === 'sites.google.com' ? 3 : 2).join('/'))) continue
    }
    u.hash = ''
    u.search = ''
    const key = u.href.replace(/\/$/, '')
    if (!out.has(key)) out.set(key, u.href)
  }
  return [...out.values()]
}

function pickPages(/** @type {string[]} */ links, /** @type {string} */ home, /** @type {number} */ n) {
  const h = home.replace(/\/$/, '')
  const rest = links.filter(l => l.replace(/\/$/, '') !== h)
  /** @type {string[]} */
  const picked = []
  for (const re of PRIORITY) {
    const l = rest.find(x => re.test(new URL(x).pathname) && !picked.includes(x))
    if (l) picked.push(l)
  }
  // Then the top-level pages (shortest paths).
  for (const l of [...rest].sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)) if (!picked.includes(l)) picked.push(l)
  return picked.slice(0, n)
}

/** @param {Ctx} ctx */
async function sitemapInfo(ctx, /** @type {string} */ origin, /** @type {string | null} */ robotsTxt) {
  const listed = robotsTxt ? [...robotsTxt.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map(m => m[1]) : []
  for (const u of [...new Set([...listed, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`])].slice(0, 5)) {
    const r = await small(ctx, u, 8_000_000)
    if (!r || !/<(urlset|sitemapindex)\b/i.test(r.text)) continue
    let text = r.text
    const index = /<sitemapindex\b/i.test(text)
    let children = 0
    if (index) {
      const locs = [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => decode(m[1]))
      children = locs.length
      const page = locs.find(l => /page|post/i.test(l)) ?? locs[0]
      const c = page ? await small(ctx, page, 8_000_000) : null
      if (c) text = c.text
    }
    const lastmods = [...text.matchAll(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/gi)].map(m => Date.parse(m[1])).filter(Number.isFinite)
    return { found: true, url: u, inRobots: listed.length > 0, urls: (text.match(/<url>/gi) ?? []).length, index, children, newest: lastmods.length ? Math.max(...lastmods) : null }
  }
  return { found: false, url: null, inRobots: listed.length > 0, urls: 0, index: false, children: 0, newest: null }
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<{ error: string } | { error: null, home: Res, pages: Res[], failed: { url: string, status: number | string }[],
 *   robotsTxt: string | null, llms: string | null, llmsFull: boolean, http: { status: number, location: string } | null,
 *   notFoundStatus: number | null, ttfb: number, sitemap: Awaited<ReturnType<typeof sitemapInfo>> }>}
 */
async function crawl(ctx, /** @type {string} */ url, /** @type {number} */ maxPages) {
  /** @type {Res} */
  let home
  try {
    home = await ctx.http.get(url, { timeoutMs: 30_000, maxBytes: 5_000_000 })
  } catch (e) {
    return { error: `Not reachable (${String(/** @type {Error} */ (e).cause ?? /** @type {Error} */ (e).message).slice(0, 80)})` }
  }
  if (home.status >= 400) return { error: home.status === 403 || home.status === 429 || home.status === 503 ? `Blocks automated checks (HTTP ${home.status})` : `HTTP ${home.status}` }
  const final = new URL(home.url)
  const origin = final.origin
  const notText = (/** @type {Res | null} */ r) => !r || /^\s*</.test(r.text) || /text\/html/i.test(r.headers['content-type'] ?? '')

  const [httpRes, robots, llms, llmsFull, probe] = await Promise.all([
    final.protocol === 'https:' ? safe(ctx.http.get(`http://${final.host}${final.pathname}`, { redirect: 'manual', timeoutMs: 10_000, maxBytes: 2000 })) : Promise.resolve(null),
    small(ctx, `${origin}/robots.txt`),
    small(ctx, `${origin}/llms.txt`),
    small(ctx, `${origin}/llms-full.txt`, 100_000),
    safe(ctx.http.get(`${origin}/isla-seo-check-${Date.now().toString(36)}`, { timeoutMs: 12_000, maxBytes: 100_000 }))
  ])
  const robotsTxt = notText(robots) ? null : /** @type {Res} */ (robots).text
  const sitemap = await sitemapInfo(ctx, origin, robotsTxt)

  const targets = pickPages(internalLinks(home.text, home.url), home.url, Math.max(0, maxPages - 1))
  /** @type {Res[]} */
  const pages = [home]
  /** @type {{ url: string, status: number | string }[]} */
  const failed = []
  for (let i = 0; i < targets.length; i += 3) {
    const batch = await Promise.all(targets.slice(i, i + 3).map(u => ctx.http.get(u, { timeoutMs: 20_000, maxBytes: 3_000_000 }).catch(e => ({ url: u, error: String(e.message) }))))
    for (const r of batch) {
      if ('error' in r) failed.push({ url: r.url, status: 'no answer' })
      else if (r.status >= 400) failed.push({ url: r.url, status: r.status })
      else if (/html/i.test(r.headers['content-type'] ?? 'text/html')) pages.push(r)
    }
  }
  return {
    error: null,
    home,
    pages,
    failed,
    robotsTxt,
    llms: notText(llms) || (llms?.text.trim().length ?? 0) < 20 ? null : /** @type {Res} */ (llms).text,
    llmsFull: !notText(llmsFull),
    http: httpRes ? { status: httpRes.status, location: httpRes.headers.location ?? '' } : null,
    notFoundStatus: probe?.status ?? null,
    // Replaced by a quiet, warm measurement later (this first request also paid for DNS, TLS and redirects).
    ttfb: home.ttfb,
    sitemap
  }
}

// ---------------------------------------------------------------- PageSpeed Insights

/** Run at most `n` jobs at once. */
function limiter(/** @type {number} */ n) {
  let active = 0
  /** @type {(() => void)[]} */
  const queue = []
  const next = () => {
    if (active >= n || !queue.length) return
    active++
    /** @type {() => void} */ (queue.shift())()
  }
  return /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */ fn =>
    new Promise((res, rej) => {
      queue.push(() =>
        fn()
          .then(res, rej)
          .finally(() => {
            active--
            next()
          })
      )
      next()
    })
}

/**
 * Real Lighthouse (mobile) + Chrome UX field data from Google PageSpeed Insights.
 * @param {Ctx} ctx
 */
async function pagespeed(ctx, /** @type {string} */ url, /** @type {string} */ key) {
  const q = new URLSearchParams({ url, strategy: 'mobile' })
  for (const c of ['performance', 'seo', 'accessibility', 'best-practices']) q.append('category', c)
  if (key) q.set('key', key)
  const r = await ctx.http.get(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { timeoutMs: 170_000, maxBytes: 20_000_000, headers: { accept: 'application/json' } })
  const j = JSON.parse(r.text || '{}')
  if (!r.ok) {
    const e = /** @type {Error & { status?: number }} */ (new Error(j.error?.message ?? `HTTP ${r.status}`))
    e.status = r.status
    throw e
  }
  const lh = j.lighthouseResult ?? {}
  const cat = lh.categories ?? {}
  const a = lh.audits ?? {}
  const score = (/** @type {string} */ k) => (typeof cat[k]?.score === 'number' ? Math.round(cat[k].score * 100) : null)
  const failing = (/** @type {string} */ k) =>
    (cat[k]?.auditRefs ?? [])
      .filter((/** @type {any} */ ref) => ref.weight > 0 && a[ref.id] && typeof a[ref.id].score === 'number' && a[ref.id].score < 0.9)
      .map((/** @type {any} */ ref) => String(a[ref.id].title))
  const opportunities = Object.values(a)
    .filter((/** @type {any} */ x) => (x.details?.overallSavingsMs ?? 0) >= 150)
    .sort((/** @type {any} */ x, /** @type {any} */ y) => y.details.overallSavingsMs - x.details.overallSavingsMs)
    .slice(0, 5)
    .map((/** @type {any} */ x) => `${x.title} (~${(x.details.overallSavingsMs / 1000).toFixed(1)} s)`)
  const m = j.loadingExperience?.metrics
  const num = (/** @type {string} */ id) => (typeof a[id]?.numericValue === 'number' ? a[id].numericValue : null)
  return {
    performance: score('performance'),
    seo: score('seo'),
    accessibility: score('accessibility'),
    bestPractices: score('best-practices'),
    lcp: num('largest-contentful-paint'),
    cls: num('cumulative-layout-shift'),
    tbt: num('total-blocking-time'),
    fcp: num('first-contentful-paint'),
    si: num('speed-index'),
    server: num('server-response-time'),
    field:
      m && j.loadingExperience?.overall_category
        ? {
            lcp: m.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
            inp: m.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
            cls: typeof m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile === 'number' ? m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null,
            category: String(j.loadingExperience.overall_category)
          }
        : null,
    seoIssues: failing('seo'),
    a11yIssues: failing('accessibility').slice(0, 6),
    opportunities
  }
}

// ---------------------------------------------------------------- speed in Isla's browser (no key)

/**
 * Runs in the page after it loaded: Core Web Vitals and page weight from the browser's own performance data.
 * Cross-site files that hide their size count as 0 bytes, so weights are a minimum.
 */
const SPEED_SCRIPT = `new Promise(done => {
  const out = { lcp: null, cls: 0 }
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) out.lcp = e.startTime }).observe({ type: 'largest-contentful-paint', buffered: true }) } catch (e) {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) out.cls += e.value }).observe({ type: 'layout-shift', buffered: true }) } catch (e) {}
  setTimeout(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]
    const res = performance.getEntriesByType('resource')
    const size = r => r.transferSize || r.encodedBodySize || 0
    const sum = f => res.filter(f).reduce((s, r) => s + size(r), 0)
    const host = location.hostname.replace(/^www\\./, '')
    done({
      ...out,
      fcp: fcp ? fcp.startTime : null,
      ttfb: nav ? nav.responseStart : null,
      load: nav && nav.loadEventEnd ? nav.loadEventEnd : null,
      requests: res.length + 1,
      bytes: sum(() => true) + (nav ? size(nav) : 0),
      js: sum(r => r.initiatorType === 'script' || /\\.m?js(\\?|$)/.test(r.name)),
      images: sum(r => r.initiatorType === 'img' || /\\.(png|jpe?g|gif|webp|avif|svg)(\\?|$)/i.test(r.name)),
      thirdParty: new Set(res.map(r => { try { return new URL(r.name).hostname } catch (e) { return '' } }).filter(h => h && !h.endsWith(host))).size
    })
  }, 3000)
})`

/**
 * Load the site fresh (empty cache) in a phone-sized window of Isla's private browser and read its real
 * Core Web Vitals: LCP, CLS, FCP, server response, load time, page weight. Measured on this PC's connection.
 * @param {Ctx} ctx
 */
async function browserSpeed(ctx, /** @type {string} */ url) {
  const t0 = Date.now()
  const page = await ctx.browser.open(url, { width: 412, height: 915, fresh: true, timeoutMs: 60_000 })
  /** @type {{ lcp: number | null, cls: number, fcp: number | null, ttfb: number | null, load: number | null, requests: number, bytes: number, js: number, images: number, thirdParty: number }} */
  const m = await ctx.browser.eval(SPEED_SCRIPT, 90_000)
  return { ...m, load: m.load ?? Date.now() - t0, status: page.status }
}

module.exports = { crawl, pagespeed, browserSpeed, limiter, internalLinks, pickPages }

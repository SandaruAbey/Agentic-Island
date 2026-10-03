// @ts-check
/**
 * The audit. Pure functions over what crawl.js fetched — no network here.
 *  - detectTech: how the site is built (platform, category, stack).
 *  - readPage:   everything one HTML page tells us.
 *  - audit:      75+ checks in six areas, each with what was actually found and how to fix it, and 0–100 scores:
 *                SEO (technical + on-page + local), Speed (real Lighthouse, when available), AEO, GEO.
 */

/** @typedef {import('../isla-plugin').HttpResponse} Res */

// ---------------------------------------------------------------- how it's built

/** @typedef {{ html: string, lower: string, headers: Record<string, string>, cookies: string }} Page */
const gen = (/** @type {Page} */ p, /** @type {string} */ word) => new RegExp(`<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*(${word})`, 'i').test(p.html)
const hdr = (/** @type {Page} */ p, /** @type {string} */ name, /** @type {RegExp} */ re = /./) => re.test(p.headers[name] ?? '')

/** First match wins, so the more specific platform comes first (WooCommerce before WordPress, Next.js before React). */
/** @type {{ name: string, category: string, test: (p: Page) => boolean }[]} */
const SIGNS = [
  { name: 'Shopify', category: 'E-commerce platform', test: p => /cdn\.shopify\.com|shopify\.theme|\.myshopify\.com/.test(p.lower) || 'x-shopid' in p.headers || 'x-shopify-stage' in p.headers },
  { name: 'BigCommerce', category: 'E-commerce platform', test: p => /cdn\d*\.bigcommerce\.com/.test(p.lower) },
  { name: 'Magento', category: 'E-commerce platform', test: p => /mage\/cookies|static\/version\d+\/frontend\/|magento_/.test(p.lower) },
  { name: 'PrestaShop', category: 'E-commerce platform', test: p => gen(p, 'prestashop') || /prestashop/.test(p.cookies) },
  { name: 'OpenCart', category: 'E-commerce platform', test: p => /index\.php\?route=(common|product)\//.test(p.lower) || /ocsessid/.test(p.cookies) },
  { name: 'WooCommerce (WordPress)', category: 'E-commerce platform', test: p => /\/wp-content\/plugins\/woocommerce\/|woocommerce-no-js|wc-block-/.test(p.lower) },
  { name: 'Wix', category: 'Website builder', test: p => /static\.wixstatic\.com|_wixcssimports|wix-bolt|wixsite\.com/.test(p.lower) || 'x-wix-request-id' in p.headers || gen(p, 'wix') },
  { name: 'Squarespace', category: 'Website builder', test: p => /static1\.squarespace\.com|squarespace-cdn\.com|<!-- this is squarespace/.test(p.lower) },
  { name: 'Webflow', category: 'Website builder', test: p => /data-wf-page|data-wf-site|website-files\.com/.test(p.lower) || gen(p, 'webflow') },
  { name: 'GoDaddy Website Builder', category: 'Website builder', test: p => /img1\.wsimg\.com/.test(p.lower) || gen(p, 'go ?daddy|starfield') },
  { name: 'Duda', category: 'Website builder', test: p => /irp\.cdn-website\.com|lirp\.cdn-website\.com|multiscreensite/.test(p.lower) },
  { name: 'Weebly / Square Online', category: 'Website builder', test: p => /weebly\.com|editmysite\.com|square\.site/.test(p.lower) },
  { name: 'Google Sites', category: 'Website builder', test: p => /sites\.google\.com|gstatic\.com\/atari/.test(p.lower) },
  { name: 'Framer', category: 'Website builder', test: p => /framerusercontent\.com|data-framer-/.test(p.lower) || gen(p, 'framer') },
  { name: 'WordPress', category: 'CMS', test: p => /\/wp-content\/|\/wp-includes\//.test(p.lower) || gen(p, 'wordpress') || hdr(p, 'link', /wp-json/) },
  { name: 'Statamic (Laravel)', category: 'CMS', test: p => hdr(p, 'x-powered-by', /statamic/i) || gen(p, 'statamic') },
  { name: 'HubSpot CMS', category: 'CMS', test: p => gen(p, 'hubspot') || 'x-hs-hub-id' in p.headers },
  { name: 'Joomla', category: 'CMS', test: p => gen(p, 'joomla') || /\/media\/jui\/|\/components\/com_/.test(p.lower) },
  { name: 'Drupal', category: 'CMS', test: p => gen(p, 'drupal') || 'x-drupal-cache' in p.headers || hdr(p, 'x-generator', /drupal/i) || /drupal-settings-json|\/sites\/default\/files\//.test(p.lower) },
  { name: 'Ghost', category: 'CMS', test: p => gen(p, 'ghost') },
  { name: 'Next.js', category: 'JavaScript framework', test: p => /\/_next\/static|__next_data__|id="__next"/.test(p.lower) || hdr(p, 'x-powered-by', /next\.js/i) || 'x-nextjs-cache' in p.headers },
  { name: 'Nuxt', category: 'JavaScript framework', test: p => /\/_nuxt\/|window\.__nuxt__|id="__nuxt"/.test(p.lower) },
  { name: 'Gatsby', category: 'JavaScript framework', test: p => /id="___gatsby"/.test(p.lower) || gen(p, 'gatsby') },
  { name: 'Astro', category: 'JavaScript framework', test: p => /astro-island/.test(p.lower) || gen(p, 'astro') },
  { name: 'SvelteKit', category: 'JavaScript framework', test: p => /data-sveltekit|__sveltekit/.test(p.lower) },
  // Laravel encrypts its cookies: the values start with base64 '{"iv":' (eyJpdiI6).
  { name: 'Laravel', category: 'Custom code', test: p => /laravel_session|=eyjpdii6/.test(p.cookies) || hdr(p, 'vary', /x-inertia/i) || 'laravel-cloud-cache' in p.headers || /\/livewire\/livewire|wire:(id|snapshot)=/.test(p.lower) },
  { name: 'CodeIgniter', category: 'Custom code', test: p => /ci_session/.test(p.cookies) },
  { name: 'Ruby on Rails', category: 'Custom code', test: p => /name="csrf-param" content="authenticity_token"/.test(p.lower) },
  { name: 'Django', category: 'Custom code', test: p => /csrftoken=/.test(p.cookies) || /csrfmiddlewaretoken/.test(p.lower) },
  { name: 'ASP.NET', category: 'Custom code', test: p => 'x-aspnet-version' in p.headers || hdr(p, 'x-powered-by', /asp\.net/i) || /__viewstate/.test(p.lower) || /asp\.net_sessionid/.test(p.cookies) },
  { name: 'Angular', category: 'JavaScript framework', test: p => /ng-version=/.test(p.lower) },
  { name: 'React', category: 'JavaScript framework', test: p => /data-reactroot|<div id="root"><\/div>/.test(p.lower) },
  { name: 'Vue', category: 'JavaScript framework', test: p => /data-v-[0-9a-f]{6,}|<div id="app"><\/div>/.test(p.lower) },
  { name: 'Custom code (PHP)', category: 'Custom code', test: p => hdr(p, 'x-powered-by', /php/i) || /phpsessid=/.test(p.cookies) || /\.php["'?]/.test(p.lower) }
]

const HOSTS = /** @type {[string, (p: Page) => boolean][]} */ ([
  ['Cloudflare', p => 'cf-ray' in p.headers],
  ['Vercel', p => 'x-vercel-id' in p.headers],
  ['Netlify', p => 'x-nf-request-id' in p.headers],
  ['AWS CloudFront', p => 'x-amz-cf-id' in p.headers],
  ['WP Engine', p => hdr(p, 'x-powered-by', /wp engine/i)],
  ['Kinsta', p => 'x-kinsta-cache' in p.headers],
  ['LiteSpeed', p => hdr(p, 'server', /litespeed/i)],
  ['nginx', p => hdr(p, 'server', /nginx/i)],
  ['Apache', p => hdr(p, 'server', /apache/i)],
  ['IIS', p => hdr(p, 'server', /iis/i)]
])

/** Popular add-ons that say something about how the site is run. */
const ADDONS = /** @type {[string, RegExp][]} */ ([
  ['Elementor', /elementor/],
  ['Divi', /\/themes\/divi|et_pb_/],
  ['Yoast SEO', /yoast/],
  ['Rank Math', /rank-math|rankmath/],
  ['All in One SEO', /aioseo/],
  ['Google Tag Manager', /googletagmanager\.com\/gtm/],
  ['Google Analytics', /google-analytics\.com|gtag\(/],
  ['Meta Pixel', /connect\.facebook\.net\/[^"']+fbevents/],
  ['Tailwind', /tailwind/],
  ['Bootstrap', /bootstrap(\.min)?\.(css|js)/],
  ['jQuery', /jquery(\.min)?\.js/]
])

/** @param {Res} res */
function detectTech(res) {
  const page = { html: res.text, lower: res.text.toLowerCase(), headers: res.headers, cookies: res.cookies.join('; ').toLowerCase() }
  const hits = SIGNS.filter(s => s.test(page))
  const stack = [...hits.map(h => h.name), ...HOSTS.filter(([, t]) => t(page)).map(([n]) => n)]
  const addons = ADDONS.filter(([, re]) => re.test(page.lower)).map(([n]) => n)
  const top = hits[0]
  return { platform: top?.name ?? 'Custom code', category: top?.category ?? 'Custom code', stack, addons }
}

// ---------------------------------------------------------------- reading a page

/** @param {string} tag */
function attrs(tag) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  return out
}

const decode = (/** @type {string} */ s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')

const textOf = (/** @type {string} */ html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const wordCount = (/** @type {string} */ t) => (t ? t.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length : 0)

// All JSON-LD objects that have a type, through graphs and nesting.
function jsonLd(/** @type {string} */ html) {
  /** @type {Record<string, any>[]} */
  const nodes = []
  let blocks = 0
  let broken = 0
  /** @param {unknown} v */
  const walk = v => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (!v || typeof v !== 'object') return
    const o = /** @type {Record<string, any>} */ (v)
    if (o['@type']) nodes.push(o)
    Object.values(o).forEach(walk)
  }
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    blocks++
    try {
      walk(JSON.parse(m[1].trim()))
    } catch {
      broken++
    }
  }
  return { nodes, blocks, broken }
}
const typesOf = (/** @type {Record<string, any>} */ n) => (Array.isArray(n['@type']) ? n['@type'] : [n['@type']]).map(String)

/** Everything one HTML page tells us. @param {Res} res */
function readPage(res) {
  const html = res.text
  const head = html.match(/<head\b[\s\S]*?<\/head>/i)?.[0] ?? ''
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(m => attrs(m[0]))
  const meta = (/** @type {string} */ k) => metas.find(a => (a.name ?? a.property ?? '').toLowerCase() === k)?.content?.trim() ?? ''
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => attrs(m[0]))
  const body = html.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
  const text = textOf(body)
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map(m => ({ level: Number(m[1]), text: textOf(m[2]) }))
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => attrs(m[0]))
  const anchors = [...html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)["']/gi)].map(m => decode(m[1]))
  const host = new URL(res.url).hostname.replace(/^www\./, '')
  let internal = 0
  let external = 0
  let authority = 0
  for (const a of anchors) {
    try {
      const u = new URL(a, res.url)
      if (!/^https?:$/.test(u.protocol)) continue
      if (u.hostname.replace(/^www\./, '') === host) internal++
      else {
        external++
        if (/\.(gov|edu|ac|mil)(\.[a-z]{2})?$|wikipedia\.org$|who\.int$|\.int$/.test(u.hostname)) authority++
      }
    } catch {
      /* bad href */
    }
  }
  const headScripts = [...head.matchAll(/<script\b[^>]*>/gi)].map(m => attrs(m[0]))
  // Answer-first: a question heading followed by a short, direct paragraph.
  let answers = 0
  for (const m of html.matchAll(/<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>\s*(?:<(?:div|span|section)\b[^>]*>\s*)*<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const w = wordCount(textOf(m[3]))
    if (textOf(m[2]).endsWith('?') && w >= 15 && w <= 90) answers++
  }
  const ld = jsonLd(html)
  return {
    url: res.url,
    status: res.status,
    bytes: html.length,
    ttfb: res.ttfb,
    title: textOf(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''),
    description: meta('description'),
    robots: `${meta('robots')} ${res.headers['x-robots-tag'] ?? ''}`.toLowerCase(),
    canonical: links.find(l => (l.rel ?? '').toLowerCase() === 'canonical')?.href ?? '',
    lang: html.match(/<html[^>]*\slang\s*=\s*["']?([a-z-]+)/i)?.[1] ?? '',
    viewport: meta('viewport'),
    og: { title: meta('og:title'), image: meta('og:image'), description: meta('og:description') },
    twitter: meta('twitter:card'),
    favicon: links.some(l => /icon/i.test(l.rel ?? '')),
    hreflang: links.filter(l => l.hreflang).length,
    author: meta('author') || (links.some(l => (l.rel ?? '') === 'author') ? 'rel=author' : ''),
    headings,
    h1: headings.filter(h => h.level === 1).map(h => h.text),
    questions: headings.filter(h => h.level > 1 && h.text.endsWith('?')).map(h => h.text),
    answers,
    words: wordCount(text),
    text,
    imgs: imgs.length,
    imgsAlt: imgs.filter(a => (a.alt ?? '').trim()).length,
    imgsLazy: imgs.filter(a => a.loading === 'lazy' || 'data-src' in a || 'data-lazy-src' in a).length,
    modernImages: /\.(webp|avif)\b|type=["']image\/(webp|avif)/i.test(html),
    internal,
    external,
    authority,
    scripts: (html.match(/<script\b[^>]*\bsrc=/gi) ?? []).length,
    blocking: headScripts.filter(a => a.src && !('async' in a) && !('defer' in a) && a.type !== 'module').length,
    stylesheets: links.filter(l => (l.rel ?? '').toLowerCase() === 'stylesheet').length,
    mixed: res.url.startsWith('https:') ? (html.match(/<(?:img|script|iframe|source|link)\b[^>]+(?:src|href)\s*=\s*["']http:\/\//gi) ?? []).length : 0,
    lists: (html.match(/<(ul|ol)\b/gi) ?? []).length,
    tables: (html.match(/<table\b/gi) ?? []).length,
    facts: (text.match(/\b\d[\d,.]*\s?(%|percent|years?|yrs|clients|customers|patients|cases|projects|reviews|students|rooms|branches|awards|members)\b/gi) ?? []).length,
    jsonLd: ld,
    ldTypes: [...new Set(ld.nodes.flatMap(typesOf))]
  }
}

// ---------------------------------------------------------------- robots.txt

/** True when robots.txt shuts `bot` out of the whole site (its own group, or * if it has none). */
function robotsBlocks(/** @type {string} */ txt, /** @type {string} */ bot) {
  /** @type {{ agents: string[], rules: { allow: boolean, path: string }[] }[]} */
  const groups = []
  /** @type {typeof groups[number] | null} */
  let cur = null
  let lastAgent = false
  for (const line of txt.split(/\r?\n/)) {
    const m = line.replace(/#.*/, '').match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    if (key === 'user-agent') {
      if (!cur || !lastAgent) groups.push((cur = { agents: [], rules: [] }))
      cur.agents.push(m[2].toLowerCase())
      lastAgent = true
    } else {
      if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: m[2] })
      lastAgent = false
    }
  }
  const b = bot.toLowerCase()
  const g = groups.find(x => x.agents.includes(b)) ?? groups.find(x => x.agents.includes('*'))
  if (!g) return false
  return g.rules.some(r => !r.allow && r.path === '/') && !g.rules.some(r => r.allow && r.path === '/')
}

/** Crawlers that fetch pages to answer people right now (ChatGPT search, Claude, Perplexity…). */
const AI_SEARCH_BOTS = ['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User']
/** Crawlers that collect training data — blocking them is a choice, but it also keeps you out of future models. */
const AI_TRAINING_BOTS = ['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'meta-externalagent']
const SEARCH_BOTS = ['Googlebot', 'Bingbot']

// ---------------------------------------------------------------- the audit

/** Types that are not "the business" itself. */
const NOT_ENTITY = new Set(
  'WebSite WebPage BreadcrumbList ListItem ImageObject SiteNavigationElement SearchAction EntryPoint ReadAction Question Answer FAQPage CollectionPage ItemList ContactPage AboutPage Person PostalAddress GeoCoordinates OpeningHoursSpecification ContactPoint Offer AggregateRating Review Rating Article BlogPosting NewsArticle VideoObject WPHeader WPFooter WPSideBar PropertyValue Place Country City State AdministrativeArea Thing HowTo HowToStep Service Product Brand CreativeWork MediaObject Event SpeakableSpecification Language DefinedRegion MonetaryAmount PriceSpecification'.split(
    ' '
  )
)

/**
 * @typedef {'Technical SEO' | 'On-page SEO' | 'Local SEO' | 'Speed' | 'AEO' | 'GEO'} Area
 * @typedef {{ id: string, area: Area, group: 'seo' | 'speed' | 'aeo' | 'geo', ok: boolean | null, weight: number, label: string, found: string, fix: string }} Check
 */

const pct = (/** @type {number} */ a, /** @type {number} */ b) => (b ? Math.round((100 * a) / b) : 0)
const sec = (/** @type {number | null} */ ms) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`)
const ago = (/** @type {number} */ t) => {
  const d = Math.round((Date.now() - t) / 86_400_000)
  return d < 1 ? 'today' : d < 60 ? `${d} days ago` : `${Math.round(d / 30)} months ago`
}

/**
 * @param {Exclude<Awaited<ReturnType<typeof import('./crawl').crawl>>, { error: string }>} c
 * @param {{ city: string, listingPhone: string, rating: number | null, reviews: number | null, psi: Awaited<ReturnType<typeof import('./crawl').pagespeed>> | null, speed?: Awaited<ReturnType<typeof import('./crawl').browserSpeed>> | null, contacts: ReturnType<typeof import('./contacts').extractContacts> }} extra
 */
function audit(c, extra) {
  const pages = c.pages.map(readPage)
  const home = pages[0]
  const all = (/** @type {(p: ReturnType<typeof readPage>) => boolean} */ f) => pages.filter(f).length
  const ld = pages.flatMap(p => p.jsonLd.nodes)
  const ldTypes = new Set(pages.flatMap(p => p.ldTypes))
  const business = ld.filter(n => typesOf(n).some(t => !NOT_ENTITY.has(t)) || n.address || n.telephone)
  const biz = business[0] ?? null
  const bizFields = biz
    ? {
        name: !!biz.name,
        address: !!biz.address,
        telephone: !!biz.telephone,
        url: !!biz.url,
        hours: !!(biz.openingHours || biz.openingHoursSpecification),
        geo: !!biz.geo,
        image: !!(biz.image || biz.logo),
        sameAs: Array.isArray(biz.sameAs) ? biz.sameAs.length > 0 : !!biz.sameAs
      }
    : null
  const sameAs = ld.flatMap(n => (Array.isArray(n.sameAs) ? n.sameAs : n.sameAs ? [n.sameAs] : []))
  const city = extra.city.toLowerCase()
  const robots = c.robotsTxt ?? ''
  const blockedSearch = c.robotsTxt ? SEARCH_BOTS.filter(b => robotsBlocks(robots, b)) : []
  const blockedAiSearch = c.robotsTxt ? AI_SEARCH_BOTS.filter(b => robotsBlocks(robots, b)) : []
  const blockedAiTraining = c.robotsTxt ? AI_TRAINING_BOTS.filter(b => robotsBlocks(robots, b)) : []
  const titles = pages.map(p => p.title).filter(Boolean)
  const dupTitles = titles.length - new Set(titles).size
  const descs = pages.map(p => p.description).filter(Boolean)
  const dupDescs = descs.length - new Set(descs).size
  const thin = pages.filter(p => p.words < 250)
  const imgs = pages.reduce((s, p) => s + p.imgs, 0)
  const alts = pages.reduce((s, p) => s + p.imgsAlt, 0)
  const questions = [...new Set(pages.flatMap(p => p.questions))]
  const answers = pages.reduce((s, p) => s + p.answers, 0)
  const contentPages = pages.slice(1)
  const avgWords = Math.round(pages.reduce((s, p) => s + p.words, 0) / pages.length)
  const years = [...home.text.matchAll(/\b(20[1-3]\d)\b/g)].map(m => Number(m[1])).filter(y => y <= new Date().getFullYear())
  const modified = ld.map(n => Date.parse(n.dateModified ?? n.datePublished ?? '')).filter(Number.isFinite)
  const newest = Math.max(c.sitemap.newest ?? 0, ...modified, 0)
  const httpOk = c.http ? [301, 308].includes(c.http.status) && c.http.location.startsWith('https://') : null
  const canonicalHost = (() => {
    try {
      return home.canonical ? new URL(home.canonical, home.url).hostname.replace(/^www\./, '') === new URL(home.url).hostname.replace(/^www\./, '') : false
    } catch {
      return false
    }
  })()
  const hasPhone = extra.contacts.phones.length > 0
  const listingDigits = extra.listingPhone.replace(/\D/g, '').slice(-9)
  const psi = extra.psi
  const hasAbout = pages.some(p => /about|team|who-we-are|our-story|people|staff/i.test(new URL(p.url).pathname)) || /href=["'][^"']*(about|team|our-story|who-we-are)[^"']*["']/i.test(c.home.text)

  /** @type {Check[]} */
  const checks = []
  /** @param {Area} area @param {Check['group']} group @param {string} id @param {number} weight @param {boolean | null} ok @param {string} label @param {string} found @param {string} fix */
  const add = (area, group, id, weight, ok, label, found, fix) => checks.push({ id, area, group, ok, weight, label, found, fix })
  const T = /** @type {Area} */ ('Technical SEO')
  const O = /** @type {Area} */ ('On-page SEO')
  const L = /** @type {Area} */ ('Local SEO')

  // ---- Technical SEO
  add(T, 'seo', 'https', 3, home.url.startsWith('https://'), 'Served over HTTPS', home.url.startsWith('https://') ? 'Yes' : `Final URL is ${home.url}`, 'Install an SSL certificate and serve every page over HTTPS.')
  add(T, 'seo', 'http-redirect', 2, httpOk, 'http:// redirects to https:// (301)', c.http ? `http:// answers ${c.http.status}${c.http.location ? ` → ${c.http.location}` : ''}` : 'n/a', 'Redirect every http:// URL to https:// with a permanent 301.')
  add(T, 'seo', 'hsts', 1, home.url.startsWith('https://') ? 'strict-transport-security' in c.home.headers : null, 'HSTS header', c.home.headers['strict-transport-security'] ?? 'Missing', 'Add a Strict-Transport-Security header.')
  add(T, 'seo', 'indexable', 3, home.status === 200 && !/noindex/.test(home.robots), 'Home page can be indexed', /noindex/.test(home.robots) ? `noindex found (${home.robots.trim()})` : `HTTP ${home.status}`, 'Remove noindex from the home page.')
  add(T, 'seo', 'search-bots', 3, c.robotsTxt === null ? true : !blockedSearch.length, 'Google & Bing allowed in robots.txt', blockedSearch.length ? `Blocked: ${blockedSearch.join(', ')}` : 'Allowed', 'Let Googlebot and Bingbot crawl the site in robots.txt.')
  add(T, 'seo', 'robots', 1, c.robotsTxt !== null, 'robots.txt', c.robotsTxt === null ? 'Not found' : `${c.robotsTxt.split('\n').length} lines`, 'Publish a robots.txt that points to the sitemap.')
  add(T, 'seo', 'sitemap', 2, c.sitemap.found, 'XML sitemap', c.sitemap.found ? `${c.sitemap.urls} URLs${c.sitemap.index ? ` (index of ${c.sitemap.children})` : ''}${c.sitemap.newest ? `, last updated ${ago(c.sitemap.newest)}` : ''}` : 'Not found', 'Publish sitemap.xml and submit it in Google Search Console.')
  add(T, 'seo', 'sitemap-robots', 1, c.robotsTxt === null ? false : c.sitemap.inRobots, 'Sitemap listed in robots.txt', c.sitemap.inRobots ? 'Yes' : 'No', 'Add a "Sitemap: https://…/sitemap.xml" line to robots.txt.')
  add(T, 'seo', 'canonical', 2, canonicalHost, 'Canonical link on the home page', home.canonical || 'Missing', 'Add <link rel="canonical"> pointing to the page’s own https URL.')
  add(T, 'seo', '404', 1, c.notFoundStatus === null ? null : c.notFoundStatus === 404 || c.notFoundStatus === 410, 'Missing pages return 404', c.notFoundStatus === null ? 'n/a' : `A made-up URL answered ${c.notFoundStatus}`, 'Return a real 404 status for pages that don’t exist (no "soft 404").')
  add(T, 'seo', 'broken', 2, !c.failed.length, 'No broken internal pages', c.failed.length ? c.failed.map(f => `${new URL(f.url).pathname} (${f.status})`).slice(0, 4).join(', ') : `${pages.length} pages OK`, 'Fix or redirect the broken links.')
  add(T, 'seo', 'compression', 1, /gzip|br|zstd|deflate/.test(c.home.headers['content-encoding'] ?? ''), 'Compressed (gzip / brotli)', c.home.headers['content-encoding'] || 'None', 'Turn on gzip or brotli compression on the server.')
  const server = psi?.server ?? c.ttfb
  add(T, 'seo', 'ttfb', 2, server <= 800, 'Server response time', `${Math.round(server)} ms${psi?.server != null ? ' (Lighthouse)' : ' (from this PC)'}`, 'Speed up the server (caching, better hosting, CDN) to answer within 0.8 s.')
  add(T, 'seo', 'html-size', 1, home.bytes <= 300_000, 'Home page HTML size', `${Math.round(home.bytes / 1024)} KB`, 'Trim inline code; keep the HTML under 300 KB.')
  add(T, 'seo', 'blocking', 1, home.blocking <= 2, 'Few render-blocking scripts', `${home.blocking} in <head>`, 'Load scripts with defer/async.')
  add(T, 'seo', 'mixed', 1, home.url.startsWith('https://') ? !pages.some(p => p.mixed) : null, 'No mixed content', `${pages.reduce((s, p) => s + p.mixed, 0)} http:// resources`, 'Load every image/script over https://.')

  // ---- On-page SEO
  add(O, 'seo', 'title', 3, home.title.length >= 30 && home.title.length <= 65, 'Home title 30–65 characters', home.title ? `“${home.title}” (${home.title.length})` : 'Missing', 'Write a 30–65 character title: service + city + brand.')
  add(O, 'seo', 'titles-unique', 1, dupTitles === 0 && titles.length === pages.length, 'Every page has its own title', `${titles.length}/${pages.length} have titles, ${dupTitles} duplicates`, 'Give every page a unique title.')
  add(O, 'seo', 'description', 2, home.description.length >= 70 && home.description.length <= 160, 'Home meta description 70–160', home.description ? `${home.description.length} characters` : 'Missing', 'Write a 70–160 character description that sells the click.')
  add(O, 'seo', 'descriptions', 1, pct(descs.length, pages.length) >= 80 && dupDescs === 0, 'Descriptions on all pages', `${descs.length}/${pages.length} pages, ${dupDescs} duplicates`, 'Add a unique meta description to each page.')
  add(O, 'seo', 'h1', 2, home.h1.length === 1, 'One H1 on the home page', home.h1.length ? `${home.h1.length}: “${home.h1[0].slice(0, 60)}”` : 'None', 'Use exactly one H1 that says what you do and where.')
  add(O, 'seo', 'h1-all', 1, all(p => p.h1.length >= 1) === pages.length, 'Every page has an H1', `${all(p => p.h1.length >= 1)}/${pages.length}`, 'Add an H1 to every page.')
  add(O, 'seo', 'h2', 1, home.headings.some(h => h.level === 2), 'Sub-headings (H2) on the home page', `${home.headings.filter(h => h.level === 2).length} H2`, 'Structure the page with H2 sub-headings.')
  add(O, 'seo', 'content', 2, home.words >= 300, 'Enough text on the home page', `${home.words} words`, 'Write at least 300 words of useful, specific text.')
  add(O, 'seo', 'thin', 1, pct(thin.length, pages.length) <= 30, 'Few thin pages', `${thin.length}/${pages.length} pages under 250 words`, 'Expand thin pages or merge them.')
  add(O, 'seo', 'alt', 2, imgs === 0 || pct(alts, imgs) >= 90, 'Image alt text', `${alts}/${imgs} images (${pct(alts, imgs)}%)`, 'Describe every meaningful image in its alt text.')
  add(O, 'seo', 'modern-images', 1, imgs < 3 ? null : pages.some(p => p.modernImages), 'Modern image formats (WebP / AVIF)', pages.some(p => p.modernImages) ? 'Used' : 'Only JPG/PNG', 'Serve images as WebP or AVIF.')
  add(O, 'seo', 'lazy', 1, home.imgs <= 5 ? null : home.imgsLazy >= Math.min(3, home.imgs - 2), 'Lazy-loaded images', `${home.imgsLazy}/${home.imgs} on the home page`, 'Add loading="lazy" to images below the fold.')
  add(O, 'seo', 'internal-links', 1, home.internal >= 10, 'Internal links from the home page', `${home.internal}`, 'Link to your key pages from the home page.')
  add(O, 'seo', 'viewport', 3, !!home.viewport, 'Mobile viewport', home.viewport || 'Missing', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.')
  add(O, 'seo', 'lang', 1, !!home.lang, 'Page language set', home.lang || 'Missing', 'Set <html lang="…">.')
  add(O, 'seo', 'og', 1, !!(home.og.title && home.og.image), 'Open Graph tags (title + image)', home.og.title ? (home.og.image ? 'Yes' : 'No og:image') : 'Missing', 'Add og:title, og:description and og:image for link previews.')
  add(O, 'seo', 'twitter', 1, !!home.twitter, 'Twitter / X card', home.twitter || 'Missing', 'Add <meta name="twitter:card" content="summary_large_image">.')
  add(O, 'seo', 'favicon', 1, home.favicon, 'Favicon', home.favicon ? 'Yes' : 'Missing', 'Add a favicon (it shows next to your result in Google).')

  // ---- Local SEO
  const where = `${home.title} ${home.description} ${home.h1.join(' ')}`.toLowerCase()
  add(L, 'seo', 'city', 2, city ? where.includes(city) : null, 'City in title / H1 / description', city && where.includes(city) ? 'Yes' : `“${extra.city}” not found there`, `Mention ${extra.city || 'your city'} in the home title, H1 or description.`)
  add(L, 'seo', 'phone', 2, hasPhone, 'Phone number on the site', hasPhone ? extra.contacts.phones.slice(0, 2).join(', ') : 'None found', 'Show your phone number on every page (header or footer).')
  add(L, 'seo', 'click-to-call', 1, /href\s*=\s*["']tel:/i.test(c.home.text), 'Click-to-call link', /href\s*=\s*["']tel:/i.test(c.home.text) ? 'Yes' : 'No tel: link on the home page', 'Make the phone number a tel: link.')
  add(L, 'seo', 'nap', 2, listingDigits.length >= 7 ? extra.contacts.phones.some(p => p.replace(/\D/g, '').endsWith(listingDigits)) : null, 'Same phone as the map listing (NAP)', listingDigits.length >= 7 ? `Listing: ${extra.listingPhone}; site: ${extra.contacts.phones.join(', ') || 'none'}` : 'No map listing to compare', 'Use exactly the same name, address and phone as your Google Business Profile.')
  add(L, 'seo', 'address', 1, !!(extra.contacts.address || /<address\b/i.test(c.home.text) || (city && pages.some(p => /contact/i.test(p.url) && p.text.toLowerCase().includes(city)))), 'Address on the site', extra.contacts.address || 'Not found in schema or <address>', 'Show your full address (and add it to the schema).')
  add(L, 'seo', 'map', 1, extra.contacts.mapEmbed, 'Map on the site', extra.contacts.mapEmbed ? 'Yes' : 'No embedded map', 'Embed a Google Map on the contact page.')
  add(L, 'seo', 'contact', 1, !!extra.contacts.contactPage || extra.contacts.contactForm, 'Contact page / form', extra.contacts.contactPage ? 'Contact page found' : extra.contacts.contactForm ? 'Form found' : 'None found', 'Add a clear contact page with a form.')
  add(L, 'seo', 'reviews', 2, extra.rating === null ? null : extra.rating >= 4.2 && (extra.reviews ?? 0) >= 20, 'Google rating ≥ 4.2 with 20+ reviews', extra.rating === null ? 'n/a' : `${extra.rating} (${extra.reviews ?? 0} reviews)`, 'Ask happy customers for Google reviews and reply to every review.')

  // ---- Speed: Google Lighthouse when there is a key, otherwise measured in Isla's browser
  const S = /** @type {Area} */ ('Speed')
  const ps = psi
  const bs = extra.speed
  if (ps) {
    add(S, 'speed', 'lh-perf', 3, ps.performance == null ? null : ps.performance >= 90, 'Lighthouse performance (mobile) ≥ 90', ps.performance == null ? 'n/a' : `${ps.performance}/100`, ps.opportunities?.length ? `Biggest wins: ${ps.opportunities.join('; ')}` : 'Optimise images, scripts and caching.')
    add(S, 'speed', 'lcp', 3, ps.lcp == null ? null : ps.lcp <= 2500, 'Largest Contentful Paint ≤ 2.5 s', sec(ps.lcp), 'Make the main image/text appear faster (compress hero image, preload it, cut render-blocking code).')
    add(S, 'speed', 'cls', 2, ps.cls == null ? null : ps.cls <= 0.1, 'Layout shift (CLS) ≤ 0.1', ps.cls == null ? 'n/a' : ps.cls.toFixed(3), 'Give images and embeds fixed sizes so the page doesn’t jump.')
    add(S, 'speed', 'tbt', 2, ps.tbt == null ? null : ps.tbt <= 200, 'Total Blocking Time ≤ 200 ms', ps.tbt == null ? 'n/a' : `${Math.round(ps.tbt)} ms`, 'Remove or delay heavy JavaScript (chat widgets, sliders, trackers).')
    add(S, 'speed', 'fcp', 1, ps.fcp == null ? null : ps.fcp <= 1800, 'First Contentful Paint ≤ 1.8 s', sec(ps.fcp), 'Cut render-blocking CSS/JS and speed up the server.')
    add(S, 'speed', 'field', 2, ps.field ? ps.field.category === 'FAST' : null, 'Real users: Core Web Vitals pass', ps.field ? `${ps.field.category} — LCP ${sec(ps.field.lcp)}, INP ${ps.field.inp ?? '—'} ms, CLS ${ps.field.cls ?? '—'}` : 'Not enough Chrome user data', 'Fix LCP/INP/CLS for real visitors (see Google Search Console).')
    add(S, 'speed', 'lh-seo', 2, ps.seo == null ? null : ps.seo >= 90, 'Lighthouse SEO ≥ 90', ps.seo == null ? 'n/a' : `${ps.seo}/100${ps.seoIssues.length ? ` — ${ps.seoIssues.join('; ')}` : ''}`, 'Fix the Lighthouse SEO issues listed.')
    add(S, 'speed', 'lh-a11y', 1, ps.accessibility == null ? null : ps.accessibility >= 90, 'Lighthouse accessibility ≥ 90', ps.accessibility == null ? 'n/a' : `${ps.accessibility}/100${ps.a11yIssues.length ? ` — ${ps.a11yIssues.slice(0, 3).join('; ')}` : ''}`, 'Fix contrast, labels and alt text.')
    add(S, 'speed', 'lh-bp', 1, ps.bestPractices == null ? null : ps.bestPractices >= 90, 'Lighthouse best practices ≥ 90', ps.bestPractices == null ? 'n/a' : `${ps.bestPractices}/100`, 'Fix console errors, outdated libraries and insecure requests.')
  } else if (bs) {
    // Real Chromium on a phone-sized screen with an empty cache, on this PC's connection (not throttled like Lighthouse).
    const mb = (/** @type {number} */ b) => `${(b / 1_048_576).toFixed(1)} MB`
    add(S, 'speed', 'lcp', 3, bs.lcp == null ? null : bs.lcp <= 2500, 'Largest Contentful Paint ≤ 2.5 s', `${sec(bs.lcp)} (Isla’s browser, phone size)`, 'Make the main image/text appear faster (compress hero image, preload it, cut render-blocking code).')
    add(S, 'speed', 'cls', 2, bs.cls <= 0.1, 'Layout shift (CLS) ≤ 0.1', bs.cls.toFixed(3), 'Give images and embeds fixed sizes so the page doesn’t jump.')
    add(S, 'speed', 'fcp', 2, bs.fcp == null ? null : bs.fcp <= 1800, 'First Contentful Paint ≤ 1.8 s', sec(bs.fcp), 'Cut render-blocking CSS/JS and speed up the server.')
    add(S, 'speed', 'load', 1, bs.load <= 5000, 'Fully loaded ≤ 5 s', sec(bs.load), 'Defer heavy scripts, sliders and third-party widgets.')
    add(S, 'speed', 'weight', 2, bs.bytes <= 3 * 1_048_576, 'Page weight ≤ 3 MB', `${mb(bs.bytes)}+ (images ${mb(bs.images)}, scripts ${mb(bs.js)})`, 'Compress and resize images, drop unused scripts.')
    add(S, 'speed', 'requests', 1, bs.requests <= 100, 'Requests ≤ 100', `${bs.requests} requests, ${bs.thirdParty} other domains`, 'Combine files and cut third-party widgets.')
    add(S, 'speed', 'js-weight', 1, bs.js <= 1_048_576, 'JavaScript ≤ 1 MB', `${mb(bs.js)}+`, 'Remove unused JavaScript and plugins.')
  }

  // ---- AEO (answer engines: Google featured snippets / AI Overviews, voice assistants)
  const A = /** @type {Area} */ ('AEO')
  const filled = bizFields ? Object.values(bizFields).filter(Boolean).length : 0
  add(A, 'aeo', 'jsonld', 2, ld.length > 0, 'Structured data (JSON-LD)', ld.length ? `${[...ldTypes].slice(0, 8).join(', ')}` : 'None', 'Add schema.org JSON-LD.')
  add(A, 'aeo', 'jsonld-valid', 1, pages.some(p => p.jsonLd.blocks) ? !pages.some(p => p.jsonLd.broken) : null, 'JSON-LD is valid JSON', `${pages.reduce((s, p) => s + p.jsonLd.broken, 0)} broken blocks`, 'Fix the broken JSON-LD (test it in Google’s Rich Results Test).')
  add(A, 'aeo', 'business', 3, !!biz, 'Business schema (LocalBusiness / Organization…)', biz ? typesOf(biz).join(', ') : 'None', 'Add LocalBusiness (or the specific type: Dentist, Hotel, LegalService…) schema.')
  add(A, 'aeo', 'business-complete', 2, bizFields ? filled >= 6 : false, 'Business schema is complete', bizFields ? `${filled}/8 — missing: ${Object.entries(bizFields).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'nothing'}` : 'No business schema', 'Fill name, address, telephone, url, openingHours, geo, image/logo and sameAs.')
  add(A, 'aeo', 'faq-schema', 2, ldTypes.has('FAQPage'), 'FAQPage schema', ldTypes.has('FAQPage') ? 'Yes' : 'No', 'Add an FAQ section marked up with FAQPage schema.')
  add(A, 'aeo', 'questions', 2, questions.length >= 3, 'Real questions as headings', questions.length ? `${questions.length}: “${questions[0].slice(0, 60)}”…` : 'None', 'Answer the questions customers really ask, as H2/H3 headings.')
  add(A, 'aeo', 'answer-first', 2, answers >= 2, 'Short direct answers under questions', `${answers} answer paragraphs (15–90 words)`, 'Start each answer with a 40–60 word direct answer, then the detail.')
  add(A, 'aeo', 'lists', 1, contentPages.length ? contentPages.some(p => p.lists >= 2 || p.tables > 0) : home.lists >= 2, 'Lists or tables in content', `${pages.reduce((s, p) => s + p.lists, 0)} lists, ${pages.reduce((s, p) => s + p.tables, 0)} tables`, 'Use bullet lists, steps and tables — answer engines lift them directly.')
  add(A, 'aeo', 'services', 1, [...ldTypes].some(t => /^(Service|Product|Offer|OfferCatalog|MenuItem|Menu|Course|HotelRoom|MedicalProcedure)$/.test(t)), 'Service / product schema', [...ldTypes].filter(t => /^(Service|Product|Offer|OfferCatalog|MenuItem|Menu|Course|HotelRoom|MedicalProcedure)$/.test(t)).join(', ') || 'None', 'Describe your services/products with Service or Product schema.')
  add(A, 'aeo', 'rating-schema', 1, ldTypes.has('AggregateRating') || ldTypes.has('Review'), 'Review / rating schema', ldTypes.has('AggregateRating') ? 'AggregateRating' : ldTypes.has('Review') ? 'Review' : 'None', 'Mark up genuine reviews with Review/AggregateRating schema.')
  add(A, 'aeo', 'breadcrumbs', 1, ldTypes.has('BreadcrumbList'), 'Breadcrumb schema', ldTypes.has('BreadcrumbList') ? 'Yes' : 'No', 'Add BreadcrumbList schema.')
  add(A, 'aeo', 'website-schema', 1, ldTypes.has('WebSite'), 'WebSite schema', ldTypes.has('WebSite') ? 'Yes' : 'No', 'Add WebSite schema with the site name.')

  // ---- GEO (generative engines: ChatGPT, Claude, Perplexity, Gemini, Google AI Mode)
  const G = /** @type {Area} */ ('GEO')
  add(G, 'geo', 'ai-search-bots', 3, !blockedAiSearch.length, 'AI search crawlers allowed', blockedAiSearch.length ? `Blocked: ${blockedAiSearch.join(', ')}` : c.robotsTxt === null ? 'No robots.txt (allowed)' : 'Allowed', 'Allow OAI-SearchBot, ChatGPT-User, Claude-SearchBot and PerplexityBot in robots.txt.')
  add(G, 'geo', 'ai-training-bots', 1, !blockedAiTraining.length, 'AI training crawlers allowed', blockedAiTraining.length ? `Blocked: ${blockedAiTraining.join(', ')}` : 'Allowed', 'Decide on purpose: blocking GPTBot/ClaudeBot/Google-Extended keeps you out of future AI models.')
  add(G, 'geo', 'no-noai', 1, !/noai|noimageai/.test(home.robots), 'No "noai" meta tag', /noai/.test(home.robots) ? home.robots.trim() : 'None', 'Remove noai/noimageai if you want to be cited by AI.')
  add(G, 'geo', 'server-rendered', 3, home.words >= 150, 'Content readable without JavaScript', `${home.words} words in the raw HTML`, 'Render the main content on the server — most AI crawlers do not run JavaScript.')
  add(G, 'geo', 'llms', 2, !!c.llms, 'llms.txt', c.llms ? `${c.llms.split('\n').length} lines${c.llmsFull ? ' + llms-full.txt' : ''}` : 'Not found', 'Publish /llms.txt: who you are, what you offer, key pages in Markdown.')
  add(G, 'geo', 'depth', 2, avgWords >= 500, 'In-depth content', `${avgWords} words per page on average`, 'Write detailed pages (500+ words) that fully answer one topic each.')
  add(G, 'geo', 'facts', 1, pages.reduce((s, p) => s + p.facts, 0) >= 3, 'Quotable facts and numbers', `${pages.reduce((s, p) => s + p.facts, 0)} found (years, %, clients…)`, 'Add concrete numbers: years in business, clients served, prices, results.')
  add(G, 'geo', 'citations', 1, pages.some(p => p.authority > 0), 'Cites authoritative sources', `${pages.reduce((s, p) => s + p.authority, 0)} links to .gov/.edu/Wikipedia…`, 'Back up claims with links to official or academic sources.')
  add(G, 'geo', 'same-as', 2, sameAs.length >= 2, 'Entity links (schema sameAs)', sameAs.length ? `${sameAs.length}: ${sameAs.slice(0, 3).join(', ')}` : 'None', 'List your Google Business, Facebook, LinkedIn, Wikipedia/Wikidata… in sameAs.')
  add(G, 'geo', 'socials', 1, Object.keys(extra.contacts.socials).length >= 2, 'Linked social profiles', Object.keys(extra.contacts.socials).join(', ') || 'None', 'Link your active social profiles from the site.')
  add(G, 'geo', 'about', 2, hasAbout, 'About / team page (E-E-A-T)', hasAbout ? 'Found' : 'None', 'Show who is behind the business: people, credentials, experience.')
  add(G, 'geo', 'authors', 1, ldTypes.has('Person') || pages.some(p => !!p.author), 'Named people / authors', ldTypes.has('Person') ? 'Person schema' : pages.find(p => p.author)?.author ?? 'None', 'Name real experts and add Person schema for them.')
  add(G, 'geo', 'fresh', 1, newest ? Date.now() - newest < 365 * 86_400_000 : years.some(y => y >= new Date().getFullYear() - 1), 'Recently updated', newest ? `Last change ${ago(newest)}` : years.length ? `Latest year on the page: ${Math.max(...years)}` : 'No dates found', 'Update key pages regularly and show dates (dateModified).')

  const score = (/** @type {Check['group']} */ g) => {
    const list = checks.filter(x => x.group === g && x.ok !== null)
    const total = list.reduce((s, x) => s + x.weight, 0)
    return total ? Math.round((100 * list.filter(x => x.ok).reduce((s, x) => s + x.weight, 0)) / total) : null
  }
  const seo = /** @type {number} */ (score('seo'))
  const aeo = /** @type {number} */ (score('aeo'))
  const geo = /** @type {number} */ (score('geo'))
  const speed = score('speed')
  const parts = [seo, aeo, geo, ...(speed === null ? [] : [speed])]
  const fixes = checks.filter(x => x.ok === false).sort((a, b) => b.weight - a.weight)

  return {
    checks,
    fixes,
    seo,
    aeo,
    geo,
    speed,
    overall: Math.round(parts.reduce((s, x) => s + x, 0) / parts.length),
    pagesCrawled: pages.length,
    homeWords: home.words,
    title: home.title,
    blockedAiSearch,
    blockedAiTraining,
    schemaTypes: [...ldTypes],
    business: biz
  }
}

/** Phone, email, address and sameAs from the business schema, for the contact list. @param {Res[]} pages */
function schemaFacts(pages) {
  const nodes = pages.flatMap(p => jsonLd(p.text).nodes)
  /** @param {unknown} v @returns {string[]} */
  const list = v => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : [])
  const addr = nodes.map(n => n.address).find(Boolean)
  const address =
    typeof addr === 'string' ? addr : addr && typeof addr === 'object' ? [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode].filter(Boolean).join(', ') : ''
  return {
    telephone: nodes.flatMap(n => list(n.telephone)),
    email: nodes.flatMap(n => list(n.email)),
    sameAs: nodes.flatMap(n => list(n.sameAs)),
    address
  }
}

module.exports = { detectTech, readPage, audit, robotsBlocks, schemaFacts, AI_SEARCH_BOTS, AI_TRAINING_BOTS }

// @ts-check
/**
 * Finding businesses — rule-based first, AI only if you turn it on:
 *  - Google Maps in Isla's private browser window (no key) — or the official Places API (New) when you add a key.
 *    Both give phone, address, rating and reviews.
 *  - Brave Search API (optional key): plain web search.
 *  - AI web research (optional) and your own list.
 * Everything is merged per website (or per name + city when there is no website).
 */

/** @typedef {import('../isla-plugin').PluginContext} Ctx */
/**
 * @typedef {{ name: string, city: string, website: string | null, phone: string, email: string, address: string,
 *   rating: number | null, reviews: number | null, mapsUrl: string, category: string, socials: string[], sources: string[] }} Business
 */

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms))

/** Social networks, maps, directories and marketplaces — never a business's own website. */
const NOT_A_SITE =
  /(^|\.)(facebook|fb|instagram|linkedin|twitter|x|youtube|youtu|tiktok|pinterest|threads|google|goo|g|bing|yelp|tripadvisor|booking|agoda|expedia|airbnb|hotels|trivago|justia|avvo|findlaw|yellowpages|yellow|superpages|bbb|mapquest|foursquare|wikipedia|wikidata|indeed|glassdoor|reddit|quora|medium|whatsapp|wa|t|linktr|linktree|ikman|olx|amazon|ebay|daraz|apple|zomato|ubereats|doordash|practo|healthgrades|zocdoc|houzz|thumbtack|angi|clutch|upwork|fiverr|waze|openstreetmap)\.[a-z.]+$/i
/** Free builders where the site lives under a path, not the host. */
const PATH_HOSTED = /(\.wixsite\.com|^sites\.google\.com)$/i

/** Normalise a website to its home page; null for social/maps/directory links. */
function siteUrl(/** @type {string} */ raw) {
  try {
    const u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`)
    const host = u.hostname.toLowerCase()
    if (!/^https?:$/.test(u.protocol) || !host.includes('.')) return null
    if (PATH_HOSTED.test(host)) return `${u.protocol}//${host}${u.pathname.replace(/\/+$/, '')}/`
    if (NOT_A_SITE.test(host)) return null
    return `${u.protocol}//${host}/`
  } catch {
    return null
  }
}

/** Same site, whatever the scheme or www. */
const siteKey = (/** @type {string} */ url) => {
  const u = new URL(url)
  return u.hostname.replace(/^www\./, '') + (PATH_HOSTED.test(u.hostname) ? u.pathname : '')
}

const normName = (/** @type {string} */ n) =>
  n
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b(pvt|ltd|llc|inc|co|plc|limited|private|the)\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')

/** @returns {Business} */
const blank = (/** @type {Partial<Business>} */ b) => ({
  name: '',
  city: '',
  website: null,
  phone: '',
  email: '',
  address: '',
  rating: null,
  reviews: null,
  mapsUrl: '',
  category: '',
  socials: [],
  sources: [],
  ...b
})

// ---------------------------------------------------------------- Google Maps (Places API, New)

const PLACE_FIELDS = [
  'places.displayName',
  'places.formattedAddress',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
  'places.googleMapsUri',
  'places.businessStatus',
  'places.primaryTypeDisplayName',
  'nextPageToken'
].join(',')

/** @param {Ctx} ctx @returns {Promise<Business[]>} */
async function fromGoogle(ctx, /** @type {string} */ key, /** @type {string} */ type, /** @type {string} */ city, /** @type {string} */ country, /** @type {number} */ limit) {
  /** @type {Business[]} */
  const out = []
  let pageToken = ''
  for (let page = 0; page < 3 && out.length < limit; page++) {
    /** @type {Record<string, unknown>} */
    const body = { textQuery: `${type} in ${city}${country ? `, ${country}` : ''}`, pageSize: 20, languageCode: 'en' }
    if (pageToken) body.pageToken = pageToken
    const r = await ctx.http.post('https://places.googleapis.com/v1/places:searchText', body, {
      headers: { 'x-goog-api-key': key, 'x-goog-fieldmask': PLACE_FIELDS, accept: 'application/json' },
      timeoutMs: 30_000
    })
    const j = JSON.parse(r.text || '{}')
    if (!r.ok) throw new Error(`Google Maps: ${j.error?.message ?? `HTTP ${r.status}`}`)
    for (const p of j.places ?? []) {
      if (p.businessStatus === 'CLOSED_PERMANENTLY') continue
      const site = p.websiteUri ? siteUrl(p.websiteUri) : null
      out.push(
        blank({
          name: p.displayName?.text ?? '',
          city,
          website: site,
          phone: p.internationalPhoneNumber || p.nationalPhoneNumber || '',
          address: p.formattedAddress ?? '',
          rating: typeof p.rating === 'number' ? p.rating : null,
          reviews: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
          mapsUrl: p.googleMapsUri ?? '',
          category: p.primaryTypeDisplayName?.text ?? '',
          socials: p.websiteUri && !site ? [p.websiteUri] : [],
          sources: ['Google Maps']
        })
      )
    }
    pageToken = j.nextPageToken ?? ''
    if (!pageToken) break
  }
  return out.slice(0, limit)
}

// ---------------------------------------------------------------- Google Maps in Isla's browser (no key)

/** Runs in the Maps page: every result card in the list (name, rating, category, address, phone, website). */
const MAPS_LIST = `(() => {
  const out = []
  for (const a of document.querySelectorAll('div[role="feed"] a[href*="/maps/place/"], a.hfpxzc')) {
    const card = a.parentElement
    if (!card) continue
    const text = (card.innerText || '').trim()
    if (/^\\s*sponsored\\b/im.test(text)) continue
    const lines = text.split('\\n').map(l => l.trim()).filter(Boolean)
    const star = card.querySelector('[role="img"][aria-label*="star" i]')
    const site = card.querySelector('a[data-value="Website"], a[aria-label*="website" i]')
    out.push({ name: a.getAttribute('aria-label') || lines[0] || '', href: a.href, lines, stars: star ? star.getAttribute('aria-label') : '', site: site ? site.href : '' })
  }
  const feed = document.querySelector('div[role="feed"]')
  return { url: location.href, feed: !!feed, end: /reached the end of the list/i.test(feed ? feed.innerText : ''), consent: /consent\.google/.test(location.host), items: out }
})()`

/** Runs on a place page: the details panel. */
const MAPS_PLACE = `(() => {
  const q = s => document.querySelector(s)
  const phone = q('[data-item-id^="phone:tel:"]')
  const addr = q('[data-item-id="address"]')
  const site = q('a[data-item-id="authority"]')
  return {
    name: q('h1') ? q('h1').innerText.trim() : '',
    phone: phone ? phone.getAttribute('data-item-id').replace('phone:tel:', '') : '',
    address: addr ? (addr.getAttribute('aria-label') || addr.innerText).replace(/^Address:\\s*/i, '').trim() : '',
    site: site ? site.href : '',
    category: q('button[jsaction*="category"]') ? q('button[jsaction*="category"]').innerText.trim() : ''
  }
})()`

const PHONE_LIKE = /^\+?[\d\s()-]{7,20}$/

/** Google sometimes wraps outgoing links: https://www.google.com/url?q=<real>&… */
const unwrap = (/** @type {string} */ u) => {
  try {
    const x = new URL(u)
    return /google\./.test(x.hostname) && x.pathname === '/url' ? x.searchParams.get('q') ?? x.searchParams.get('url') ?? u : u
  } catch {
    return u
  }
}

/**
 * Google Maps search in Isla's private browser window: scroll the result list, read every card,
 * and open a place page only when its card has no phone number.
 * @param {Ctx} ctx @returns {Promise<Business[]>}
 */
async function fromMaps(ctx, /** @type {string} */ type, /** @type {string} */ city, /** @type {string} */ country, /** @type {number} */ limit) {
  // No city: "… near me" — Google Maps uses its own estimate of where you are.
  const query = city ? `${type} in ${city}${country ? `, ${country}` : ''}` : `${type} near me${country ? ` ${country}` : ''}`
  await ctx.browser.open(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`, { width: 1280, height: 900, timeoutMs: 30_000 })
  /** @type {{ url: string, feed: boolean, end: boolean, consent: boolean, items: { name: string, href: string, lines: string[], stars: string, site: string }[] }} */
  let page = await ctx.browser.eval(MAPS_LIST)
  if (page.consent) {
    // Google's cookie wall (EU visitors): refuse the optional cookies and carry on.
    await ctx.browser.eval(`(() => { const b = [...document.querySelectorAll('button, input[type=submit]')].find(x => /reject all|accept all/i.test(x.innerText || x.value || x.getAttribute('aria-label') || '')); if (b) b.click() })()`)
    await sleep(3000)
    page = await ctx.browser.eval(MAPS_LIST)
  }
  // Wait for the list to appear, then scroll it until we have enough (or the list ends).
  for (let i = 0; i < 10 && !page.items.length; i++) {
    await sleep(1000)
    page = await ctx.browser.eval(MAPS_LIST)
  }
  let stale = 0
  for (let i = 0; i < 40 && page.feed && !page.end && page.items.length < limit && stale < 4; i++) {
    const before = page.items.length
    await ctx.browser.eval(`(() => { const f = document.querySelector('div[role="feed"]'); if (f) f.scrollTop = f.scrollHeight })()`)
    await sleep(1500 + Math.random() * 1000)
    page = await ctx.browser.eval(MAPS_LIST)
    stale = page.items.length > before ? 0 : stale + 1
  }
  // A search with one clear match opens that place directly.
  if (!page.items.length) {
    /** @type {{ name: string, phone: string, address: string, site: string, category: string }} */
    const one = await ctx.browser.eval(MAPS_PLACE)
    if (!one.name) throw new Error(`Google Maps showed no results for “${query}”.`)
    page.items = [{ name: one.name, href: page.url, lines: [one.name, one.category, one.address, one.phone], stars: '', site: one.site }]
  }

  /** @type {Business[]} */
  const out = []
  const seen = new Set()
  for (const it of page.items) {
    if (out.length >= limit || seen.has(it.href)) continue
    seen.add(it.href)
    const stars = it.stars.match(/([\d.,]+)\s*stars?\s*([\d,.]+)?/i)
    // Card lines: name, name, "4.8(572)", "Dental clinic · 139 Main St", "Open · Closes 5 PM · 0112 501 094", "Website"…
    const parts = it.lines.slice(1).flatMap(l => l.split('·').map(x => x.trim())).filter(Boolean)
    const catLine = it.lines.find(l => l.includes('·') && !/open|close|hours/i.test(l)) ?? ''
    const [category = '', ...addr] = catLine.split('·').map(x => x.trim())
    const b = blank({
      name: it.name,
      city,
      website: it.site ? siteUrl(unwrap(it.site)) : null,
      phone: parts.find(x => PHONE_LIKE.test(x)) ?? '',
      address: addr.filter(Boolean).join(', '),
      rating: stars ? parseFloat(stars[1].replace(',', '.')) : null,
      reviews: stars && stars[2] ? parseInt(stars[2].replace(/\D/g, ''), 10) : null,
      mapsUrl: it.href,
      category: category && !/^\d/.test(category) ? category : '',
      socials: it.site && !siteUrl(unwrap(it.site)) ? [unwrap(it.site)] : [],
      sources: ['Google Maps']
    })
    out.push(b)
  }
  // Cards without a phone: open the place page for the full details.
  for (const b of out.filter(x => !x.phone).slice(0, limit)) {
    try {
      await ctx.browser.open(b.mapsUrl, { timeoutMs: 20_000 })
      /** @type {{ name: string, phone: string, address: string, site: string, category: string }} */
      let d = await ctx.browser.eval(MAPS_PLACE)
      for (let i = 0; i < 5 && !d.name; i++) {
        await sleep(800)
        d = await ctx.browser.eval(MAPS_PLACE)
      }
      b.phone ||= d.phone
      b.address = d.address || b.address
      b.category ||= d.category
      if (!b.website && d.site) b.website = siteUrl(unwrap(d.site))
      await sleep(700 + Math.random() * 800)
    } catch {
      /* keep what the card had */
    }
  }
  return out
}

// ---------------------------------------------------------------- Brave Search API

/** "Best Dentists in Colombo | Top 10…" style pages are lists, not businesses. */
const LISTICLE = /\b(top|best)\s+\d+\b|\b\d+\s+best\b|\blist of\b|\bnear me\b|\bdirectory\b/i

/** @param {Ctx} ctx @returns {Promise<Business[]>} */
async function fromBrave(ctx, /** @type {string} */ key, /** @type {string} */ type, /** @type {string} */ city, /** @type {string} */ country, /** @type {number} */ limit) {
  /** @type {Business[]} */
  const out = []
  for (let offset = 0; offset < 2 && out.length < limit; offset++) {
    const q = new URLSearchParams({ q: `${type} ${city} ${country}`.trim(), count: '20', offset: String(offset) })
    const r = await ctx.http.get(`https://api.search.brave.com/res/v1/web/search?${q}`, { headers: { 'x-subscription-token': key, accept: 'application/json' }, timeoutMs: 20_000 })
    if (!r.ok) throw new Error(`Brave Search: HTTP ${r.status}${r.status === 401 || r.status === 422 ? ' (check the key)' : ''}`)
    for (const x of JSON.parse(r.text).web?.results ?? []) {
      const title = String(x.title ?? '').replace(/<[^>]+>/g, '')
      const site = siteUrl(String(x.url ?? ''))
      if (!site || LISTICLE.test(title)) continue
      out.push(blank({ name: title.split(/\s[|–—-]\s/)[0].trim().slice(0, 80), city, website: site, sources: ['Brave Search'] }))
    }
    await sleep(1100) // free plan: one request per second
  }
  return out.slice(0, limit)
}

/**
 * Map listings often have no website tag. Look the business up by name and accept a result only when its
 * domain clearly matches the name (e.g. "Royal Dental Clinic" → royaldental.lk), so we never guess wrong.
 * @param {Ctx} ctx @param {Business} b
 */
async function findWebsite(ctx, /** @type {string} */ key, b) {
  const q = new URLSearchParams({ q: `"${b.name}" ${b.city}`, count: '8' })
  const r = await ctx.http.get(`https://api.search.brave.com/res/v1/web/search?${q}`, { headers: { 'x-subscription-token': key, accept: 'application/json' }, timeoutMs: 20_000 })
  if (!r.ok) throw new Error(`Brave Search: HTTP ${r.status}`)
  const words = b.name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= 4 && !/^(clinic|dental|hotel|restaurant|centre|center|company|limited|private|services|solutions|group|the|and)$/.test(w))
  const initials = b.name
    .split(/\s+/)
    .filter(w => /^\p{L}/u.test(w))
    .map(w => w[0].toLowerCase())
    .join('')
  for (const x of JSON.parse(r.text).web?.results ?? []) {
    const site = siteUrl(String(x.url ?? ''))
    if (!site) continue
    const h = new URL(site).hostname.replace(/^www\./, '').split('.')[0].replace(/-/g, '')
    if (words.some(w => h.includes(w)) || (initials.length >= 3 && h.startsWith(initials))) return site
  }
  return null
}

// ---------------------------------------------------------------- AI web research (optional)

/** Finds the JSON in an AI answer even when it is wrapped in prose or ``` fences. */
function extractJson(/** @type {string} */ text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  for (const t of fenced ? [fenced[1], text] : [text]) {
    const starts = [...t.matchAll(/[[{]/g)].map(m => m.index ?? 0).slice(0, 40)
    const ends = [...t.matchAll(/[\]}]/g)].map(m => m.index ?? 0).reverse().slice(0, 20)
    for (const s of starts)
      for (const e of ends) {
        if (e <= s) continue
        try {
          return JSON.parse(t.slice(s, e + 1))
        } catch {
          /* keep trying */
        }
      }
  }
  return null
}

/** @param {Ctx} ctx @returns {Promise<Business[]>} */
async function fromAi(ctx, /** @type {string} */ type, /** @type {string[]} */ cities, /** @type {string} */ country, /** @type {number} */ limit) {
  const answer = await ctx.ai.research(
    `Find real ${type} businesses in each of these cities${country ? ` in ${country}` : ''}: ${cities.join(', ')}.\n` +
      `For each city list up to ${limit} different businesses that have their OWN website (not a directory, marketplace, Google Maps or social profile).\n` +
      'Reply with JSON only, exactly this shape, and nothing else:\n' +
      `{"${cities[0]}": [{"name": "Business name", "url": "https://their-website", "phone": "", "email": ""}]}`,
    { title: `SEO Scout: find ${type}` }
  )
  const data = extractJson(answer)
  /** @type {Business[]} */
  const out = []
  /** @param {string} city @param {any} f */
  const add = (city, f) => {
    const site = siteUrl(String(f?.url ?? f?.website ?? ''))
    if (site) out.push(blank({ name: String(f?.name ?? '').slice(0, 80), city, website: site, phone: String(f?.phone ?? ''), email: String(f?.email ?? ''), sources: ['AI research'] }))
  }
  if (Array.isArray(data)) for (const f of data) add(String(f?.city ?? cities[0]), f)
  else if (data && typeof data === 'object') for (const [city, list] of Object.entries(data)) if (Array.isArray(list)) for (const f of list.slice(0, limit)) add(city, f)
  return out
}

// ---------------------------------------------------------------- your list

/** "https://site.com | Colombo | Name" per line (city and name optional). @returns {Business[]} */
function fromList(/** @type {string} */ text, /** @type {string} */ defaultCity) {
  /** @type {Business[]} */
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const [u, c, n] = line.split('|').map(x => x.trim())
    const site = u ? siteUrl(u) : null
    if (site) out.push(blank({ name: n || new URL(site).hostname.replace(/^www\./, ''), city: c || defaultCity, website: site, sources: ['Your list'] }))
  }
  return out
}

// ---------------------------------------------------------------- merge

/** One entry per website (or per name + city when there is none); the first source's name wins. @param {Business[]} all */
function merge(all) {
  /** @type {Map<string, Business>} */
  const by = new Map()
  /** @param {Business} into @param {Business} b */
  const fold = (into, b) => {
    for (const f of /** @type {const} */ (['name', 'phone', 'email', 'address', 'mapsUrl', 'category'])) if (!into[f] && b[f]) into[f] = b[f]
    if (into.rating === null && b.rating !== null) {
      into.rating = b.rating
      into.reviews = b.reviews
    }
    if (!into.website && b.website) into.website = b.website
    into.sources = [...new Set([...into.sources, ...b.sources])]
    into.socials = [...new Set([...into.socials, ...b.socials])]
  }
  for (const b of all) {
    if (!b.name && !b.website) continue
    const key = b.website ? `w:${siteKey(b.website)}` : `n:${normName(b.name)}|${b.city.toLowerCase()}`
    const cur = by.get(key)
    if (cur) fold(cur, b)
    else by.set(key, { ...b, sources: [...b.sources], socials: [...b.socials] })
  }
  // A map listing without a website that has the same name as one with a website is the same business.
  const withSite = [...by.values()].filter(b => b.website)
  for (const [k, b] of by) {
    if (b.website) continue
    const twin = withSite.find(w => normName(w.name) === normName(b.name) && normName(b.name).length > 3)
    if (twin) {
      fold(twin, b)
      by.delete(k)
    }
  }
  return [...by.values()]
}

module.exports = { fromMaps, fromGoogle, fromBrave, fromAi, fromList, findWebsite, merge, siteUrl, siteKey, extractJson, sleep }

// @ts-check
/**
 * SEO Scout — an Isla plugin. Any business type, any city.
 * 1. Find businesses: Google Maps (in Isla's browser — or the Places API with a key), Brave Search,
 *    AI research (optional), your own list. Nothing set = any business near you.
 * 2. Crawl each website (several pages), run 75+ SEO / AEO / GEO checks and measure real speed in Isla's browser
 *    (or Google Lighthouse with a key).
 * 3. Collect contacts (emails, phones, WhatsApp, socials, address).
 * 4. Save report.md/html + sites.csv + contacts.csv + checks.csv + sites.json. Works fully without AI.
 */

const { fromMaps, fromGoogle, fromBrave, fromAi, fromList, findWebsite, merge, sleep } = require('./discover')
const { crawl, pagespeed, browserSpeed } = require('./crawl')
const { extractContacts } = require('./contacts')
const { detectTech, audit, schemaFacts } = require('./analyze')
const { buildReport, findings } = require('./report')

/** @typedef {import('../isla-plugin').PluginContext} Ctx */

const CONCURRENCY = 4
/** City label when none is set: Google Maps searches around you. */
const NEAR_YOU = 'Near you'
/** No business type set: a mix of everyday kinds (searching the word "businesses" only finds firms named "… Business …"). */
const ANY_KIND = ['restaurants', 'shops', 'hotels', 'clinics', 'offices']

/** "in Colombo, Kandy" — or "near you". */
const placeText = (/** @type {string[]} */ cities) => (cities.length === 1 && cities[0] === NEAR_YOU ? 'near you' : `in ${cities.join(', ')}`)

const splitList = (/** @type {string} */ s) =>
  s
    .split(/,|\n|\band\b|&|\//i)
    .map(x => x.trim())
    .filter(x => x.length > 1 && x.length < 50)

/**
 * "seo scout dentists in Colombo and Kandy" → { type: 'dentists', cities: ['Colombo', 'Kandy'] }
 * "seo report for Galle" → { type: '', cities: ['Galle'] }
 */
function parseChat(/** @type {string} */ text) {
  const rest = text
    .replace(/^.*?\b(seo scout|seo report|seo audit|aeo report|geo report|local seo report|website audit)\b\s*(for|of|on)?\s*/i, '')
    .replace(/[.?!]+$/, '')
    .trim()
  if (!rest) return { type: '', cities: [] }
  const m = rest.match(/^(.*?)\s+(?:in|at|around|near)\s+(.+)$/i)
  if (m) return { type: m[1].trim(), cities: splitList(m[2]) }
  if (/^(in|at|around|near)\s+/i.test(rest)) return { type: '', cities: splitList(rest.replace(/^\w+\s+/, '')) }
  return { type: '', cities: splitList(rest) }
}

/** @template T, R @param {T[]} items @param {(x: T, i: number) => Promise<R>} fn @returns {Promise<R[]>} */
async function pool(items, fn) {
  /** @type {R[]} */
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  return out
}

module.exports = {
  tools: {
    /** @param {Ctx} ctx */
    async report(ctx) {
      const s = ctx.settings
      const chat = ctx.input.trigger === 'chat' ? parseChat(ctx.input.text) : { type: '', cities: [] }
      // Nothing filled in: any kind of business, near you (Google Maps' own estimate of your location).
      const typed = (chat.type || String(s.businessType || '')).trim()
      const type = typed || 'businesses'
      const kinds = typed ? [typed] : ANY_KIND
      const named = chat.cities.length ? chat.cities : splitList(String(s.cities || ''))
      const cities = named.length ? named : [NEAR_YOU]
      const country = String(s.country || '').trim()
      const perCity = Math.min(60, Math.max(1, Number(s.perCity) || 20))
      const maxPages = Math.min(25, Math.max(1, Number(s.maxPages) || 8))
      const googleKey = String(s.googleKey || '').trim()
      const braveKey = String(s.braveKey || '').trim()

      // ---- 1. Find businesses
      /** @type {import('./discover').Business[]} */
      const found = []
      /** @type {Record<string, number>} */
      const sources = {}
      /** @type {string[]} */
      const notes = []
      /** @param {string} label @param {import('./discover').Business[]} list */
      const add = (label, list) => {
        found.push(...list)
        sources[label] = (sources[label] ?? 0) + list.length
      }
      if (s.showBrowser) await ctx.browser.show(true)
      for (const [i, city] of cities.entries()) {
        ctx.progress((i / cities.length) * 0.1, `Finding ${type} ${placeText([city])}…`)
        if (s.useMaps) {
          const where = city === NEAR_YOU ? '' : city
          // Several kinds share the city's quota.
          const each = Math.max(1, Math.ceil(perCity / kinds.length))
          for (const kind of kinds) {
            try {
              // With a key: Google's official Places API. Without: read Google Maps in Isla's browser, like a person would.
              const list = googleKey && where ? await fromGoogle(ctx, googleKey, kind, where, country, each) : await fromMaps(ctx, kind, where, country, each)
              for (const b of list) b.city = city
              add('Google Maps', list)
              if (kinds.length > 1) ctx.log(`   ${kind}: ${list.length}`)
            } catch (e) {
              notes.push(`Google Maps, ${kind} ${placeText([city])}: ${/** @type {Error} */ (e).message}`)
            }
          }
        }
        if (braveKey && city !== NEAR_YOU) {
          try {
            add('Brave Search', await fromBrave(ctx, braveKey, type, city, country, perCity))
          } catch (e) {
            notes.push(`Brave Search, ${city}: ${/** @type {Error} */ (e).message}`)
          }
        }
        ctx.log(`   ${city}: ${found.filter(b => b.city === city).length} listings so far`)
      }
      if (s.useAi) {
        try {
          ctx.log('AI web research…')
          add('AI research', await fromAi(ctx, type, cities, country, perCity))
        } catch (e) {
          notes.push(`AI research: ${/** @type {Error} */ (e).message}`)
        }
      }
      const mine = fromList(String(s.extraSites || ''), cities[0])
      if (mine.length) add('Your list', mine)

      const all = merge(found)
      // Map listings without a website: look the website up by name (Brave key), accepting only a domain that matches the name.
      if (braveKey) {
        const missing = all.filter(b => !b.website).slice(0, 15 * cities.length)
        let hits = 0
        for (const b of missing) {
          try {
            const site = await findWebsite(ctx, braveKey, b)
            if (site) {
              b.website = site
              b.sources.push('website found by name')
              hits++
            }
          } catch (e) {
            notes.push(`Website lookup: ${/** @type {Error} */ (e).message}`)
            break
          }
          await sleep(1100)
        }
        if (missing.length) ctx.log(`Found websites for ${hits} of ${missing.length} map listings without one`)
      }
      // Per city: the first `perCity` websites (in source order — Google's ranking first).
      /** @type {Record<string, number>} */
      const taken = {}
      const withSite = all.filter(b => b.website && (b.sources.includes('Your list') || (taken[b.city] = (taken[b.city] ?? 0) + 1) <= perCity))
      const noSite = all.filter(b => !b.website)
      ctx.log(`${all.length} businesses: ${withSite.length} websites to audit, ${noSite.length} without a website`)
      if (!withSite.length && !noSite.length) throw new Error(`Found no ${typed ? `“${typed}” businesses` : 'businesses'} ${placeText(cities)}.${notes.length ? ` ${notes.join(' ')}` : ''} Try another business type or city.`)

      // ---- 2. Audit every website
      // a) Crawl in parallel (pages, robots.txt, sitemap, llms.txt…).
      let done = 0
      const crawled = await pool(withSite, async b => {
        const c = await crawl(ctx, /** @type {string} */ (b.website), maxPages)
        done++
        ctx.progress(0.1 + (0.5 * done) / withSite.length, c.error === null ? `${b.name} — ${c.pages.length} pages read` : `x ${b.name} — ${c.error}`)
        return { b, c }
      })
      const ok = crawled.filter(x => x.c.error === null)

      // b) Timings, one site at a time with nothing else running — parallel downloads would make every site look slow.
      //    Speed: Google Lighthouse with a key (its free quota without one is gone); otherwise measured in Isla's browser.
      const usePsi = s.speed !== false && !!googleKey
      const useBrowserSpeed = s.speed !== false && !googleKey
      let psiOff = ''
      let psiDone = 0
      /** @type {Map<string, { psi: Awaited<ReturnType<typeof pagespeed>> | null, speedData: Awaited<ReturnType<typeof browserSpeed>> | null, psiError: string }>} */
      const timing = new Map()
      for (const [i, { b, c }] of ok.entries()) {
        if (c.error !== null) continue
        // Server response on a quiet, warm connection.
        const warm = await ctx.http.get(c.home.url, { timeoutMs: 15_000, maxBytes: 1024 }).catch(() => null)
        if (warm) c.ttfb = warm.ttfb
        /** @type {Awaited<ReturnType<typeof pagespeed>> | null} */
        let psi = null
        let psiError = ''
        if (usePsi && !psiOff) {
          try {
            psi = await pagespeed(ctx, c.home.url, googleKey)
            psiDone++
          } catch (e) {
            const err = /** @type {Error & { status?: number }} */ (e)
            psiError = `Not measured: ${err.message.slice(0, 120)}`
            if (err.status === 429 || err.status === 403) psiOff = `Google PageSpeed refused (${err.status}): ${err.message.slice(0, 140)} — check that the PageSpeed Insights API is enabled for your key.`
          }
        }
        /** @type {Awaited<ReturnType<typeof browserSpeed>> | null} */
        let speedData = null
        if (useBrowserSpeed || (usePsi && !psi)) {
          try {
            speedData = await browserSpeed(ctx, c.home.url)
          } catch (e) {
            psiError = `Not measured: ${/** @type {Error} */ (e).message.slice(0, 120)}`
          }
        }
        timing.set(c.home.url, { psi, speedData, psiError })
        const lcp = psi?.lcp ?? speedData?.lcp
        ctx.progress(0.6 + (0.35 * (i + 1)) / ok.length, `${b.name} — server ${Math.round(c.ttfb)} ms${lcp != null ? ` · LCP ${(lcp / 1000).toFixed(1)} s` : ''}`)
      }

      // c) Score everything.
      const results = crawled.map(({ b, c }) => {
        if (c.error !== null) return { ...b, error: c.error }
        const { psi, speedData, psiError } = timing.get(c.home.url) ?? { psi: null, speedData: null, psiError: '' }
        const contacts = extractContacts(c.pages, schemaFacts(c.pages))
        const tech = detectTech(c.home)
        const a = audit(c, { city: b.city === NEAR_YOU ? '' : b.city, listingPhone: b.phone, rating: b.rating, reviews: b.reviews, psi, speed: speedData, contacts })
        ctx.log(`${b.name} — ${tech.platform} · SEO ${a.seo} · AEO ${a.aeo} · GEO ${a.geo}${a.speed !== null ? ` · Speed ${a.speed}` : ''} · ${contacts.emails.length} email(s)`)
        return { ...b, businessCategory: b.category, error: null, finalUrl: c.home.url, ...tech, ...a, contacts, psi, speedData, psiError }
      })
      const sites = /** @type {any[]} */ (results.filter(r => !r.error))
      const failed = results.filter(r => r.error)
      if (psiOff) notes.push(psiOff)

      // ---- 3. Compare with earlier runs
      /** @type {Record<string, { first: number, overall: number }>} */
      const seen = (await ctx.storage.get('sites')) ?? {}
      for (const r of sites) {
        const k = new URL(r.finalUrl).hostname.replace(/^www\./, '')
        const prev = seen[k]
        r.isNew = !prev
        r.delta = prev ? r.overall - prev.overall : null
        seen[k] = { first: prev?.first ?? Date.now(), overall: r.overall }
      }
      await ctx.storage.set('sites', seen)

      // ---- 4. Optional AI summary (the report always has rule-based findings)
      let aiInsights = ''
      if (s.aiInsights && sites.length) {
        try {
          ctx.log('Writing AI insights…')
          const table = sites
            .map(r => `${r.name} | ${r.city} | ${r.platform} | SEO ${r.seo} AEO ${r.aeo} GEO ${r.geo} Speed ${r.speed ?? '-'} | fails: ${r.fixes.slice(0, 5).map((/** @type {any} */ c) => c.label).join('; ')}`)
            .join('\n')
          aiInsights = await ctx.ai.ask(
            `${type} websites ${placeText(cities)} with their SEO / AEO / GEO / speed scores and failed checks:\n${table}\n\n` +
              'Write 5–7 short bullet points for a web/SEO agency: the patterns, which platforms do worst, and the 3 best businesses to pitch with what to pitch each. Markdown bullets only.',
            { system: 'You are a concise SEO, AEO and GEO analyst. Use only the data given.' }
          )
        } catch (e) {
          notes.push(`AI insights: ${/** @type {Error} */ (e).message}`)
        }
      }

      // ---- 5. Save
      const measured = sites.filter(x => x.speedData).length
      const pagespeedNote = s.speed === false ? 'off' : [psiDone && `Google Lighthouse for ${psiDone} sites`, measured && `measured in Isla’s browser for ${measured} sites`].filter(Boolean).join(', ') || 'not measured'
      const rep = buildReport({ type, cities, country, sources, notes, sites, noSite, failed, aiInsights, pagespeed: pagespeedNote })
      const folder = await ctx.report.save({
        title: `SEO / AEO / GEO report: ${type} ${placeText(cities)}`,
        markdown: rep.markdown,
        files: {
          ...rep.files,
          'sites.json': JSON.stringify({ type, cities, country, date: new Date().toISOString(), sources, sites: sites.map(({ business, ...r }) => r), noSite, failed }, null, 1)
        }
      })
      ctx.log(`Saved to ${folder}`)

      const top = [...sites]
        .sort((a, b) => a.overall - b.overall)
        .slice(0, 3)
        .map(r => `- **${r.name}** (${r.city}, ${r.platform}) — overall ${r.overall}${r.contacts.emails[0] ? ` · ${r.contacts.emails[0]}` : ''}`)
        .join('\n')
      return {
        summary:
          `**${type} ${placeText(cities)}:** ${sites.length} websites audited${failed.length ? `, ${failed.length} unreachable` : ''}, ${noSite.length} without a website.\n\n` +
          findings(sites, noSite)
            .slice(0, 3)
            .map(x => `- ${x}`)
            .join('\n') +
          (top ? `\n\n**Best prospects:**\n${top}` : '')
      }
    }
  },
  parseChat
}


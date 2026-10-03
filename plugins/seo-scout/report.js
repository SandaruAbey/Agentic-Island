// @ts-check
/**
 * Turns the audit results into report.md (Isla also makes report.html from it) and CSV files.
 * The "Key findings" are computed from the numbers — no AI needed.
 */

const cell = (/** @type {unknown} */ v) => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
const csvCell = (/** @type {unknown} */ v) => `"${String(v ?? '').replace(/"/g, '""')}"`
const csv = (/** @type {string[]} */ cols, /** @type {unknown[][]} */ rows) => [cols.join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\r\n')
const avg = (/** @type {(number | null)[]} */ xs) => {
  const v = /** @type {number[]} */ (xs.filter(x => typeof x === 'number'))
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null
}
const median = (/** @type {number[]} */ xs) => {
  const v = [...xs].sort((a, b) => a - b)
  return v.length ? v[Math.floor(v.length / 2)] : null
}
const dash = (/** @type {unknown} */ v) => (v === null || v === undefined || v === '' ? '—' : String(v))
const pct = (/** @type {number} */ a, /** @type {number} */ b) => (b ? Math.round((100 * a) / b) : 0)
const lead = (/** @type {number} */ n) => (n < 45 ? 'Hot lead' : n < 65 ? 'Warm lead' : 'Strong site')
const host = (/** @type {string} */ u) => new URL(u).hostname.replace(/^www\./, '')
const plural = (/** @type {number} */ n, /** @type {string} */ one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** @param {any[]} xs @param {(x: any) => string} key */
const groupBy = (xs, key) => xs.reduce((m, x) => ((m[key(x)] ??= []).push(x), m), /** @type {Record<string, any[]>} */ ({}))

/** @param {Record<string, any[]>} groups @param {string} label */
function scoreTable(groups, label) {
  const rows = Object.entries(groups).sort((a, b) => b[1].length - a[1].length)
  return [
    `| ${label} | Sites | SEO | AEO | GEO | Speed | Overall |`,
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows.map(([k, xs]) => `| ${cell(k)} | ${xs.length} | ${dash(avg(xs.map(x => x.seo)))} | ${dash(avg(xs.map(x => x.aeo)))} | ${dash(avg(xs.map(x => x.geo)))} | ${dash(avg(xs.map(x => x.speed)))} | ${dash(avg(xs.map(x => x.overall)))} |`)
  ].join('\n')
}

/** Rule-based findings from the numbers. @param {any[]} sites @param {any[]} noSite */
function findings(sites, noSite) {
  const n = sites.length
  const out = []
  if (!n) return noSite.length ? [`**${plural(noSite.length, 'business has', 'businesses have')} no website at all** — the easiest leads.`] : []
  // The problems most sites share (important checks first).
  /** @type {Record<string, { label: string, fix: string, count: number, weight: number }>} */
  const fails = {}
  for (const s of sites) for (const c of s.checks) if (c.ok === false) (fails[c.id] ??= { label: c.label, fix: c.fix, count: 0, weight: c.weight }).count++
  const common = Object.values(fails)
    .filter(f => f.weight >= 2)
    .sort((a, b) => b.count * b.weight - a.count * a.weight)
    .slice(0, 5)
  for (const f of common) out.push(`**${f.count} of ${n} sites (${pct(f.count, n)}%) fail “${f.label}”.** ${f.fix}`)

  const blockedAi = sites.filter(s => s.blockedAiSearch.length)
  if (blockedAi.length) out.push(`**${plural(blockedAi.length, 'site blocks', 'sites block')} AI search crawlers** (ChatGPT / Claude / Perplexity can't read them): ${blockedAi.slice(0, 5).map(s => s.name).join(', ')}.`)
  const jsOnly = sites.filter(s => s.homeWords < 150)
  if (jsOnly.length) out.push(`**${plural(jsOnly.length, 'site shows', 'sites show')} almost no text without JavaScript** — invisible to most AI crawlers.`)
  const llms = sites.filter(s => s.checks.find((/** @type {any} */ c) => c.id === 'llms')?.ok).length
  out.push(`**${llms} of ${plural(n, 'site')} ${llms === 1 ? 'has' : 'have'} llms.txt.**`)

  const byPlatform = Object.entries(groupBy(sites, s => s.platform)).filter(([, xs]) => xs.length >= 2)
  if (byPlatform.length >= 2) {
    byPlatform.sort((a, b) => /** @type {number} */ (avg(a[1].map((/** @type {any} */ x) => x.overall))) - /** @type {number} */ (avg(b[1].map((/** @type {any} */ x) => x.overall))))
    const [worst, best] = [byPlatform[0], byPlatform[byPlatform.length - 1]]
    out.push(`**Weakest platform: ${worst[0]}** (average ${avg(worst[1].map((/** @type {any} */ x) => x.overall))}); strongest: ${best[0]} (${avg(best[1].map((/** @type {any} */ x) => x.overall))}).`)
  }
  const perf = sites.map(s => s.psi?.performance).filter(x => typeof x === 'number')
  const lcps = sites.map(s => s.psi?.lcp ?? s.speedData?.lcp).filter(x => typeof x === 'number')
  if (lcps.length) {
    const lcpFail = lcps.filter(x => x > 2500).length
    out.push(
      `**Speed:** ${perf.length ? `median mobile Lighthouse performance ${median(perf)}/100; ` : ''}median LCP ${(/** @type {number} */ (median(lcps)) / 1000).toFixed(1)} s — ${lcpFail} of ${plural(lcps.length, 'site')} take longer than 2.5 s to show their main content.`
    )
  }
  const withEmail = sites.filter(s => s.contacts.emails.length).length
  const withPhone = sites.filter(s => s.contacts.phones.length || s.phone).length
  out.push(`**Contacts:** email found for ${withEmail} of ${n} websites, phone for ${withPhone}.`)
  if (noSite.length) out.push(`**${plural(noSite.length, 'business has', 'businesses have')} no website at all** (${noSite.filter(b => b.phone).length} with a phone number) — the easiest leads.`)
  return out
}

/**
 * @param {{ type: string, cities: string[], country: string, sources: Record<string, number>, notes: string[], sites: any[], noSite: any[], failed: any[], aiInsights: string, pagespeed: string }} r
 */
function buildReport(r) {
  const { sites, noSite, failed } = r
  const ranked = [...sites].sort((a, b) => a.overall - b.overall)
  const date = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const total = sites.length + failed.length + noSite.length
  const contactLine = (/** @type {any} */ s) => {
    const c = s.contacts
    const bits = [
      c.emails.length && `Email: ${c.emails.map((/** @type {string} */ e) => `[${e}](mailto:${e})`).join(', ')}`,
      (c.phones.length || s.phone) && `Phone: ${[...new Set([s.phone, ...c.phones].filter(Boolean))].join(', ')}`,
      c.whatsapp.length && `WhatsApp ${c.whatsapp.join(', ')}`,
      (c.address || s.address) && `Address: ${c.address || s.address}`,
      c.contactPage && `[Contact page](${c.contactPage})`,
      c.contactForm && 'contact form',
      ...Object.entries(c.socials).map(([k, v]) => `[${k}](${v})`)
    ].filter(Boolean)
    return bits.length ? bits.join(' · ') : 'None found on the site'
  }

  const md = [
    `**${date}** · ${r.type} ${r.cities.length === 1 && r.cities[0] === 'Near you' ? 'near you' : `in ${r.cities.join(', ')}`}${r.country ? `, ${r.country}` : ''}`,
    `Found with: ${Object.entries(r.sources).map(([k, v]) => `${k} ${v}`).join(' · ') || 'nothing'}${r.pagespeed ? ` · Speed: ${r.pagespeed}` : ''}`,
    `**${total} businesses:** ${sites.length} websites audited, ${failed.length} could not be checked, ${noSite.length} without a website.`,
    ...r.notes.map(x => `> Note: ${x}`),

    '## Key findings',
    findings(sites, noSite).map(x => `- ${x}`).join('\n'),
    r.aiInsights && `## AI insights\n${r.aiInsights.trim()}`,

    sites.length && '## Ranking — weakest websites first (best prospects)',
    sites.length &&
      [
        '| # | Business | City | Platform | SEO | AEO | GEO | Speed | Overall | Lead | Google | Email | Phone |',
        '|---:|---|---|---|---:|---:|---:|---:|---:|---|---|---|---|',
        ...ranked.map(
          (s, i) =>
            `| ${i + 1} | [${cell(s.name)}](${s.finalUrl})${s.isNew ? ' (new)' : ''} | ${cell(s.city)} | ${cell(s.platform)} | ${s.seo} | ${s.aeo} | ${s.geo} | ${dash(s.speed)} | **${s.overall}**${s.delta ? ` (${s.delta > 0 ? '+' : ''}${s.delta})` : ''} | ${lead(s.overall)} | ${s.rating !== null ? `${s.rating} (${s.reviews})` : '—'} | ${cell(s.contacts.emails[0] ?? '—')} | ${cell(s.contacts.phones[0] ?? s.phone ?? '—') || '—'} |`
        )
      ].join('\n'),

    sites.length && '## How the websites are built',
    sites.length && scoreTable(groupBy(sites, s => s.platform), 'Platform'),
    sites.length && scoreTable(groupBy(sites, s => s.category), 'Category'),
    sites.length > 1 && r.cities.length > 1 && `## By city\n\n${scoreTable(groupBy(sites, s => s.city), 'City')}`,

    sites.length && '## Most common problems',
    sites.length &&
      (() => {
        /** @type {Record<string, { area: string, label: string, fix: string, count: number }>} */
        const f = {}
        for (const s of sites) for (const c of s.checks) if (c.ok === false) (f[c.id] ??= { area: c.area, label: c.label, fix: c.fix, count: 0 }).count++
        return [
          '| Problem | Area | Sites | % | Fix |',
          '|---|---|---:|---:|---|',
          ...Object.values(f)
            .sort((a, b) => b.count - a.count)
            .slice(0, 20)
            .map(x => `| ${cell(x.label)} | ${x.area} | ${x.count} | ${pct(x.count, sites.length)}% | ${cell(x.fix)} |`)
        ].join('\n')
      })(),

    noSite.length && '## Businesses without a website',
    noSite.length &&
      [
        '| Business | City | Category | Phone | Email | Address | Google | Social | Map |',
        '|---|---|---|---|---|---|---|---|---|',
        ...noSite.map(
          b =>
            `| ${cell(b.name)} | ${cell(b.city)} | ${cell(b.category) || '—'} | ${cell(b.phone) || '—'} | ${cell(b.email) || '—'} | ${cell(b.address) || '—'} | ${b.rating !== null ? `${b.rating} (${b.reviews})` : '—'} | ${b.socials.length ? b.socials.slice(0, 2).map((/** @type {string} */ u, /** @type {number} */ i) => `[link ${i + 1}](${u})`).join(' ') : '—'} | ${b.mapsUrl ? `[Google Maps](${b.mapsUrl})` : '—'} |`
        )
      ].join('\n'),

    failed.length && `## Websites that could not be checked\n${failed.map(b => `- **${b.name}** (${b.website}) — ${b.error}${b.phone ? ` · Phone: ${b.phone}` : ''}`).join('\n')}`,

    sites.length && '## Site details',
    ...ranked.map((s, i) => {
      const ps = s.psi
      const failedChecks = s.checks.filter((/** @type {any} */ c) => c.ok === false).sort((/** @type {any} */ a, /** @type {any} */ b) => b.weight - a.weight)
      const passed = s.checks.filter((/** @type {any} */ c) => c.ok === true)
      const na = s.checks.filter((/** @type {any} */ c) => c.ok === null)
      return [
        `### ${i + 1}. ${s.name} — ${host(s.finalUrl)}`,
        `[${s.finalUrl}](${s.finalUrl}) · ${s.city} · **${s.platform}** (${s.category})${s.stack.length > 1 ? ` · ${s.stack.slice(1).join(', ')}` : ''}${s.addons.length ? ` · ${s.addons.join(', ')}` : ''} · found via ${s.sources.join(', ')}`,
        `**Scores:** SEO ${s.seo} · AEO ${s.aeo} · GEO ${s.geo} · Speed ${dash(s.speed)} · **Overall ${s.overall}** — ${lead(s.overall)}`,
        `**Contacts:** ${contactLine(s)}`,
        s.rating !== null || s.mapsUrl ? `**Google Maps:** ${s.rating !== null ? `${s.rating} from ${s.reviews} reviews` : 'no rating'}${s.mapsUrl ? ` · [listing](${s.mapsUrl})` : ''}` : '',
        ps
          ? `**Lighthouse (mobile):** Performance ${dash(ps.performance)} · SEO ${dash(ps.seo)} · Accessibility ${dash(ps.accessibility)} · Best practices ${dash(ps.bestPractices)} · LCP ${ps.lcp != null ? (ps.lcp / 1000).toFixed(1) + ' s' : '—'} · CLS ${ps.cls != null ? ps.cls.toFixed(3) : '—'} · TBT ${ps.tbt != null ? Math.round(ps.tbt) + ' ms' : '—'}${ps.field ? ` · Real users: ${ps.field.category}` : ''}`
          : s.speedData
            ? `**Speed (Isla’s browser, phone size, empty cache):** LCP ${s.speedData.lcp != null ? (s.speedData.lcp / 1000).toFixed(1) + ' s' : '—'} · FCP ${s.speedData.fcp != null ? (s.speedData.fcp / 1000).toFixed(1) + ' s' : '—'} · CLS ${s.speedData.cls.toFixed(3)} · loaded in ${(s.speedData.load / 1000).toFixed(1)} s · ${(s.speedData.bytes / 1_048_576).toFixed(1)} MB+ in ${s.speedData.requests} requests`
            : s.psiError
              ? `**Speed:** ${s.psiError}`
              : '',
        `**Crawled:** ${s.pagesCrawled} pages · ${s.homeWords} words on the home page · schema: ${s.schemaTypes.slice(0, 8).join(', ') || 'none'}`,
        failedChecks.length
          ? ['**What to fix (most important first)**', '', '| Area | Check | What we found | How to fix |', '|---|---|---|---|', ...failedChecks.map((/** @type {any} */ c) => `| ${c.area} | ${cell(c.label)} | ${cell(c.found)} | ${cell(c.fix)} |`)].join('\n')
          : '**Nothing to fix — every check passed.**',
        `**Passed (${passed.length}):** ${passed.map((/** @type {any} */ c) => c.label).join(' · ')}`,
        na.length ? `*Not checked (${na.length}): ${na.map((/** @type {any} */ c) => c.label).join(' · ')}*` : ''
      ]
        .filter(Boolean)
        .join('\n\n')
    }),

    '## How the scores work',
    [
      '- Every site gets 75+ checks. Each check has a weight (1–3); a score is the weighted share of checks passed, 0–100. Checks that don’t apply (no map listing, no Lighthouse data) don’t count.',
      '- **SEO**: technical (HTTPS, redirects, robots.txt, sitemap, canonical, real 404s, broken pages, compression, server speed), on-page (titles, descriptions, headings, content, images, Open Graph) and local (city, phone, NAP match with the map listing, address, map, Google rating).',
      '- **Speed**: measured by loading each site fresh in Isla’s browser at phone size — LCP, CLS, FCP, load time, page weight, requests, JavaScript. With a Google API key: Google Lighthouse (mobile) and Chrome real-user data instead.',
      '- **AEO** (Google featured snippets, AI Overviews, voice): structured data and its completeness, FAQ schema, question headings, short direct answers, lists/tables, service and review schema.',
      '- **GEO** (ChatGPT, Claude, Perplexity, Gemini): AI crawlers allowed, content readable without JavaScript, llms.txt, depth, facts and citations, sameAs entity links, social profiles, about/team pages, named experts, freshness.',
      '- **Overall** = average of SEO, AEO, GEO (and Speed when measured). **Hot lead** under 45, **warm** under 65.'
    ].join('\n')
  ]
    .filter(x => x !== false && x !== '' && x !== 0 && x !== null && x !== undefined)
    .join('\n\n')

  // ---- CSV files
  const socialsOf = (/** @type {any} */ c) => ['facebook', 'instagram', 'linkedin', 'x', 'youtube', 'tiktok'].map(k => c.socials?.[k] ?? '')
  const sitesCsv = csv(
    ['rank', 'business', 'city', 'website', 'platform', 'category', 'stack', 'addons', 'seo', 'aeo', 'geo', 'speed', 'overall', 'change', 'lead', 'new', 'emails', 'phones', 'whatsapp', 'address', 'contact_page', 'facebook', 'instagram', 'linkedin', 'x', 'youtube', 'tiktok', 'google_rating', 'google_reviews', 'google_maps', 'lh_performance', 'lh_seo', 'lh_accessibility', 'lh_best_practices', 'lcp_s', 'cls', 'tbt_ms', 'field_cwv', 'pages_crawled', 'home_words', 'schema_types', 'ai_search_bots_blocked', 'ai_training_bots_blocked', 'top_fixes', 'sources'],
    ranked.map((s, i) => [
      i + 1, s.name, s.city, s.finalUrl, s.platform, s.category, s.stack.join(' + '), s.addons.join(' + '), s.seo, s.aeo, s.geo, s.speed ?? '', s.overall, s.delta ?? '', lead(s.overall), s.isNew ? 'yes' : '',
      s.contacts.emails.join('; '), [...new Set([s.phone, ...s.contacts.phones].filter(Boolean))].join('; '), s.contacts.whatsapp.join('; '), s.contacts.address || s.address, s.contacts.contactPage, ...socialsOf(s.contacts),
      s.rating ?? '', s.reviews ?? '', s.mapsUrl, s.psi?.performance ?? '', s.psi?.seo ?? '', s.psi?.accessibility ?? '', s.psi?.bestPractices ?? '', (s.psi?.lcp ?? s.speedData?.lcp) != null ? ((s.psi?.lcp ?? s.speedData?.lcp) / 1000).toFixed(2) : '', (s.psi?.cls ?? s.speedData?.cls) != null ? (s.psi?.cls ?? s.speedData?.cls).toFixed(3) : '', s.psi?.tbt != null ? Math.round(s.psi.tbt) : '', s.psi?.field?.category ?? '',
      s.pagesCrawled, s.homeWords, s.schemaTypes.join(' '), s.blockedAiSearch.join(' '), s.blockedAiTraining.join(' '), s.fixes.slice(0, 5).map((/** @type {any} */ c) => c.fix).join(' | '), s.sources.join(', ')
    ])
  )
  const contactsCsv = csv(
    ['business', 'city', 'website', 'has_website', 'status', 'emails', 'phones', 'whatsapp', 'address', 'facebook', 'instagram', 'linkedin', 'x', 'youtube', 'tiktok', 'other_links', 'category', 'google_rating', 'google_reviews', 'google_maps', 'sources'],
    [
      ...ranked.map(s => [s.name, s.city, s.finalUrl, 'yes', 'audited', [...new Set([s.email, ...s.contacts.emails].filter(Boolean))].join('; '), [...new Set([s.phone, ...s.contacts.phones].filter(Boolean))].join('; '), s.contacts.whatsapp.join('; '), s.contacts.address || s.address, ...socialsOf(s.contacts), '', s.businessCategory, s.rating ?? '', s.reviews ?? '', s.mapsUrl, s.sources.join(', ')]),
      ...failed.map(b => [b.name, b.city, b.website, 'yes', b.error, b.email, b.phone, '', b.address, '', '', '', '', '', '', b.socials.join(' '), b.category, b.rating ?? '', b.reviews ?? '', b.mapsUrl, b.sources.join(', ')]),
      ...noSite.map(b => [b.name, b.city, '', 'no', 'no website', b.email, b.phone, '', b.address, '', '', '', '', '', '', b.socials.join(' '), b.category, b.rating ?? '', b.reviews ?? '', b.mapsUrl, b.sources.join(', ')])
    ]
  )
  const checksCsv = csv(
    ['business', 'website', 'area', 'check', 'result', 'weight', 'found', 'fix'],
    ranked.flatMap(s => s.checks.map((/** @type {any} */ c) => [s.name, s.finalUrl, c.area, c.label, c.ok === null ? 'n/a' : c.ok ? 'pass' : 'fail', c.weight, c.found, c.fix]))
  )
  return { markdown: md, files: { 'sites.csv': sitesCsv, 'contacts.csv': contactsCsv, 'checks.csv': checksCsv } }
}

module.exports = { buildReport, findings, lead }

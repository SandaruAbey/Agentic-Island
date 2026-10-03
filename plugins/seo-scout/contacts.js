// @ts-check
/**
 * Contact details a business publishes on its own website: emails (mailto, text, "info [at] site [dot] com",
 * Cloudflare-protected), phone numbers (tel: links, structured data, international numbers in the text),
 * WhatsApp, social profiles, address, contact page and contact form.
 */

/** @typedef {import('../isla-plugin').HttpResponse} Res */

const SOCIAL = /** @type {const} */ ([
  ['facebook', /^https?:\/\/(?:www\.|m\.|web\.)?(?:facebook|fb)\.com\/(?!sharer|share|dialog|plugins|tr\b|login|privacy|policies|help|events\/?$)([^?#"'\s]+)/i],
  ['instagram', /^https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reel\/|explore|accounts|direct)([\w.]+)/i],
  ['linkedin', /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in|school)\/([^?#"'\s/]+)/i],
  ['x', /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!intent|share|home|search|hashtag|i\/)(\w{1,30})/i],
  ['youtube', /^https?:\/\/(?:www\.)?youtube\.com\/(?:@[\w.-]+|channel\/[\w-]+|c\/[\w-]+|user\/[\w-]+)/i],
  ['tiktok', /^https?:\/\/(?:www\.)?tiktok\.com\/@[\w.]+/i],
  ['pinterest', /^https?:\/\/(?:[a-z]{2}\.)?pinterest\.[a-z.]+\/(?!pin\/)([\w-]+)/i]
])
/** @typedef {typeof SOCIAL[number][0]} SocialNet */

/** File names that look like emails, and template placeholders. */
const NOT_EMAIL = /\.(png|jpe?g|gif|svg|webp|avif|css|js|ico)$|@(example|domain|email|yourdomain|yoursite|mysite|website|company|sentry|wixpress|sentry-next)\.|^(your|you)[@.]/i

const uri = (/** @type {string} */ s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const decodeEntities = (/** @type {string} */ s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')

/** Cloudflare "email protection": hex string, first byte is the XOR key. */
function cfDecode(/** @type {string} */ hex) {
  const key = parseInt(hex.slice(0, 2), 16)
  let out = ''
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key)
  return out
}

const digits = (/** @type {string} */ p) => p.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '')
/** The last 9 digits — enough to tell numbers apart whatever the country/area prefix. */
const phoneKey = (/** @type {string} */ p) => p.replace(/\D/g, '').slice(-9)

/**
 * @param {Res[]} pages
 * @param {{ telephone?: string[], email?: string[], address?: string, sameAs?: string[] }} schema facts from JSON-LD
 */
function extractContacts(pages, schema = {}) {
  /** @type {Set<string>} */
  const emails = new Set()
  /** @type {Map<string, string>} */
  const phones = new Map()
  /** @type {Set<string>} */
  const whatsapp = new Set()
  /** @type {Record<string, string>} */
  const socials = {}
  let contactPage = ''
  let contactForm = false
  let mapEmbed = false

  /** @param {string} e */
  const addEmail = e => {
    const v = uri(e).trim().replace(/^mailto:/i, '').split('?')[0].toLowerCase()
    if (/^[\w.%+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}$/.test(v) && !NOT_EMAIL.test(v) && v.length < 80) emails.add(v)
  }
  /** @param {string} p */
  const addPhone = p => {
    const d = digits(uri(p))
    const n = d.replace(/\D/g, '').length
    if (n >= 7 && n <= 15 && !phones.has(phoneKey(d))) phones.set(phoneKey(d), d)
  }
  /** @param {string} href */
  const addSocial = href => {
    for (const [net, re] of SOCIAL) {
      const m = href.match(re)
      if (m && !socials[net]) socials[net] = m[0].replace(/[/?#]+$/, '')
    }
  }

  for (const p of pages) {
    const html = p.text
    for (const m of html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)) addEmail(m[1])
    for (const m of html.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) addEmail(cfDecode(m[1]))
    const text = decodeEntities(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
      .replace(/\s*[[(]\s*at\s*[\])]\s*/gi, '@')
      .replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, '.')
    for (const m of text.matchAll(/[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi)) addEmail(m[0])
    for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)/gi)) addPhone(m[1])
    // Numbers written out in international form (+94 11 234 5678, 0094…) — local formats are too ambiguous to guess.
    for (const m of text.matchAll(/(?:\+|\b00)\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}\b/g)) addPhone(m[0])
    for (const m of html.matchAll(/(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?phone=|whatsapp:\/\/send\?phone=)\+?(\d{7,15})/gi)) whatsapp.add(`+${m[1]}`)
    for (const m of html.matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) addSocial(decodeEntities(m[1]))
    if (/contact|reach-us|get-in-touch/i.test(new URL(p.url).pathname) && !contactPage) contactPage = p.url
    if (/<form\b[\s\S]*?(type\s*=\s*["']email["']|name\s*=\s*["'][^"']*e-?mail)[\s\S]*?<\/form>/i.test(html)) contactForm = true
    if (/<iframe[^>]+(google\.[a-z.]+\/maps|maps\.google\.|openstreetmap\.org\/export)/i.test(html)) mapEmbed = true
  }
  for (const t of schema.telephone ?? []) addPhone(t)
  for (const e of schema.email ?? []) addEmail(e)
  for (const s of schema.sameAs ?? []) addSocial(s)

  return {
    emails: [...emails].slice(0, 8),
    phones: [...phones.values()].slice(0, 6),
    whatsapp: [...whatsapp].slice(0, 3),
    socials,
    address: schema.address ?? '',
    contactPage,
    contactForm,
    mapEmbed
  }
}

module.exports = { extractContacts, phoneKey, cfDecode }

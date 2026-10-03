# SEO Scout

Pick a business type and the cities, or leave both empty to look at any business near you. SEO Scout then:
- finds the businesses on Google Maps;
- works out **how each website is built**;
- runs a **deep SEO, AEO and GEO audit** (75+ checks) with real speed measurements;
- collects every business's **contacts**.

It works for any kind of business: dentists, hotels, restaurants, law firms, real estate agents, schools, car repair and so on. **No API keys and no AI are needed.**

## Use it

1. Plugins tab → **SEO Scout** → turn it on.
2. Settings: **business type**, **cities** and **country**. All three are optional. Empty means *any business, near you*: Google Maps uses its own estimate of where you are.
3. Click **Run now**, or type in chat: `seo scout dentists in Colombo and Kandy`.
4. For a daily report, turn on **Repeat automatically** and pick the time.

The card has three tabs:
- **Run** shows the tools, the live progress (steps appear as they happen) and the latest result.
- **History** lists every run.
- **Settings** holds the plugin's settings.

Every run is kept under **History**:
- **Open report** shows the full report in your browser, with tables you can sort by clicking a column.
- **Files** opens the CSVs.
- **Export** saves the whole run as a .zip.

## Where the businesses come from

| Source | Key? | What it gives |
|---|---|---|
| **Google Maps**, read in a private Isla browser window | No | Name, website, phone, address, category, Google rating and review count. Tick *Show the browser while it works* to watch. |
| Your list (*Always check these sites*) | No | `URL \| City \| Name`, one per line. |
| AI web research | No (uses your AI agent) | Optional. |
| Google Places API + Lighthouse | Google API key | Optional. These are the official APIs: more reliable at large volume, and they add Google Lighthouse scores. |
| Brave Search API | Brave key | Optional. Adds web-search discovery, and finds websites for map listings that have none (only accepted when the domain matches the business name). |

Everything is merged per website, and per name and city for businesses without one. Businesses **without a website** get their own list. They're often the easiest leads.

> Reading Google Maps in a browser is meant for your own research at a human pace. Isla scrolls the list and only opens a place page when a card has no phone number. For large or frequent runs, Google's terms favour the official Places API, which is the optional key.

## How each website is built

| Category | Platforms detected |
|---|---|
| E-commerce platform | Shopify, WooCommerce, Magento, BigCommerce, PrestaShop, OpenCart |
| CMS | WordPress, Statamic (Laravel), HubSpot CMS, Joomla, Drupal, Ghost |
| Website builder | Wix, Squarespace, Webflow, GoDaddy, Duda, Weebly/Square, Google Sites, Framer |
| JavaScript framework | Next.js, Nuxt, Gatsby, Astro, SvelteKit, Angular, React, Vue |
| Custom code | Laravel, CodeIgniter, Ruby on Rails, Django, ASP.NET, PHP |

It also notes the hosting and CDN (Cloudflare, Vercel, Netlify, CloudFront, WP Engine, Kinsta, LiteSpeed, nginx, Apache, IIS) and add-ons (Elementor, Divi, Yoast, Rank Math, Google Tag Manager, Meta Pixel…).

## What it checks

SEO Scout crawls up to 8 pages per site (home, contact, about, services, FAQ, team, blog…). Every check records **what was actually found** and **how to fix it**.

- **Technical SEO:** HTTPS, the http→https 301 redirect, HSTS, indexability, Google/Bing access in robots.txt, the sitemap (number of URLs, last updated), canonical link, real 404s, broken pages, compression, server response time, HTML size, render-blocking scripts, mixed content.
- **On-page SEO:** title and description lengths on every page and duplicates, H1/H2 structure, amount of text, thin pages, image alt text, WebP/AVIF images, lazy loading, internal links, mobile viewport, language, Open Graph, X card, favicon.
- **Local SEO:** city in title/H1/description, phone on the site, click-to-call, **the phone matches the Google Maps listing (NAP)**, address, embedded map, contact page or form, Google rating and reviews.
- **Speed:** each site is loaded fresh at phone size in Isla's browser, one at a time so timings aren't skewed. It measures Largest Contentful Paint, Layout Shift, First Contentful Paint, full load time, page weight, number of requests and JavaScript size. With a Google key you also get Google Lighthouse and Chrome real-user data. *Measurements use your own connection, so a slow line makes every site look slower.*
- **AEO** (featured snippets, AI Overviews, voice): JSON-LD and whether it's valid, business schema and how complete it is, FAQPage schema, questions as headings, short direct answers, lists and tables, service/product schema, review schema, breadcrumbs, WebSite schema.
- **GEO** (ChatGPT, Claude, Perplexity, Gemini):
  - whether the AI search crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot…) or training crawlers are blocked
  - "noai" tags
  - **whether the content can be read without JavaScript**
  - llms.txt
  - depth of content, quotable facts, citations of authoritative sources
  - sameAs entity links, social profiles
  - about/team pages, named experts
  - freshness

Scores run from 0 to 100 for SEO, AEO, GEO and Speed. Overall is their average. **Hot lead** means under 45 and **warm** means under 65.

## Contacts collected

- Emails: `mailto:` links, plain text, "name [at] site [dot] com", and Cloudflare-protected addresses.
- Phone numbers: `tel:` links, structured data, international numbers in the text, and the Google Maps listing.
- WhatsApp, Facebook, Instagram, LinkedIn, X, YouTube and TikTok.
- Address, contact page and contact form.

These are only details the business publishes itself. If you contact them, follow your country's rules on marketing messages.

## What each run saves

Each run saves to `Documents\Agentic Island\Reports\SEO Scout\<date time>\`:

| File | What |
|---|---|
| `report.html` / `report.md` | Key findings, ranking (weakest first), platforms, categories, cities, most common problems, businesses without a website, and a full section per site |
| `sites.csv` | One row per website: platform, scores, contacts, speed, top fixes |
| `contacts.csv` | Every business found, with or without a website: emails, phones, WhatsApp, socials, rating, map links |
| `checks.csv` | Every check for every site: pass, fail or n/a, what was found, and the fix |
| `sites.json` | Everything, for your own tools |

Sites seen in an earlier run are remembered, so later reports mark 🆕 new businesses and show how each score changed.

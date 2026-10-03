# Isla plugins

A plugin is a small tool that plugs into Isla. You write it once, and anyone can drop it into their own Isla.

- It shows up in the **Plugins** tab, with Run now, a settings form and a daily or weekly schedule.
- It can be started from chat ("seo scout dentists in Colombo").
- It can use a private Isla browser window, the user's AI agent, web research, notifications and storage.
- It saves reports to `Documents\Agentic Island\Reports`. Isla turns each `report.md` into a `report.html` you can sort by column.
- Every run is kept in the plugin's **Run history** (up to 50 runs), with its summary, log and report. Each run can be opened, exported as a .zip or deleted.

```
plugins/
  isla-plugin.d.ts        ← types for plugin authors (autocomplete)
  seo-scout/              ← one folder per plugin
    isla-plugin.json      ← manifest: name, permissions, settings, tools
    index.js              ← code: exports tools
    discover.js, …        ← any other files you need
```

Folders in this `plugins/` directory ship with Isla as **built-in** plugins. They start turned off, and the user turns them on. Plugins someone installs go to `%APPDATA%\Agentic Island\plugins\<id>\`.

---

## 1. Write one (5 minutes)

**`my-plugin/isla-plugin.json`**
```json
{
  "id": "site-status",
  "name": "Site Status",
  "version": "1.0.0",
  "description": "Checks that my websites are up and tells me when one is down.",
  "author": "Your name",
  "main": "index.js",
  "permissions": ["notify", "network"],
  "settings": [
    { "key": "sites", "label": "Sites", "type": "textarea", "default": "https://example.com", "help": "One per line" }
  ],
  "tools": [
    {
      "id": "check",
      "title": "Check my sites",
      "chat": ["check my sites", "are my sites up"],
      "schedule": { "type": "interval", "everyMs": 3600000 }
    }
  ]
}
```

**`my-plugin/index.js`**
```js
// @ts-check
/** @typedef {import('../isla-plugin').PluginContext} Ctx */

module.exports = {
  tools: {
    /** @param {Ctx} ctx */
    async check(ctx) {
      const sites = String(ctx.settings.sites).split('\n').map(s => s.trim()).filter(Boolean)
      const down = []
      for (const url of sites) {
        try {
          const r = await ctx.http.get(url, { timeoutMs: 10000 })
          ctx.log(`${r.status} ${url} (${r.ms} ms)`)
          if (!r.ok) down.push(`${url} → HTTP ${r.status}`)
        } catch (e) {
          down.push(`${url} → ${e.message}`)
        }
      }
      if (down.length) await ctx.notify(`${down.length} site(s) down`, down[0])
      return { summary: down.length ? `**Down:**\n${down.map(d => `- ${d}`).join('\n')}` : `All ${sites.length} sites are up ✅` }
    }
  }
}
```

**Try it:** Plugins tab → **Install folder** → pick `my-plugin`. After you edit the code, install the folder again (that updates it), or edit the copy in the installed folder (📄 button) and press ⟳.

## 2. Share it

- Plugins tab → open your plugin → **Share .zip**. Send the .zip any way you like.
- The other person goes to Plugins tab → **Install .zip**. Isla shows them the name, author, description and permissions, and asks before installing.
- Or share the folder in a git repo. People clone it and use **Install folder**.

Raising `version` and sharing again lets people update. Their settings, schedule and storage are kept.

## 3. Reference

### isla-plugin.json

| Field | Required | Notes |
|---|---|---|
| `id` | ✔ | `lowercase-with-dashes`, unique. It's the install folder name. |
| `name`, `version`, `description` | ✔ | Shown on the card and in the install dialog. |
| `author`, `homepage` | | `homepage` must be `https://`. |
| `main` | | Entry file inside the folder, `.js` / `.cjs` / `.mjs`. Defaults to `index.js`. |
| `permissions` | ✔ | Any of `browser`, `network`, `ai`, `ai-web`, `notify` (see below). |
| `settings` | | Form fields: `{ key, label, type: text \| textarea \| number \| boolean \| select \| secret, default, help, options }`. `secret` is for API keys: it's stored encrypted (Windows DPAPI), shown masked, and never sent back to the UI. |
| `tools` | ✔ | At least one: `{ id, title, description, chat: [...phrases], schedule, timeoutMinutes }`. |

- `chat` phrases: if a chat message *contains* one, that tool runs, and the full message is passed in `ctx.input.text`. "run <plugin name>" also works.
- `schedule`: `{ "type": "daily", "hour": 9, "minute": 0 }`, `{ "type": "weekly", "weekday": 1, "hour": 9, "minute": 0 }` or `{ "type": "interval", "everyMs": 3600000 }` (15 min minimum). This is only a suggestion: it stays **off** until the user turns on *Repeat automatically*.
- `timeoutMinutes`: defaults to 15, max 120. The run is stopped after that.

### `ctx`, what your tool gets

| | Permission | |
|---|---|---|
| `ctx.input` | | `{ text, trigger: 'manual' \| 'chat' \| 'schedule' }` |
| `ctx.settings` | | The user's values for your `settings`, with defaults filled in. |
| `ctx.log(...)`, `console.log` | | Live log on the plugin card. |
| `ctx.progress(0..1, text?)` | | Progress bar. |
| `ctx.http.get(url, opts)` / `.post(url, body, opts)` | `network` | Returns `{ ok, status, url, headers, cookies, text, ms, ttfb }`. Options: `timeoutMs`, `maxBytes`, `headers`, `redirect: 'manual'`. |
| `ctx.browser.open(url, { width, height, fresh })` | `browser` | Loads a page in a **private** Isla browser window (its own profile, never the user's signed-in Isla browser). `fresh` clears the cache first. |
| `ctx.browser.eval(script)` | `browser` | Runs JavaScript in the page and returns its JSON result (promises are awaited). |
| `ctx.browser.show(true)` | `browser` | Lets the user watch. Otherwise the page renders offscreen, so it paints and reports real FCP/LCP. The window closes when the run ends. |
| `ctx.ai.ask(prompt, { system })` | `ai` | Cheap text-only call with the user's background model. No web access. Max 30 per run. |
| `ctx.ai.research(prompt, { title })` | `ai-web` | Read-only agent run **with web search**, shown in Isla's task list. Max 5 per run. |
| `ctx.notify(title, body)` | `notify` | Island peek. Max 3 per run. |
| `ctx.storage.get(key)` / `.set(key, value)` | | Your plugin's JSON storage, 1 MB, kept between runs. |
| `ctx.report.save({ title, markdown, files })` | | Writes `report.md` plus extra `.csv/.json/.md/.txt/.html` files. The card then shows **Open report**. |

Return a Markdown string or `{ summary }`. It's shown on the card, so keep it short and put the details in the report.

## 4. Safety: read this before installing someone else's plugin

- Every run gets **its own process**. A crash or a hang can't take Isla down. *Stop*, the time limit and the **kill switch** end it at once.
- Isla's own powers (browser window, AI agent, web research, notifications) only work if the manifest asks for them. The install dialog lists them, and the AI calls have per-run limits.
- The plugin browser has **its own profile**. It never sees the sites you signed in to in Isla's browser (Gmail and so on), it can't download files, and it can't open pop-ups.
- The plugin process gets **no Isla secrets**: no mail password, no API keys, no tokens, and a minimal environment.
- **But a plugin is still a program.** Like a VS Code extension, it can read files and reach the network like any other app you install. `network` is a label that tells users what the plugin does; it is not a sandbox. **Only install plugins from people you trust, and read the code.** It's plain JavaScript in the folder.

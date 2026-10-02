# Agentic Island

A macOS-style **Dynamic Island for Windows** with a proactive AI assistant inside. It sits on the edge of your screen as a small black pill with **Isla**, an animated face. Isla watches what you're doing, suggests the next step, and does it for you when you click, using the AI agents already installed on your PC (Claude Code, Codex, Gemini CLI, Antigravity). Security comes first: approvals, read-only by default, a kill switch, and an audit log.

---

## What it can do

### 🏝️ A Dynamic Island that lives on any screen edge
- A black pill **flush against the edge of the screen**, top-center by default. Hover or click it to open the full panel.
- **Drag it to any edge:** top, bottom, left or right. If you let go away from an edge, it **glides to the nearest edge** with a bouncy, macOS-style landing. On the left and right edges it becomes a vertical pill. The position is remembered.
- **Tuck it away:** the small arrow at the end of the pill (or in the panel header) hides Isla into a tiny arrow tab on the edge. Click the tab to bring it back.
- **Peeks:** when something happens (a code arrives, a task finishes, a suggestion is ready, your changes are ready to commit), the island briefly grows with a one-click button, then folds back after a few seconds. Isla's face matches the moment: happy for mail, surprised for errors, thinking for ideas.
- **Approvals pop out:** a task waiting for your OK appears right in the island with **[Approve] [Reject]** (👁 shows exactly what will be sent). If you miss it, the orange **Review** button on the pill brings it back.
- **✨ chip:** suggestions you didn't act on stay behind a small ✨ button on the pill. Click it to bring them back one by one.
- **Isla's face** reacts to everything: she sleeps when you're away, works while an agent runs, looks suspicious while a task waits for approval, gets excited when a code arrives, and **dances when music plays** 🎉.

### 🤖 Uses the AI agents already on your PC
| Agent | How Isla uses it |
| --- | --- |
| **Claude Code** | Runs tasks in the background. Also found automatically inside the VS Code extension. |
| **Codex CLI** | Runs tasks in the background, sandboxed. |
| **Gemini CLI** | Runs tasks in the background. You need to sign in once in a terminal first. |
| **Antigravity** | It's an IDE, so Isla opens your project in it and copies your prompt to the clipboard. |
| **Custom CLI** | Any command-line agent; the prompt is sent on stdin. |

Each agent has its own **model** (e.g. `claude-sonnet-5`, `claude-opus-5-5`, `haiku`) and **permission mode** (*Read-only* or *Can edit*), set in **Settings → Agents & models**.

### 💬 Ask anything: two modes
The Home box has two modes:
- **General:** everyday questions. It runs read-only in a private scratch folder, and web search is allowed.
- **Project:** coding tasks inside a folder you've allowed.

| You type | What happens |
| --- | --- |
| "hi", "thanks", "help" | Isla answers instantly: no AI, no tokens |
| "translate to English: …", "… convert to english", "translate into Sinhala: …" | Cheap translation (~1k tokens) with **Copy** / **Paste into app** |
| "summarize this", "reply to this", "what does this say" | Uses the text on your screen, cheaply |
| "read my last mail", "any unread emails?", "copy my code" | Answered locally from your inbox, no AI |
| A question ("what does this file do?", "explain this error") | Runs **immediately and read-only**. Pressing *Ask* is your approval. |
| A change request ("fix…", "add…", "refactor…") | Uses the agent's edit mode, and shows an **approval card** first |
| Anything that attaches your emails | Always asks first |

Answers appear right on Home, with **Copy answer**.

### 👁️ Reads your screen and helps proactively, on a small budget
1. Every ~20 seconds, and when you switch windows, Isla reads the window in front with **Windows' built-in OCR**. This runs on your PC, is free, and uses no tokens.
2. **Free local rules** turn what's on screen into suggestions:
   - an error on screen → *Explain & fix this error*
   - an email open in the browser → *Summarize this email* / *Draft a reply* (no inbox setup needed)
   - a long web page → *Summarize this page*
   - Word or a PDF → *Proofread*
   - **Teams / WhatsApp / Slack** (app or browser) → *Suggest a reply* to the latest message, in the same language
   - lots of non-English text (Sinhala, Tamil, Hindi…) → *Translate to English*

   These everyday text jobs run through the lean Haiku call, about 1k tokens (~/usr/bin/bash.003) each, not the full coding agent. The answer gets **Copy** and **Paste into WhatsApp/Teams/Gmail…**: Isla switches back to that app and pastes it into the box, and **you press Enter to send**. Isla never sends messages on its own.
3. When the screen stays still for a moment, a **cheap model** (Haiku by default) looks at a short, **redacted** text snippet and suggests one next step. The island pops up with **Do it**. Each check is about **1k tokens, roughly $0.003**, capped at **10 per hour** (you can change this).
4. It notices context from the window title:
   - on a sign-in page, it watches for your code
   - in Gmail or Outlook, it offers to summarize unread mail
   - in an IDE, it **follows that project's git automatically**

Password managers, banking and private/incognito windows are **never read**. Screenshots are **never sent to an AI**. Codes, API keys, card numbers and passwords are blanked out before any text reaches a model.

### 🌿 Version control, with one-click commit & push
- **Git tab:** branch, ahead/behind, staged/modified/new files, recent commits, and fetch / pull / push.
- **Auto-review:** when your edits stop changing for 45 s, Isla:
  1. scans the changes **locally for secrets** (API keys, private keys, `.env` files, hard-coded passwords),
  2. has a cheap model write a **commit message** and flag real problems (bugs, leftover debug code, TODOs),
  3. pops up **Commit & push** if everything looks good, or **Check before committing** with the issues listed.
- A commit is **refused if files changed after the review**, and **blocked if a secret is found** (overriding needs a confirmation and is logged).
- Other suggestions: pull when you're behind, push when you're ahead, explain merge conflicts.

### ✉️ Mail: right in your browser, with no setup
There's no inbox to connect and no Google sign-in. Isla works with the mail you already have open in the browser (Gmail, Outlook…):
- With an email on screen, Isla offers **Summarize this email** and **Draft a reply**. You can also type "summarize this email" or "draft a reply to this".
- The reply gets **Copy** and **Paste into Gmail/Outlook**: Isla pastes it into the reply box, and you press Send.
- When PC control is on, mail questions can also run in Isla's own browser with Gmail. You sign in there yourself the first time.

### 🎬 Screen recordings and meetings (summaries in Sinhala, Tamil, English…)
- **Record your screen any time:** **Recordings** tab → *Record…* opens a picker:
  - **Screens:** tick one or several. Several screens are recorded side by side in one video. With no screen ticked, it records sound only.
  - **Computer sound:** what you hear (people in a call, videos).
  - **Microphone:** your voice.

  You get a normal **MP4** (H.264 + AAC, 30 fps). Your choice is remembered and used for the tray menu → *● Record screen*, for typing "record screen", and for the meeting **Record** button. Plain screen recordings are *not* summarized; click **Transcribe & summarize** if you want that.
- **Isla stays out of the video:** while recording, Isla's own window is excluded from capture. You still see it on your screen, but it never appears in the recording.
- **Notices the meeting:** when Teams, Zoom, Webex, Slack, WhatsApp, Discord or a browser call (Google Meet) starts using your microphone, Isla pops up: *"Meeting started in Teams — record & summarize?"* **[Record] [Not now]**. Nothing is recorded without your click.
- **Meetings:** a recording made while a call app is using the mic counts as a meeting. Isla records the screen (MP4) plus one clean audio track with **your microphone and everyone else's voices** (Windows system audio). A red **● REC 12:34** chip with a stop button stays on the pill the whole time. Please let participants know you're recording.
- **When the call ends** (the app releases the mic), recording stops automatically, or you can click Stop. Isla then uses **Google Gemini** to make:
  - a **summary**, the **decisions** and the **action items** (owner and due date), in English or in the meeting's own language,
  - a full **transcript in the original language(s)**: Sinhala in Sinhala script, Tamil in Tamil script, English, or mixed.
- Everything is saved in **`Videos\Agentic Island\Meetings\<date> <app>\`**: `recording.mp4`, `audio.wav`, `transcript.txt` and `summary.md`. The **Recordings** tab lists them, with Play video, Show in folder, Copy summary, Transcribe & summarize and Delete.
- Type **"record this meeting"** / **"stop recording"** in the island any time.
- **Setup:** paste a **free Gemini API key** from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) in the Meetings tab. It's stored encrypted. Without a key, meetings are still recorded; click *Summarize* later.
- **Privacy:** the audio is uploaded to Gemini only to transcribe and summarize, and the uploaded copy is **deleted from Google right after**. The kill switch stops a recording at once and keeps the files local (no upload).

### 🎵 Now playing
Anything in the Windows media flyout works: **YouTube in Chrome/Edge/Firefox, Spotify, Media Player, VLC…**
- The pill shows **cover art, a scrolling title** (long titles slide like a car stereo), the artist and app, a little equalizer, and **⏮ ⏯ ⏭**.
- Home shows a big **Now Playing** card with a live progress bar.
- It uses Windows' own media controls: no tokens, nothing leaves the PC.

### 📊 AI usage
- **Rings in the pill** (always shown when idle, and next to the music while something plays): one double ring per AI.
  - **Outer ring = this week, inner ring = the 5-hour session or today**, with the time until reset in the middle.
  - A ring turns yellow above 75% and red above 90%. Hover for exact numbers.
- **Claude:** your **real plan usage**, the same numbers as Claude's `/usage` screen (session and weekly), read with Claude Code's existing sign-in.
- **Codex:** its real rate limits, from its local logs.
- **Usage tab:**
  - tokens per model for today and the last 7 days, from local Claude Code / Codex / Antigravity logs
  - Isla's own background-check cost
  - **every AI app running on the PC** (Claude, Codex, Gemini, Antigravity, Cursor, Windsurf, Ollama, LM Studio, ChatGPT…) with live CPU and RAM

### 🛡️ Security and control
- **Kill switch:** the red button, the tray menu, or **Ctrl+Alt+Shift+K**. It instantly stops every agent, the screen reader, git, mail and media watchers, and wipes codes from memory and the clipboard. Everything stays paused until you click **Resume**.
- **Shut down:** closes Isla completely (Security tab or tray).
- **Audit log:** every task, approval, commit, git action and security event, viewable in the Security tab.

---

## Install

1. Run **`release\AgenticIsland-Setup-0.1.0.exe`**. It isn't code-signed, so if Windows SmartScreen warns you, click **More info → Run anyway**.
2. Isla appears at the top of your screen, and a tray icon is added. Optional: tray → *Launch at Windows login*.

### First-time setup (2 minutes)
1. **Settings → Agents & models:** pick your default agent and model. At least one *background* agent (Claude Code, Codex or Gemini CLI) is needed for AI answers.
   - Claude Code not signed in? Run `claude` in a terminal and use `/login`.
   - Gemini CLI not signed in? Run `gemini` once and choose *Login with Google*.
2. **Settings → Workspaces → Add folder:** allow your project folders. Agents and git actions only ever run inside these.

### Using the island
| Action | How |
| --- | --- |
| Open the panel | Hover the pill, or click it (click only while media is showing) |
| Keep it open | 📌 pin button in the header |
| Move it | Drag the pill (or the panel header) and let go near any edge |
| Tuck it away | ^ arrow at the end of the pill, or in the header |
| Bring it back | Click the arrow tab on the edge |
| Show / tuck | `Ctrl+Alt+Space` |
| **Kill switch** | `Ctrl+Alt+Shift+K`, the red ■ button, or the tray menu |

### Settings → General (main switches)
| Setting | Default | What it does |
| --- | --- | --- |
| Assistant for everyday questions | Automatic | Which agent answers General questions |
| Now playing | On | Media info and controls in the island |
| Read my screen | On | On-device OCR of the window in front |
| AI next-step ideas | On | Cheap model suggests one step from the screen |
| Max background AI checks per hour | 10 | Hard budget for screen ideas and commit reviews |
| Background model | `haiku` | Model for those cheap checks |
| Review changes → Commit & push | On | Auto-review and one-click commit |
| Real Claude plan usage | On | Real session/weekly rings for Claude |
| Usage ring limits | 0 = auto | Your own token limits for estimated rings |
| Notice what I'm doing | On | Uses window titles (locally) for context |
| New mail alerts | On | Peek when new mail arrives |
| Skip approval for simple General questions | Off | Lets suggested read-only questions skip the card |
| Ask permission for web operations | On | Always shows approval card before web access |
| App permissions | All allowed | Control which apps Isla can screen-read |
| Proactive suggestions | On / Off | Git, screen and inbox suggestions |

---

## Security model

| Protection | How |
| --- | --- |
| **Approval** | Change requests, edit-mode tasks and anything with your emails show an approval card with the exact prompt, agent, model, mode and folder. Typing a read-only question and pressing *Ask*, or clicking **Do it**, counts as your approval. |
| **Read-only by default** | Claude Code runs with `--restricted`, which ignores your personal allow rules: only Read/Grep/Glob and read-only git commands are allowed. Writes, network tools and `git push` are denied. Codex uses `--sandbox read-only`. |
| **Workspace allowlist** | Project tasks and git actions only run inside folders you added. General questions run in a private scratch folder. |
| **No shell injection** | Prompts are sent to the CLI on **stdin**, never as command-line arguments. |
| **Private data never meets the web** | Tasks that include your emails or screen text run with web access turned off, to prevent prompt-injection leaks. |
| **Redaction** | Codes, API keys, tokens, card numbers and passwords are blanked out before any text reaches a model. |
| **Screen privacy** | OCR happens on your PC. Password managers, banking and private windows are skipped. Screenshots are never uploaded, and are deleted by the kill switch and on quit. |
| **Secrets at rest** | The IMAP password and the Google sign-in key are encrypted with Windows DPAPI (`safeStorage`) and never reach the UI. |
| **Google sign-in** | The official desktop OAuth flow (system browser, PKCE, one-time loopback on 127.0.0.1), with **read-only** Gmail scope only. Sign out revokes the token at Google. |
| **Claude plan usage** | Claude Code's local sign-in is read only to ask `api.anthropic.com` for *your own* usage. It's never stored or logged by Isla, and can be switched off. |
| **Commits** | A local secret scan blocks risky commits. A commit is refused if files changed after the review. |
| **App hardening** | Sandboxed renderer, context isolation, strict CSP, IPC sender checks, no navigation or pop-ups, all web permissions denied. |
| **Audit** | `%APPDATA%\Agentic Island\audit.log`. It never stores code values, passwords or window titles. |

---

## Known limits
- **Antigravity usage rings** are shown only when real token logs are found in `~/.gemini/` or Antigravity's AppData. If no parseable logs exist, no ring is shown (no estimation). Antigravity shows its own quota in its settings.
- **Gemini CLI** keeps no local token logs, so only its running processes appear in the Usage tab.
- Estimated rings (Claude with *Real plan usage* off, or Codex without reported limits) compare against your own history or the limits you set, not your actual plan.
- Not yet tested: multiple monitors, a taskbar placed at the top or side, and pushing to a real remote on first use (Git may show its own sign-in window).

---

## Develop

```bash
npm install
npm run dev        # hot-reload
npm run typecheck
npm run dist       # builds release/AgenticIsland-Setup-<version>.exe
```

> If Electron starts as plain Node from a VS Code terminal, clear `ELECTRON_RUN_AS_NODE` first.

### Project layout
| Path | What |
| --- | --- |
| `src/main/index.ts` | App lifecycle, window, docking/drag, tray, kill switch, IPC |
| `src/main/agents.ts` | Agent detection, task runs, lean background calls |
| `src/main/insight.ts` | Proactive engine: screen rules, AI next-step, commit review, budget |
| `src/main/screen.ts` | Window capture + Windows OCR |
| `src/main/context.ts` | Foreground-window awareness |
| `src/main/media.ts` | Now playing and media controls (Windows media session) |
| `src/main/git.ts` | Git status, secret scan, commit & push |
| `src/main/mail.ts` | IMAP inbox, reader, verification codes, redaction |
| `src/main/google.ts` | Gmail API sign-in (kept in the code, not shown in the UI) |
| `src/main/mailhub.ts` | Picks Gmail or IMAP for the rest of the app |
| `src/main/usage.ts` | Token usage, plan limits, AI processes |
| `src/main/store.ts` | Settings, DPAPI secrets, audit log |
| `src/renderer/` | React UI: island shell, panels, rings, media, avatar |
| `src/shared/types.ts` | Types shared by main, preload and renderer |

### The avatar
`src/renderer/avatar/` is a procedural avatar with the same API as `@bible-strong/avatar-react`: `createAvatar(json)`, the `animation`/`expression` props, and a ref with `play`/`pause`/`stop`/`setExpression`/`getState`. Its moods live in `isla.avatar.json`. When that package is published, swap the import in `avatar/index.ts`.

| App state | Isla's animation |
| --- | --- |
| Kill switch / away for 20 min | sleeping (then *waking* when you return) |
| Task awaiting approval | suspicious |
| Agent running | working / thinking |
| Typing | listening |
| Music playing | **dancing** |
| Code arrived / new mail | excited / happy |
| Task finished / failed | success / error |
| Merge conflicts | confused |
| Security alert | alert |

---

## License

Copyright © 2026 **FiveNeurals**. All rights reserved.

Agentic Island, including the Isla avatar, is proprietary software owned by FiveNeurals. See [LICENSE](LICENSE). Open-source components it uses (Electron, React and others) stay under their own licenses.

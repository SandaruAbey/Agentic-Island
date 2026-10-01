import { randomUUID } from 'node:crypto'

export interface ScheduledReminder {
  id: string
  kind: 'meeting' | 'alarm' | 'reminder'
  title: string
  url?: string
  targetAt: number
  createdAt: number
  timer?: NodeJS.Timeout
}

export interface ParsedReminderIntent {
  action: 'set' | 'list' | 'clear'
  kind?: 'meeting' | 'alarm' | 'reminder'
  title?: string
  url?: string
  targetAt?: number
  durationMs?: number
}

const URL_REGEX = /(https?:\/\/[^\s]+|(?:meet\.google\.com|zoom\.us\/j\/\d+|teams\.microsoft\.com\/[^\s]+)[^\s]*)/i

const REL_TIME_REGEX = /\b(?:in|for|after)?\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/i

/** Matches 8.35pm, 8:35pm, 8.35 pm, 8:35, 8pm, 8 pm, at 8, etc. */
const ABS_TIME_REGEX = /\b(?:at\s+)?(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)\b|\b(?:at)\s+(\d{1,2})(?:[.:](\d{2}))?\b/i

/** Parse natural language text for meetings, alarms, and reminders. */
export function parseReminderIntent(text: string): ParsedReminderIntent | null {
  const t = text.trim()
  const lower = t.toLowerCase()

  // 1. Check for list commands: "show reminders", "what meetings do i have", "list alarms"
  if (
    /^(show|list|what|any|get)\b.*\b(reminders?|alarms?|meetings?)\b/i.test(lower) ||
    /^(my\s+)?(reminders?|alarms?|meetings?)$/i.test(lower)
  ) {
    return { action: 'list' }
  }

  // 2. Check for cancel/clear commands: "cancel alarm", "clear reminders", "delete meeting"
  if (/^(cancel|clear|delete|remove|stop)\b.*\b(reminders?|alarms?|meetings?|all)\b/i.test(lower)) {
    return { action: 'clear' }
  }

  // 3. Must have a reminder/alarm/meeting keyword or a time phrase
  const isMeeting = /\b(meet|meeting|sync|call|standup|interview)\b/i.test(lower)
  const isAlarm = /\b(alarm)\b/i.test(lower)
  const isReminder = /\b(remind|reminder|schedule)\b/i.test(lower)

  if (!isMeeting && !isAlarm && !isReminder) {
    return null
  }

  // Extract URL or well-known meeting platform
  let url: string | undefined
  const urlMatch = t.match(URL_REGEX)
  if (urlMatch) {
    let rawUrl = urlMatch[1]
    if (!/^https?:\/\//i.test(rawUrl)) {
      rawUrl = `https://${rawUrl}`
    }
    url = rawUrl
  } else if (/\b(google\s*meet|gmeet)\b/i.test(lower)) {
    url = 'https://meet.google.com'
  } else if (/\b(zoom)\b/i.test(lower)) {
    url = 'https://zoom.us'
  } else if (/\b(teams|microsoft\s*teams)\b/i.test(lower)) {
    url = 'https://teams.microsoft.com'
  }

  // Determine kind
  const kind: 'meeting' | 'alarm' | 'reminder' = isMeeting ? 'meeting' : isAlarm ? 'alarm' : 'reminder'

  let targetAt: number | undefined
  let durationMs: number | undefined

  // Check absolute time first (e.g. 8.35pm, 8:35pm, 8pm, at 8:30)
  const absMatch = lower.match(ABS_TIME_REGEX)
  if (absMatch) {
    const isFirstForm = !!absMatch[1]
    let hours = parseInt(isFirstForm ? absMatch[1] : absMatch[4], 10)
    const minutes = parseInt(isFirstForm ? (absMatch[2] ?? '0') : (absMatch[5] ?? '0'), 10)
    const ampm = isFirstForm && absMatch[3] ? absMatch[3].toLowerCase() : null

    if (ampm === 'pm' && hours < 12) hours += 12
    else if (ampm === 'am' && hours === 12) hours = 0
    else if (!ampm && hours < 12) {
      const curH = new Date().getHours()
      if (curH >= hours && hours + 12 < 24) hours += 12
    }

    const target = new Date()
    target.setHours(hours, minutes, 0, 0)
    // If user says "tomorrow"
    if (/\btomorrow\b/i.test(lower)) {
      target.setDate(target.getDate() + 1)
    } else if (target.getTime() <= Date.now()) {
      // If time has already passed today and user didn't explicitly say "today", assume tomorrow
      if (!/\btoday|tonight\b/i.test(lower)) {
        target.setDate(target.getDate() + 1)
      }
    }

    targetAt = target.getTime()
    durationMs = targetAt - Date.now()
  } else {
    // Check relative time (e.g. in 10 min, for 15 mins, 5m from now)
    const relMatch = lower.match(REL_TIME_REGEX)
    if (relMatch) {
      const val = parseFloat(relMatch[1])
      const unit = relMatch[2].toLowerCase()
      let multiplier = 60 * 1000
      if (unit.startsWith('s')) multiplier = 1000
      else if (unit.startsWith('m')) multiplier = 60 * 1000
      else if (unit.startsWith('h')) multiplier = 3600 * 1000

      durationMs = Math.round(val * multiplier)
      targetAt = Date.now() + durationMs
    }
  }

  if (!targetAt || !durationMs) {
    return null
  }

  // Clean title
  let title = t
  if (urlMatch) title = title.replace(urlMatch[0], '')
  title = title
    .replace(ABS_TIME_REGEX, '')
    .replace(REL_TIME_REGEX, '')
    .replace(/\b(i have (a )?meeting|set (an? )?alarm|set (a )?reminder|remind me (to )?|save it|with that related site url|give popup reminder|with link|link[:=]?|at|in|for|today|tonight|tomorrow)\b/gi, '')
    .replace(/[.,!?;:]+/g, ' ')
    .trim()

  if (!title || title.length < 2) {
    title = kind === 'meeting' ? (url ? 'Meeting (with link)' : 'Meeting') : kind === 'alarm' ? 'Alarm' : 'Reminder'
  }

  return {
    action: 'set',
    kind,
    title,
    url,
    targetAt,
    durationMs
  }
}

/** Fallback AI tool parser for complex natural language requests */
export async function parseReminderWithAi(
  text: string,
  quickAsk: (sys: string, prompt: string, model: string) => Promise<{ text: string }>,
  model: string
): Promise<ParsedReminderIntent | null> {
  const lower = text.toLowerCase()
  if (!/\b(meet|meeting|alarm|remind|reminder|schedule|sync|call)\b/i.test(lower)) {
    return null
  }

  const sys =
    'You are a tool parsing engine. Parse the user request into a reminder/meeting/alarm action. ' +
    `Current local time: ${new Date().toLocaleString()}. ` +
    'Reply with compact JSON only: ' +
    '{"isReminder": true|false, "action": "set"|"list"|"clear", "kind": "meeting"|"alarm"|"reminder", "title": "short title", "targetMinutesFromNow": number, "url": "URL or empty"}'

  try {
    const res = await quickAsk(sys, text, model)
    const m = res.text.match(/\{[\s\S]*\}/)
    if (!m) return null
    const j = JSON.parse(m[0])
    if (!j.isReminder) return null
    if (j.action === 'list' || j.action === 'clear') return { action: j.action }

    const mins = typeof j.targetMinutesFromNow === 'number' ? j.targetMinutesFromNow : 5
    const durationMs = Math.max(10_000, Math.round(mins * 60 * 1000))
    const targetAt = Date.now() + durationMs

    let url: string | undefined = typeof j.url === 'string' && j.url.trim() ? j.url.trim() : undefined
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`
    if (!url && /\b(google\s*meet|gmeet)\b/i.test(lower)) url = 'https://meet.google.com'

    return {
      action: 'set',
      kind: j.kind === 'meeting' || j.kind === 'alarm' ? j.kind : 'reminder',
      title: typeof j.title === 'string' && j.title.trim() ? j.title.trim() : 'Scheduled event',
      url,
      targetAt,
      durationMs
    }
  } catch {
    return null
  }
}

/** Check agent output for structured tool tag: [TOOL:REMINDER kind="meeting" title="..." at="..." url="..."] */
export function parseToolTag(output: string): ParsedReminderIntent | null {
  const m = output.match(/\[TOOL:REMINDER\s+([^\]]+)\]/i)
  if (!m) return null
  const attrStr = m[1]

  const getAttr = (name: string): string => {
    const r = new RegExp(`${name}="([^"]*)"`, 'i')
    const match = attrStr.match(r)
    return match ? match[1].trim() : ''
  }

  const kind = (getAttr('kind') || 'reminder').toLowerCase() as 'meeting' | 'alarm' | 'reminder'
  const title = getAttr('title') || 'Scheduled event'
  const at = getAttr('at')
  const url = getAttr('url') || undefined

  if (!at) return null
  // Parse 'at' time
  const parsed = parseReminderIntent(`set ${kind} ${title} ${at} ${url ?? ''}`)
  return parsed
}

export function formatTimeStr(timestamp: number): string {
  const d = new Date(timestamp)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function formatDurationStr(ms: number): string {
  const totalSecs = Math.max(0, Math.round(ms / 1000))
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60

  if (hours > 0) {
    return `${hours}h ${remMins > 0 ? `${remMins}m` : ''}`.trim()
  }
  if (mins > 0) {
    return `${mins}m ${secs > 0 && mins < 5 ? `${secs}s` : ''}`.trim()
  }
  return `${secs}s`
}

export class ReminderManager {
  private items: ScheduledReminder[] = []

  constructor(private onTrigger: (reminder: ScheduledReminder) => void) {}

  add(kind: ScheduledReminder['kind'], title: string, targetAt: number, url?: string): ScheduledReminder {
    const id = randomUUID()
    const now = Date.now()
    const delay = Math.max(1000, targetAt - now)

    const reminder: ScheduledReminder = {
      id,
      kind,
      title,
      url,
      targetAt,
      createdAt: now
    }

    reminder.timer = setTimeout(() => {
      this.remove(id)
      this.onTrigger(reminder)
    }, delay)

    this.items.push(reminder)
    return reminder
  }

  list(): ScheduledReminder[] {
    return [...this.items].sort((a, b) => a.targetAt - b.targetAt)
  }

  remove(id: string): boolean {
    const idx = this.items.findIndex(x => x.id === id)
    if (idx === -1) return false
    const item = this.items[idx]
    if (item.timer) clearTimeout(item.timer)
    this.items.splice(idx, 1)
    return true
  }

  clear(): void {
    for (const item of this.items) {
      if (item.timer) clearTimeout(item.timer)
    }
    this.items = []
  }
}

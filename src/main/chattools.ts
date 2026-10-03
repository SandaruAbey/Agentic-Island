import type { MeetingRecord, ScheduledTask } from '@shared/types'
import { describeRecurrence } from './scheduler'

/**
 * Chat → Isla's own tools. Things Isla can do itself (recordings, scheduled tasks, commit review) are done directly
 * when you ask for them in chat — no agent, no approval prompt, no tokens. Common phrases are matched locally;
 * anything fuzzier about recordings / tasks goes through one tiny classification call.
 */

export interface ChatToolDeps {
  recorder: {
    state: { phase: string; app: string }
    list: MeetingRecord[]
    record(): Promise<{ ok: boolean; message: string }>
    stop(reason: string): Promise<void>
    process(id: string, requested: boolean): Promise<void>
    open(id: string): void
    play(id: string): void
  }
  tasks: {
    list(): ScheduledTask[]
    toggle(id: string, enabled: boolean): void
    delete(id: string): void
  }
  reviewChanges: () => Promise<{ message: string; ok: boolean; issues: string[]; files: string[] } | null>
  ask: (system: string, prompt: string) => Promise<string>
  audit: (kind: string, detail: string) => void
}

type Tool =
  | { tool: 'record_start' | 'record_stop' | 'record_status' | 'recordings_list' | 'recording_open' | 'recording_play' | 'recording_summarize' | 'recording_summary' }
  | { tool: 'task_list' }
  | { tool: 'task_pause' | 'task_resume' | 'task_delete'; name: string }
  | { tool: 'commit_review' }

const POLITE = /^(hey |hi |ok(ay)? |isla[,:]? |please |pls |can you |could you |would you |will you |i want you to |i want to |let'?s |just |now )+/i
const THE = '(?:the |this |my |a |an |that )*'

/** Local phrase matching — returns null when the message isn't one of Isla's own commands. */
/** Common typos of "recording" ("recoding", "recrding", …) so a slip doesn't send the request to an agent. */
const TYPO = /\b(recoding|recrding|recroding|reocrding|recordng|recordin|recoring|recod|recrod|reccord(ing)?|recorging)\b/g

export function matchTool(raw: string): Tool | null {
  const t = raw
    .replace(TYPO, 'recording')
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(POLITE, '')
    .replace(/\s+(please|pls|now|for me)$/g, '')
    .trim()
  if (!t || t.length > 90) return null

  if (new RegExp(`^(?:start |begin |turn on )?${THE}(?:screen |meeting |call |video )*record(?:ing)?(?: ${THE}(?:meeting|call|screen|session|video|everything))?$`).test(t)) return { tool: 'record_start' }
  if (/^(start|begin)( a| the)? (screen |meeting |call )?record/.test(t)) return { tool: 'record_start' }
  if (/^record (this|the|my|our|a) (\w+ )?(meeting|call|screen|session|video|everything)$/.test(t)) return { tool: 'record_start' }
  if (new RegExp(`^(?:stop|end|finish|turn off|cancel) ${THE}(?:screen |meeting |call |video )*record(?:ing)?(?: ${THE}(?:meeting|call|screen|session|video))?$`).test(t)) return { tool: 'record_stop' }
  if (/^(is|are) (it|isla|you|we|this) (still )?recording\b|^recording status$/.test(t)) return { tool: 'record_status' }
  if (/^(show|list|what are|what'?s|open|see)( me)? (all )?(my |the )?(recordings|recorded meetings|past meetings|meeting recordings)$/.test(t)) return { tool: 'recordings_list' }
  if (/^(open|show) (the |my )?(last|latest|previous|recent) (recording|meeting)( folder)?$/.test(t)) return { tool: 'recording_open' }
  if (/^(play|watch) (the |my )?(last|latest|previous|recent) (recording|meeting|video)$/.test(t)) return { tool: 'recording_play' }
  if (/^(summari[sz]e|transcribe) (the |my )?(last|latest|previous|recent) (recording|meeting|call)$/.test(t)) return { tool: 'recording_summarize' }
  if (/^(what happened in|what was|show( me)?|give me) (the |my )?(last|latest|previous|recent) (meeting|call)( summary)?$|^(last|latest) meeting summary$/.test(t)) return { tool: 'recording_summary' }

  if (/^(show|list|what are|what'?s|see|open)( me)? (all )?(my |the )?(scheduled |recurring |repeating )?(tasks|scheduled tasks|schedules|schedule)$/.test(t)) return { tool: 'task_list' }
  const named = t.match(/^(pause|stop|disable|turn off|resume|enable|start|turn on|delete|remove|cancel)(?: all)? ?(?:the |my )?(.*?) (?:scheduled )?task$/)
  if (named) {
    const verb = named[1]
    const tool = /^(pause|stop|disable|turn off)$/.test(verb) ? 'task_pause' : /^(resume|enable|start|turn on)$/.test(verb) ? 'task_resume' : 'task_delete'
    return { tool, name: named[2].replace(/^(scheduled|the|my)\s+/, '').trim() }
  }
  if (/^(review|check) (my |the )?(changes|code changes|commit)$|^(is it|are my changes) ok(ay)? to commit$/.test(t)) return { tool: 'commit_review' }
  return null
}

const FUZZY = /\b(record(ing|ings|ed)?|scheduled? tasks?|my tasks|recurring)\b/i

const CLASSIFY_SYSTEM = `You route a chat message to one of Isla's built-in tools. Reply with compact JSON only: {"tool":"...","name":"..."} or {"tool":"none"}.
Tools: record_start (start recording the screen/meeting), record_stop, record_status (is it recording?), recordings_list, recording_open (open the latest recording's folder), recording_play (play the latest recording), recording_summarize (transcribe+summarize the latest recording), recording_summary (read the latest meeting's summary), task_list (list scheduled tasks), task_pause / task_resume / task_delete (need "name": words from the task's title), commit_review.
Use {"tool":"none"} when the message is a question or request that is not clearly asking Isla to use one of these tools (for example asking how recording works, or a task unrelated to scheduling).`

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}

export async function runChatTool(text: string, d: ChatToolDeps): Promise<string | null> {
  let call = matchTool(text)
  if (!call && FUZZY.test(text) && text.length <= 160) {
    try {
      const r = await d.ask(CLASSIFY_SYSTEM, text)
      const m = r.match(/\{[\s\S]*\}/)
      const j = m ? JSON.parse(m[0]) : null
      if (j && typeof j.tool === 'string' && j.tool !== 'none') call = { tool: j.tool, name: String(j.name ?? '') } as Tool
    } catch {
      /* classifier unavailable — fall through to the normal chat path */
    }
  }
  if (!call) return null
  d.audit('chat.tool', call.tool)
  const rec = d.recorder
  const latest = rec.list[0]

  switch (call.tool) {
    case 'record_start': {
      const r = await rec.record()
      return r.ok ? `${r.message} Say “stop recording” when you’re done.` : r.message
    }
    case 'record_stop':
      if (rec.state.phase !== 'recording') return 'Nothing is being recorded.'
      void rec.stop('Stopped by you')
      return 'Stopped. Saving the recording — I’ll pop up when it’s ready.'
    case 'record_status':
      return rec.state.phase === 'recording' ? `Yes — recording${rec.state.app ? ` (${rec.state.app})` : ''}.` : 'No, nothing is being recorded right now.'
    case 'recordings_list': {
      if (!rec.list.length) return 'No recordings yet. Say “record this meeting” to start one.'
      return `Your latest recordings:\n${rec.list
        .slice(0, 6)
        .map(m => `• [${m.kind === 'meeting' ? 'Meeting' : 'Screen'}] **${clip(m.title, 50)}** — ${ago(m.startedAt)}${m.status === 'done' ? ' · summarized' : ''}`)
        .join('\n')}\n\nOpen the Recordings tab to play or summarize them.`
    }
    case 'recording_open':
      if (!latest) return 'No recordings yet.'
      rec.open(latest.id)
      return `Opened the folder of “${clip(latest.title, 50)}”.`
    case 'recording_play':
      if (!latest) return 'No recordings yet.'
      rec.play(latest.id)
      return `Playing “${clip(latest.title, 50)}”.`
    case 'recording_summarize':
      if (!latest) return 'No recordings yet.'
      if (latest.status === 'done') return `“${clip(latest.title, 50)}” is already summarized — say “last meeting summary”.`
      void rec.process(latest.id, true)
      return `Transcribing and summarizing “${clip(latest.title, 50)}” — I’ll pop up when it’s ready.`
    case 'recording_summary': {
      if (!latest) return 'No recordings yet.'
      if (latest.status !== 'done') return `“${clip(latest.title, 50)}” isn’t summarized yet. Say “summarize the last recording” and I’ll do it.`
      const items = latest.actionItems.slice(0, 5).map(a => `• ${a.task}`)
      return `**${latest.title}** (${ago(latest.startedAt)})\n${latest.summary.map(s => `• ${s}`).join('\n')}${items.length ? `\n\n**To do**\n${items.join('\n')}` : ''}`
    }
    case 'task_list': {
      const tasks = d.tasks.list()
      if (!tasks.length) return 'No scheduled tasks. Try: “every morning at 9 search AI news and summarize it”.'
      return `Scheduled tasks:\n${tasks.map(t => `• [${t.enabled ? 'Active' : 'Paused'}] **${clip(t.title, 50)}** — ${describeRecurrence(t.recurrence)}`).join('\n')}`
    }
    case 'task_pause':
    case 'task_resume':
    case 'task_delete': {
      const tasks = d.tasks.list()
      const words = call.name.toLowerCase().split(/\s+/).filter(w => w.length > 1 && !/^(all|every|the|my)$/.test(w))
      const hits = words.length ? tasks.filter(t => words.every(w => t.title.toLowerCase().includes(w))) : tasks
      if (!tasks.length) return 'You have no scheduled tasks.'
      if (!hits.length) return `I couldn’t find a task matching “${call.name}”. Say “show my tasks” to see them.`
      if (call.tool === 'task_delete' && hits.length > 1) return `That matches ${hits.length} tasks — tell me which one:\n${hits.map(t => `• ${t.title}`).join('\n')}`
      for (const t of hits) {
        if (call.tool === 'task_delete') d.tasks.delete(t.id)
        else d.tasks.toggle(t.id, call.tool === 'task_resume')
      }
      const names = hits.map(t => `“${clip(t.title, 40)}”`).join(', ')
      return call.tool === 'task_delete' ? `Deleted ${names}.` : call.tool === 'task_pause' ? `Paused ${names}.` : `Resumed ${names}.`
    }
    case 'commit_review': {
      const p = await d.reviewChanges()
      if (!p) return 'No uncommitted changes to review (or no project is selected).'
      return `${p.ok ? 'Looks good' : 'Check before committing'} — ${p.files.length} file(s)\nSuggested message: \`${p.message}\`${p.issues.length ? `\n${p.issues.map(i => `• ${i}`).join('\n')}` : ''}\n\nUse the Commit & push button on the pill when you’re ready.`
    }
  }
  return null
}

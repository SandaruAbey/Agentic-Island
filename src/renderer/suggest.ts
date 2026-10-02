import type { AgentRun, AskResult, IslandSnapshot, PanelId, Suggestion } from '@shared/types'
import type { IslaAnimation } from './avatar'

export type Outcome =
  | { kind: 'run'; run: AgentRun }
  | { kind: 'ask'; result: AskResult }
  | { kind: 'panel'; panel: PanelId }
  | { kind: 'info'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'none' }

/** Button label for a suggestion's main action. */
export function actionLabel(s: Suggestion): string {
  const a = s.action
  switch (a.type) {
    case 'do':
      if (a.askUser) return 'Ask Isla'
      return s.icon === 'chat' ? 'Write reply' : s.icon === 'translate' ? 'Translate' : s.icon === 'mail' ? (/repl/i.test(s.title) ? 'Draft reply' : 'Summarize') : 'Do it'
    case 'commit':
      return a.push ? 'Commit & push' : 'Commit'
    case 'git':
      return a.op[0].toUpperCase() + a.op.slice(1)
    case 'copy-otp':
      return 'Copy'
    case 'add-workspace':
      return 'Follow'
    case 'ask':
      return 'Ask'
    case 'run':
      return 'Run'
    default:
      return 'Open'
  }
}

/** Isla's face for each kind of suggestion. */
export const SUGGEST_FACE: Record<Suggestion['icon'], IslaAnimation> = {
  mail: 'happy',
  chat: 'excited',
  translate: 'listening',
  warn: 'surprised',
  conflict: 'confused',
  commit: 'excited',
  push: 'happy',
  pull: 'happy',
  key: 'excited',
  spark: 'thinking',
  review: 'searching',
  eye: 'searching',
  folder: 'surprised'
}

/** Run a suggestion's action. Shared by the island peek, the ✨ button and Home. */
/** `request`: what the user typed for suggestions that ask first ("Need help with this page?"). */
export async function actOn(s: Suggestion, snap: IslandSnapshot, request?: string): Promise<Outcome> {
  const a = s.action
  try {
    switch (a.type) {
      case 'do':
        return { kind: 'run', run: await window.island.doSuggestion(s.id, request) }
      case 'run':
        return { kind: 'run', run: await window.island.requestRun(a.request) }
      case 'ask':
        return { kind: 'ask', result: await window.island.ask(a.text, a.context) }
      case 'copy-otp':
        await window.island.copyOtp(a.id)
        return { kind: 'info', text: 'Code copied — the clipboard clears automatically.' }
      case 'open-panel':
        return { kind: 'panel', panel: a.panel }
      case 'add-workspace':
        await window.island.addWorkspace()
        return { kind: 'none' }
      case 'git': {
        if (a.op === 'push' && !confirm(`Run "git push" in ${snap.settings.activeWorkspace}?`)) return { kind: 'none' }
        const r = await window.island.gitAction(a.op)
        return r.ok ? { kind: 'info', text: r.message } : { kind: 'error', text: r.message }
      }
      case 'commit': {
        const p = snap.proposal
        if (!p) return { kind: 'panel', panel: 'git' }
        const r = await window.island.commit(p.message, a.push, p.diffHash)
        return r.ok ? { kind: 'info', text: r.message } : { kind: 'error', text: r.message }
      }
    }
  } catch (e) {
    return { kind: 'error', text: String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }
  }
  return { kind: 'none' }
}

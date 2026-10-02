import type { ActivityContext, AgentRun, GitState, MailSummary, OtpCode, Suggestion } from '@shared/types'

export interface LifeContext {
  activity: ActivityContext | null
  mailStatus: 'off' | 'connecting' | 'watching' | 'error'
  inbox: MailSummary[]
  /** Basename of the active workspace, to avoid suggesting what is already followed. */
  activeProject: string | null
}

/**
 * Rule-based "what will you probably do next" engine. It only ever *suggests* —
 * every suggestion needs a click, and agent runs still go through the approval card.
 */
export function buildSuggestions(
  git: GitState | null,
  otps: OtpCode[],
  runs: AgentRun[],
  dismissed: Set<string>,
  life: LifeContext
): Suggestion[] {
  const out: Suggestion[] = []
  const now = Date.now()
  const push = (s: Omit<Suggestion, 'createdAt'>) => {
    if (!dismissed.has(s.id)) out.push({ ...s, createdAt: now })
  }

  for (const o of otps) {
    push({
      id: `otp:${o.id}`,
      title: `Copy code from ${o.from}`,
      detail: o.subject,
      icon: 'key',
      action: { type: 'copy-otp', id: o.id }
    })
  }

  // ---- Everyday context: what app are you in right now?
  const a = life.activity
  if (a?.signIn) {
    if (life.mailStatus === 'watching') {
      if (!otps.length)
        push({
          id: `signin:${a.app}`,
          title: 'Signing in? I’m watching your inbox for the code',
          detail: 'It will pop up here the moment it arrives — one click to copy.',
          icon: 'key',
          action: { type: 'open-panel', panel: 'mail' }
        })
    }
  }
  const unread = life.inbox.filter(m => m.unread)
  if (a?.kind === 'mail' && life.mailStatus === 'watching') {
    push({
      id: `mail-summary:${life.inbox[0]?.uid ?? 0}`,
      title: unread.length ? `Summarize your ${unread.length} unread email${unread.length > 1 ? 's' : ''}` : 'Summarize your latest emails',
      detail: 'What needs a reply, what can wait. Codes are hidden from the AI.',
      icon: 'mail',
      action: { type: 'ask', text: 'Summarize my latest emails and tell me which ones need action from me.', context: 'general' }
    })
  }
  if (a?.kind === 'ide' && a.project && life.activeProject?.toLowerCase() !== a.project.toLowerCase()) {
    push({
      id: `follow:${a.project}`,
      title: `Follow “${a.project}” in Isla?`,
      detail: 'Allow this folder to see its git status and get coding suggestions.',
      icon: 'folder',
      action: { type: 'add-workspace' }
    })
  }

  const pending = runs.filter(r => r.status === 'pending-approval').length
  if (pending) {
    push({
      id: `approve:${pending}`,
      title: `${pending} agent task${pending > 1 ? 's' : ''} waiting for your approval`,
      detail: 'Review exactly what will run before it starts.',
      icon: 'warn',
      action: { type: 'open-panel', panel: 'agent' }
    })
  }

  if (git?.isRepo) {
    const changed = git.staged + git.modified + git.untracked
    const branch = git.branch ?? 'HEAD'
    if (git.conflicted > 0) {
      push({
        id: `conflict:${git.conflicted}:${branch}`,
        title: `Resolve ${git.conflicted} merge conflict${git.conflicted > 1 ? 's' : ''}`,
        detail: 'Ask the agent to explain both sides and propose a resolution.',
        icon: 'conflict',
        action: {
          type: 'run',
          request: {
            title: 'Explain merge conflicts',
            prompt:
              'There are merge conflicts in this repository. Run `git status` and `git diff`, explain each conflict (what each side changed) and propose the resolution for each file. Do not edit files.'
          }
        }
      })
    }
    if (changed > 0) {
      const idleMin = git.lastCommitAt ? Math.round((now - git.lastCommitAt) / 60_000) : null
      push({
        id: `commit:${branch}:${git.commits[0]?.hash ?? ''}:${Math.min(changed, 50)}`,
        title: `Draft a commit message for ${changed} change${changed > 1 ? 's' : ''}`,
        detail: idleMin !== null && idleMin > 30 ? `Last commit was ${idleMin} min ago.` : `On ${branch}.`,
        icon: 'commit',
        action: {
          type: 'run',
          request: {
            title: 'Draft commit message',
            prompt:
              'Look at the uncommitted changes (`git status`, `git diff`, `git diff --cached`). Write a concise conventional-commit style message (subject ≤ 72 chars + short body). If the changes mix unrelated work, suggest how to split them into separate commits. Do not run git commit.'
          }
        }
      })
      push({
        id: `review:${branch}:${git.commits[0]?.hash ?? ''}:${Math.min(changed, 50)}`,
        title: 'Review my changes before committing',
        detail: 'Bugs, missing tests, leftover debug code, secrets.',
        icon: 'review',
        action: {
          type: 'run',
          request: {
            title: 'Review uncommitted changes',
            prompt:
              'Review the uncommitted changes in this repo (`git diff` and `git diff --cached`). List concrete bugs, risky edge cases, missing tests, leftover debug output and any hard-coded secrets. Be brief and specific with file:line. Do not edit files.'
          }
        }
      })
    }
    if (git.ahead > 0 && changed === 0) {
      push({
        id: `push:${branch}:${git.ahead}`,
        title: `Push ${git.ahead} commit${git.ahead > 1 ? 's' : ''} to ${git.upstream ?? 'remote'}`,
        detail: 'Your branch is ahead of its upstream.',
        icon: 'push',
        action: { type: 'git', op: 'push' }
      })
    }
    if (git.behind > 0) {
      push({
        id: `pull:${branch}:${git.behind}`,
        title: `Pull ${git.behind} new commit${git.behind > 1 ? 's' : ''}`,
        detail: 'Fast-forward only — never creates a merge commit.',
        icon: 'pull',
        action: { type: 'git', op: 'pull' }
      })
    }
  }

  const lastDone = runs.find(r => r.status === 'done' && r.endedAt && now - r.endedAt < 10 * 60_000)
  if (lastDone) {
    push({
      id: `result:${lastDone.id}`,
      title: `“${lastDone.title}” finished`,
      detail: 'Open the result.',
      icon: 'spark',
      action: { type: 'open-panel', panel: 'agent' }
    })
  }
  return out.slice(0, 6)
}



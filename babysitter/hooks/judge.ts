import type { AgentRec } from '../types'
import { clip, oneLine, redact, type Finding } from './detectors'
import { recentCalls } from './interventions'

export type Verdict = { isStuck: boolean; reason: string; fix: string }

/**
 * What the judge sees: the task, what the rules flagged, and the agent's last
 * calls with their outcomes. The rules only say "this looks like a loop"; the
 * judge decides whether the agent is actually getting anywhere.
 */
export function judgePrompt(a: AgentRec, f: Finding, now: number): string {
  return [
    'You supervise a coding sub-agent that is working on its own. A rule flagged it as possibly stuck.',
    'Decide from its recent activity whether it is still making real progress toward the task.',
    'Repeating a command after changing the code it tests IS progress if the output changes. Re-running the',
    'same failing command with the same error, or waiting on something that will never answer, is NOT.',
    '',
    `Task: ${redact(oneLine(a.prompt, 600))}`,
    `Flagged: ${f.kind}: ${f.detail}`,
    `Running for ${Math.round((now - a.startedAt) / 1000)}s, ${a.toolCalls} tool calls, ${a.errors} errors.`,
    'Its last tool calls, oldest first:',
    recentCalls(a, 12) || '(none)',
    '',
    'Answer in exactly this format, nothing else:',
    'VERDICT: NO_PROGRESS or PROGRESS',
    'REASON: one short sentence',
    'FIX: for NO_PROGRESS, one or two short sentences on what it should do instead; otherwise "-"',
  ].join('\n')
}

/** Reads the judge's answer; null when it did not answer in the format. */
export function parseVerdict(text: string): Verdict | null {
  const verdict = /VERDICT:\s*(NO_PROGRESS|PROGRESS)/i.exec(text)?.[1]?.toUpperCase()
  if (verdict === undefined) return null
  const reason = /REASON:\s*(.+)/i.exec(text)?.[1]?.trim() ?? ''
  const fix = /FIX:\s*(.+)/i.exec(text)?.[1]?.trim() ?? ''
  return {
    isStuck: verdict === 'NO_PROGRESS',
    reason: clip(reason, 240),
    fix: fix === '-' ? '' : clip(fix, 400),
  }
}

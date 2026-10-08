import type { AgentRec } from '../types'
import { oneLine, redact, type Finding } from './detectors'

const ADVICE: Record<Finding['kind'], string> = {
  loop: 'Repeating the same call will not change the result. Read the error, find the actual cause, and try a different approach.',
  errors: 'Several calls in a row have failed. Stop and check your assumptions (paths, commands, environment) before the next call.',
  stall: 'You have made no progress for a while. If a command is hanging, stop waiting on it and use a bounded alternative (a timeout, a background process, a different check).',
  runaway: 'You have been at this for a long time. Wrap up: finish the part you can, and report what is left.',
  budget: 'You have used a lot of tokens on this. Wrap up now: finish the part you can, and report what is left.',
  manual: 'The developer watching you asked you to change course.',
}

/** The calls a diagnosis or a correction quotes: the last few, redacted. */
export function recentCalls(a: AgentRec, n = 10): string {
  return a.recent
    .slice(-n)
    .map(c => `- ${c.brief}${c.isError ? ` → ERROR: ${redact(oneLine(c.out, 160))}` : ''}`)
    .join('\n')
}

/** What Haiku is asked when an agent gets stuck. */
export function diagnosisPrompt(a: AgentRec, f: Finding): string {
  return [
    'A coding sub-agent got stuck. Diagnose it in at most 2 short sentences, under 300 characters:',
    'what is actually going wrong, and one concrete different approach it should take instead.',
    'Do not restate the task. No preamble.',
    '',
    `Task: ${redact(oneLine(a.prompt, 600))}`,
    `Problem detected: ${f.kind}: ${f.detail}`,
    'Its last tool calls:',
    recentCalls(a),
  ].join('\n')
}

/** The message written into a stuck agent's own conversation. */
export function correctionMessage(f: Finding, diagnosis: string): string {
  return [
    `[babysitter] I am watching your progress and you look stuck: ${f.detail}.`,
    diagnosis !== '' ? `Diagnosis: ${diagnosis}` : ADVICE[f.kind],
    'Change your approach now. If you cannot make progress, stop and return a partial result that explains what blocked you.',
  ].join('\n')
}

/** The prompt a killed task is respawned with: the original task plus what went wrong. */
export function respawnPrompt(rootPrompt: string, a: AgentRec, f: Finding, diagnosis: string): string {
  return [
    rootPrompt,
    '',
    '---',
    '[babysitter] A previous attempt at this task was stopped because it got stuck.',
    `What went wrong: ${f.detail}.`,
    diagnosis !== '' ? `Diagnosis: ${diagnosis}` : ADVICE[f.kind],
    'Its last tool calls, so you do not repeat them:',
    recentCalls(a, 8),
    '',
    'Take a different approach. If you get stuck again, stop and return a partial result that explains what blocked you.',
  ].join('\n')
}

export type Mode = 'correct' | 'kill' | 'nudge' | 'warn'
export type Step = 'warn' | 'correct' | 'kill' | 'kill-respawn' | 'skip'

/**
 * The ladder, as a table: what to do about a stuck agent, given the mode and
 * how far it has already gone (stage 0 untouched, 1 corrected in place).
 */
export function decide(mode: Mode, stage: number, isAlreadyWarned: boolean): Step {
  if (mode === 'warn' || (mode === 'nudge' && stage >= 1)) return isAlreadyWarned ? 'skip' : 'warn'
  if (mode === 'kill') return 'kill'
  if (mode === 'correct' && stage >= 1) return 'kill-respawn'
  return 'correct'
}

/** How many respawns a task has had: every agent of its root that is a retry. */
export function retriesOf(agents: Record<string, AgentRec>, rootId: string): number {
  return Object.values(agents).filter(x => x.rootId === rootId && x.retryOf !== null).length
}

export function isMode(value: string): value is Mode {
  return value === 'correct' || value === 'kill' || value === 'nudge' || value === 'warn'
}

import type { AgentRec, Call } from '../types'
import type { Thresholds } from '../hooks/detectors'

export const TH: Thresholds = {
  loopRepeats: 3,
  loopWindow: 8,
  errorStreak: 4,
  stallMs: 60_000,
  runawayMs: 15 * 60_000,
  runawayCalls: 60,
  tokenBudget: 1_000_000,
}

export function agent(over: Partial<AgentRec> = {}): AgentRec {
  return {
    id: 'ag1', num: 1, description: 'Fix flaky test', type: 'general-purpose', model: 'haiku', prompt: 'Fix test/flaky.test.ts',
    background: true, parentId: null, startedAt: 0, lastActivityAt: 0, endedAt: null, status: 'running',
    toolCalls: 0, errors: 0, consecutiveErrors: 0, inFlight: 0, recent: [], stage: 0, armedCalls: 0, armedAt: 0, armedTokens: 0,
    warned: [], diagnosis: '', rootId: 'ag1', retryOf: null, pendingRespawn: null, answer: '', tokens: 0,
    ...over,
  }
}

export function call(tool: string, subject: string, isError: boolean, at = 0): Call {
  return { tool, sig: `${tool}:${subject}`, brief: `${tool} ${subject}`, isError, out: isError ? 'No such file or directory' : 'ok', at }
}

/** An agent whose history is these calls, counters filled in as the tracker would. */
export function withCalls(calls: Call[], over: Partial<AgentRec> = {}): AgentRec {
  let streak = 0
  for (const c of calls) streak = c.isError ? streak + 1 : 0
  const last = calls[calls.length - 1]
  return agent({
    recent: calls,
    toolCalls: calls.length,
    errors: calls.filter(c => c.isError).length,
    consecutiveErrors: streak,
    lastActivityAt: last?.at ?? 0,
    ...over,
  })
}

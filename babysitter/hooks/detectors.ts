import type { AgentRec, DetectorKind } from '../types'

export type Thresholds = {
  loopRepeats: number
  loopWindow: number
  errorStreak: number
  stallMs: number
  runawayMs: number
  runawayCalls: number
  /** Tokens an agent may process (input, cache and output) before it counts as over budget; 0 turns it off. */
  tokenBudget: number
}

export type Finding = { kind: DetectorKind | 'manual'; detail: string }

/** Lookups an agent legitimately repeats (re-reading a file after an edit). */
const LOOKUP_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch'])

/** Bookkeeping calls that say nothing about progress. */
export const IGNORED_TOOLS = new Set(['SubagentHandback', 'TodoWrite', 'TaskUpdate'])

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

/** The tool's own arguments, without the envelope keys the engine adds. */
export function toolInput(e: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.has(k)))
}

export function signature(tool: string, input: Record<string, unknown>): string {
  return `${tool}:${stableStringify(input)}`
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Cuts at the last full sentence that fits, so a message never ends mid-word. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return end > max / 3 ? cut.slice(0, end + 1) : oneLine(flat, max)
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)\S+/gi,
]

/** Masks things that look like credentials before text leaves the session. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, pattern) => out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}•••` : '•••'),
    text,
  )
}

/** A short human label for a call: `Bash ls /x`, `Read src/a.ts`. */
export function brief(tool: string, input: Record<string, unknown>): string {
  const subject = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description
  return typeof subject === 'string' ? `${tool} ${redact(oneLine(subject, 80))}` : tool
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`
}

/** The first problem a running agent shows, or null. Pure: the tests drive it. */
export function detect(a: AgentRec, now: number, t: Thresholds): Finding | null {
  if (a.status !== 'running') return null

  const window = a.recent.slice(-t.loopWindow)
  const groups = new Map<string, { tool: string; brief: string; n: number; failed: number; out: string }>()
  for (const call of window) {
    const g = groups.get(call.sig) ?? { tool: call.tool, brief: call.brief, n: 0, failed: 0, out: '' }
    g.n += 1
    if (call.isError) {
      g.failed += 1
      g.out = call.out
    }
    groups.set(call.sig, g)
  }
  for (const g of groups.values()) {
    const allFailed = g.failed === g.n
    const need = t.loopRepeats + (allFailed ? 0 : 2) + (LOOKUP_TOOLS.has(g.tool) ? 2 : 0)
    if (g.n >= need) {
      const how = allFailed ? `, failing the same way each time (${oneLine(g.out, 120)})` : ''
      return { kind: 'loop', detail: `ran \`${g.brief}\` ${g.n} times in its last ${window.length} calls${how}` }
    }
  }

  if (a.consecutiveErrors >= t.errorStreak) {
    const last = a.recent[a.recent.length - 1]
    const tail = last === undefined ? '' : ` (last: \`${last.brief}\` → ${oneLine(last.out, 120)})`
    return { kind: 'errors', detail: `${a.consecutiveErrors} tool errors in a row${tail}` }
  }

  const quiet = now - a.lastActivityAt
  const stallLimit = a.inFlight > 0 ? t.stallMs * 3 : t.stallMs
  if (quiet >= stallLimit) {
    const last = a.recent[a.recent.length - 1]
    return {
      kind: 'stall',
      detail: a.inFlight > 0
        ? `one tool call has been running for ${seconds(quiet)}`
        : `no tool activity for ${seconds(quiet)}${last === undefined ? '' : ` after \`${last.brief}\``}`,
    }
  }

  const spent = a.tokens - a.armedTokens
  if (t.tokenBudget > 0 && spent >= t.tokenBudget) {
    return { kind: 'budget', detail: `${Math.round(spent / 1000)}k tokens, over the ${Math.round(t.tokenBudget / 1000)}k budget` }
  }

  const calls = a.toolCalls - a.armedCalls
  const ran = now - a.armedAt
  if (calls >= t.runawayCalls || ran >= t.runawayMs) {
    return { kind: 'runaway', detail: `${calls} tool calls over ${Math.round(ran / 60000)} min` }
  }

  return null
}

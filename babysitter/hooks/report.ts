import type { AgentRec, Incident } from '../types'
import { oneLine, redact } from './detectors'

export const ICON = {
  running: '🟢',
  stuck: '🟡',
  corrected: '🟠',
  completed: '✅',
  failed: '❌',
  killed: '🔴',
} as const

export function iconOf(a: AgentRec, flagged: boolean): string {
  if (a.status === 'running') return a.stage > 0 ? ICON.corrected : flagged ? ICON.stuck : ICON.running
  return ICON[a.status]
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export type ReportInput = {
  agents: AgentRec[]
  incidents: Incident[]
  costUsd: number | null
  summary: string
  now: number
}

export type Totals = { done: number; failed: number; killed: number; corrected: number; needsHuman: number }

export function totals(agents: AgentRec[], incidents: Incident[]): Totals {
  return {
    done: agents.filter(a => a.status === 'completed').length,
    failed: agents.filter(a => a.status === 'failed').length,
    killed: agents.filter(a => a.status === 'killed').length,
    corrected: incidents.filter(i => i.action === 'corrected').length,
    needsHuman: incidents.filter(i => i.action === 'needs-human').length,
  }
}

/** One line for the push notification and the status line, under 200 chars. */
export function headline(r: ReportInput): string {
  const t = totals(r.agents, r.incidents)
  const parts = [`${t.done}/${r.agents.length} done`]
  if (t.corrected > 0) parts.push(`${t.corrected} corrected`)
  if (t.killed > 0) parts.push(`${t.killed} killed`)
  if (t.needsHuman > 0) parts.push(`⚠️ ${t.needsHuman} need you`)
  if (r.costUsd !== null) parts.push(`session $${r.costUsd.toFixed(2)}`)
  return oneLine(`🍼 ${parts.join(' · ')}`, 190)
}

/** The full report, as markdown: the file and the transcript notice. */
export function markdown(r: ReportInput): string {
  const lines: string[] = []
  lines.push(`# 🍼 Babysitter report`, '', headline(r), '')
  if (r.summary !== '') lines.push(r.summary, '')
  lines.push('| | Agent | Type | Time | Calls | Errors | Tokens |', '| --- | --- | --- | --- | --- | --- | --- |')
  for (const a of r.agents) {
    const time = duration((a.endedAt ?? r.now) - a.startedAt)
    const name = `#${a.num} ${oneLine(a.description, 50)}`
    lines.push(`| ${iconOf(a, false)} | ${name} | ${a.type} | ${time} | ${a.toolCalls} | ${a.errors} | ${tokens(a.tokens)} |`)
  }
  if (r.incidents.length > 0) {
    lines.push('', '## What I stepped in on', '')
    for (const i of r.incidents) {
      lines.push(`- **${i.action}** · ${oneLine(i.description, 50)} · ${i.kind}: ${redact(oneLine(i.detail, 200))}`)
    }
  }
  const asks = r.incidents.filter(i => i.action === 'needs-human')
  if (asks.length > 0) {
    lines.push('', '## Needs you', '')
    for (const i of asks) lines.push(`- ${oneLine(i.description, 60)}: ${redact(oneLine(i.detail, 200))}`)
  }
  return lines.join('\n')
}

/** What Haiku is asked to summarise the run. */
export function summaryPrompt(r: ReportInput): string {
  const agents = r.agents
    .map(a => `- ${a.description} [${a.status}${a.retryOf !== null ? ', respawn' : ''}]: ${redact(oneLine(a.answer, 300)) || '(no answer captured)'}`)
    .join('\n')
  const incidents = r.incidents.map(i => `- ${i.action} ${i.description}: ${i.kind} ${redact(oneLine(i.detail, 160))}`).join('\n')
  return [
    'Summarise this run of background coding agents for the developer who left them running.',
    'Two or three short sentences: what got done, and what needs their attention. No preamble, no headings.',
    '',
    'Agents:',
    agents,
    '',
    'Interventions:',
    incidents || '(none)',
  ].join('\n')
}

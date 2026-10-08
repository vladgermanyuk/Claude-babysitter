import { expect, test } from 'claude-code/testing'

import type { Incident } from '../types'
import { headline, markdown } from '../hooks/report'
import { agent } from './fixtures'

const incidents: Incident[] = [
  { at: 1, agentId: 'ag2', description: 'Fix flaky test', kind: 'loop', detail: 'ran ls 3 times', action: 'corrected' },
  { at: 2, agentId: 'ag2', description: 'Fix flaky test', kind: 'loop', detail: 'ran ls 3 times', action: 'killed' },
  { at: 3, agentId: 'ag3', description: 'Start dev server', kind: 'stall', detail: 'quiet 60s', action: 'needs-human' },
]
const agents = [
  agent({ id: 'ag1', num: 1, description: 'Add date tests', status: 'completed', endedAt: 90_000 }),
  agent({ id: 'ag2', num: 2, status: 'killed', endedAt: 30_000 }),
  agent({ id: 'ag3', num: 3, description: 'Start dev server', status: 'killed', endedAt: 60_000 }),
]

test('R3: the headline counts outcomes and stays short', () => {
  const line = headline({ agents, incidents, costUsd: 0.84, summary: '', now: 100_000 })
  expect(line).toBe('🍼 1/3 done · 1 corrected · 2 killed · ⚠️ 1 need you · session $0.84')
  expect(line.length).toBeLessThan(200)
})

test('R3: the report has the table, the interventions and what needs you', () => {
  const md = markdown({ agents, incidents, costUsd: null, summary: 'Two of three need a look.', now: 100_000 })
  expect(md).toContain('| ✅ | #1 Add date tests | general-purpose | 1m30s |')
  expect(md).toContain('## What I stepped in on')
  expect(md).toContain('**killed** · Fix flaky test · loop')
  expect(md).toContain('## Needs you')
  expect(md).toContain('Two of three need a look.')
})

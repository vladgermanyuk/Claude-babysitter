import { describe, expect, test } from 'claude-code/testing'

import { judgePrompt, parseVerdict } from '../hooks/judge'
import { call, withCalls } from './fixtures'

describe('parseVerdict', () => {
  test('NO_PROGRESS with a reason and a fix', () => {
    const v = parseVerdict('VERDICT: NO_PROGRESS\nREASON: Same ECONNREFUSED five times.\nFIX: Mock fetch in the test.')
    expect(v).toEqual({ isStuck: true, reason: 'Same ECONNREFUSED five times.', fix: 'Mock fetch in the test.' })
  })

  test('PROGRESS drops the placeholder fix', () => {
    const v = parseVerdict('VERDICT: PROGRESS\nREASON: Each run fails on a different assertion.\nFIX: -')
    expect(v).toEqual({ isStuck: false, reason: 'Each run fails on a different assertion.', fix: '' })
  })

  test('tolerates case and surrounding text', () => {
    expect(parseVerdict('Sure.\nverdict: no_progress\nreason: stuck')?.isStuck).toBe(true)
  })

  test('no verdict line is no verdict', () => {
    expect(parseVerdict('I think it is probably fine')).toBe(null)
    expect(parseVerdict('')).toBe(null)
  })
})

test('the judge sees the task, the flag and the calls with their errors', () => {
  const a = withCalls([call('Bash', 'node --test test/rates.test.js', true), call('Bash', 'node --test test/rates.test.js', true)])
  const prompt = judgePrompt(a, { kind: 'loop', detail: 'ran it 3 times' }, 60_000)
  expect(prompt).toContain('Task: Fix test/flaky.test.ts')
  expect(prompt).toContain('Flagged: loop: ran it 3 times')
  expect(prompt).toContain('- Bash node --test test/rates.test.js → ERROR: No such file or directory')
  expect(prompt).toContain('VERDICT: NO_PROGRESS or PROGRESS')
  expect(prompt).toContain('even if the task says to retry')
})

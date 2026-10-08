import { describe, expect, test } from 'claude-code/testing'

import { brief, clip, detect, redact, signature } from '../hooks/detectors'
import { TH, agent, call, withCalls } from './fixtures'

describe('loop', () => {
  test('D1: three identical failing calls are a loop', () => {
    const a = withCalls([call('Bash', 'ls /x', true), call('Bash', 'ls /x', true), call('Bash', 'ls /x', true)])
    expect(detect(a, 1000, TH)?.kind).toBe('loop')
  })

  test('D2: three different commands are not', () => {
    const a = withCalls([call('Bash', 'ls /a', true), call('Bash', 'ls /b', true), call('Bash', 'ls /c', true)])
    expect(detect(a, 1000, TH)).toBe(null)
  })

  test('D3: re-reading a file between edits is not a loop', () => {
    const a = withCalls([
      call('Read', 'a.ts', false), call('Edit', 'a.ts#1', false),
      call('Read', 'a.ts', false), call('Edit', 'a.ts#2', false),
      call('Read', 'a.ts', false),
    ])
    expect(detect(a, 1000, TH)).toBe(null)
  })

  test('identical successful calls need two more repeats than failing ones', () => {
    const four = withCalls(Array.from({ length: 4 }, () => call('Bash', 'npm test', false)))
    const five = withCalls(Array.from({ length: 5 }, () => call('Bash', 'npm test', false)))
    expect(detect(four, 1000, TH)).toBe(null)
    expect(detect(five, 1000, TH)?.kind).toBe('loop')
  })

  test('the detail names the command and the error', () => {
    const a = withCalls([call('Bash', 'ls /x', true), call('Bash', 'ls /x', true), call('Bash', 'ls /x', true)])
    expect(detect(a, 1000, TH)?.detail).toContain('Bash ls /x')
    expect(detect(a, 1000, TH)?.detail).toContain('No such file')
  })
})

describe('errors', () => {
  test('D4: four errors in a row', () => {
    const a = withCalls(['a', 'b', 'c', 'd'].map(x => call('Bash', x, true)))
    expect(detect(a, 1000, TH)?.kind).toBe('errors')
  })

  test('D5: a success resets the streak', () => {
    const a = withCalls([
      call('Bash', 'a', true), call('Bash', 'b', true), call('Bash', 'c', true),
      call('Bash', 'd', false),
      call('Bash', 'e', true), call('Bash', 'f', true), call('Bash', 'g', true),
    ])
    expect(detect(a, 1000, TH)).toBe(null)
  })
})

describe('stall and runaway', () => {
  test('D6: no activity past the limit is a stall', () => {
    const a = agent({ lastActivityAt: 0 })
    expect(detect(a, 59_000, TH)).toBe(null)
    expect(detect(a, 61_000, TH)?.kind).toBe('stall')
  })

  test('D7: a call in flight gets three times the limit', () => {
    const a = agent({ lastActivityAt: 0, inFlight: 1 })
    expect(detect(a, 90_000, TH)).toBe(null)
    expect(detect(a, 181_000, TH)?.kind).toBe('stall')
  })

  test('D8: too many calls since the last correction is runaway', () => {
    const a = agent({ toolCalls: 70, armedCalls: 5, lastActivityAt: 1000 })
    expect(detect(a, 1000, TH)?.kind).toBe('runaway')
    expect(detect({ ...a, armedCalls: 20 }, 1000, TH)).toBe(null)
  })

  test('a finished agent is never flagged', () => {
    const a = withCalls(['x', 'x', 'x'].map(x => call('Bash', x, true)), { status: 'completed' })
    expect(detect(a, 10_000_000, TH)).toBe(null)
  })
})

describe('labels and secrets', () => {
  test('signature ignores key order', () => {
    expect(signature('Bash', { command: 'ls', timeout: 5 })).toBe(signature('Bash', { timeout: 5, command: 'ls' }))
  })

  test('N6: credentials are masked', () => {
    const text = redact('curl -H "x: sk-test-FAKEFAKEFAKEFAKE1234" && export API_KEY=hunter2 ghp_FAKEFAKEFAKEFAKEFAKEFAKE')
    expect(text).not.toContain('FAKEFAKEFAKEFAKE1234')
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('ghp_FAKEFAKE')
    expect(text).toContain('API_KEY=•••')
  })

  test('brief shows the subject, redacted', () => {
    expect(brief('Bash', { command: 'echo token=abc123' })).toBe('Bash echo token=•••')
    expect(brief('Read', { file_path: '/a/b.ts' })).toBe('Read /a/b.ts')
  })
})

describe('budget', () => {
  test('F: tokens past the budget, counted since the last correction', () => {
    const a = agent({ tokens: 1_200_000, lastActivityAt: 1000 })
    expect(detect(a, 1000, TH)?.kind).toBe('budget')
    expect(detect({ ...a, armedTokens: 500_000 }, 1000, TH)).toBe(null)
    expect(detect(a, 1000, { ...TH, tokenBudget: 0 })).toBe(null)
  })
})

test('clip ends on a full sentence', () => {
  const text = 'The directory does not exist. Retrying will not help. Report the failure after three tries and stop retrying the same command forever.'
  expect(clip(text, 60)).toBe('The directory does not exist. Retrying will not help.')
  expect(clip('short', 60)).toBe('short')
})

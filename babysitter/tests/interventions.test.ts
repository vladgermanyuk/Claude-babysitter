import { describe, expect, test } from 'claude-code/testing'

import { correctionMessage, decide, respawnPrompt, retriesOf } from '../hooks/interventions'
import { agent, call, withCalls } from './fixtures'

describe('C12: the ladder per mode', () => {
  const cases: [Parameters<typeof decide>, ReturnType<typeof decide>][] = [
    [['correct', 0, false], 'correct'],
    [['correct', 1, false], 'kill-respawn'],
    [['kill', 0, false], 'kill'],
    [['nudge', 0, false], 'correct'],
    [['nudge', 1, false], 'warn'],
    [['nudge', 1, true], 'skip'],
    [['warn', 0, false], 'warn'],
    [['warn', 0, true], 'skip'],
  ]
  for (const [args, step] of cases) {
    test(`${args.join(' · ')} → ${step}`, () => {
      expect(decide(...args)).toBe(step)
    })
  }
})

describe('C2: what the agent is told', () => {
  const f = { kind: 'loop' as const, detail: 'ran `Bash ls /x` 3 times in its last 3 calls' }

  test('the correction names the problem and uses the diagnosis', () => {
    const text = correctionMessage(f, 'The directory does not exist; create it first.')
    expect(text).toContain('[babysitter]')
    expect(text).toContain('Bash ls /x')
    expect(text).toContain('Diagnosis: The directory does not exist')
  })

  test('it says how far the agent has got by the time it is written', () => {
    expect(correctionMessage(f, '', { calls: 5, errors: 5 })).toContain('So far in this task: 5 tool calls, 5 of them failed.')
  })

  test('without a diagnosis it falls back to advice for the detector', () => {
    expect(correctionMessage(f, '')).toContain('Repeating the same call will not change the result')
  })

  test('the respawn prompt keeps the task and lists the calls not to repeat', () => {
    const a = withCalls([call('Bash', 'ls /x', true), call('Bash', 'ls /x', true)])
    const prompt = respawnPrompt('Fix test/flaky.test.ts', a, f, '')
    expect(prompt.startsWith('Fix test/flaky.test.ts')).toBe(true)
    expect(prompt).toContain('A previous attempt at this task was stopped')
    expect(prompt).toContain('- Bash ls /x → ERROR: No such file or directory')
  })
})

test('C8: respawns are counted per task, across the chain', () => {
  const agents = {
    ag1: agent({ id: 'ag1', rootId: 'ag1' }),
    ag2: agent({ id: 'ag2', rootId: 'ag1', retryOf: 'ag1' }),
    ag3: agent({ id: 'ag3', rootId: 'ag3' }),
  }
  expect(retriesOf(agents, 'ag1')).toBe(1)
  expect(retriesOf(agents, 'ag3')).toBe(0)
})

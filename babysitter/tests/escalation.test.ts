// Engine tests for the ladder. Beneath the plugin, `world` answers like a session:
// agents whose every Bash call fails, a TaskStop that works, a judge whose verdict
// each test picks (none by default: the rules then decide alone). The mod is read
// through its own `/babysit json`. (Since 2.1.294 the test engine writes
// corrections with $.session.append and applies test options, as a session does.)
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRec, Incident } from '../types'

function world(on: On, opts: { refuseRespawn?: boolean; judge?: string } = {}) {
  const stopped: string[] = []
  const ran: string[] = []
  const spawned: { prompt: string; description: string }[] = []
  const toasts: string[] = []
  const files: { path: string; text: string }[] = []
  let n = 0

  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: '/tmp/demo' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [], cost: { usd: 0.42 } } }) as never)
  on('fs.write', ($, e) => {
    files.push(e as unknown as { path: string; text: string })
    return { value: undefined } as never
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const judged: string[] = []
  on('model.complete', ($, e) => {
    if (!e.prompt.includes('VERDICT:')) return { value: { isAnswered: false, reason: 'empty-reply', usage: {} } } as never
    judged.push(e.prompt)
    if (opts.judge === undefined) return { value: { isAnswered: false, reason: 'empty-reply', usage: {} } } as never
    return { value: { isAnswered: true, text: opts.judge, usage: {} } } as never
  })
  on('agent.spawn', ($, e) => {
    if (opts.refuseRespawn === true && spawned.length > 0) return { deny: 'auto mode classifier gave no verdict' }
    spawned.push({ prompt: e.prompt, description: e.description })
    n += 1
    return { model: 'claude-haiku-4-5', agentId: `ag${n}` }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'TaskStop') {
      stopped.push(String(e.task_id))
      return { result: { message: 'stopped' }, text: 'stopped' } as never
    }
    if (e.tool === 'PushNotification') return { result: {}, text: 'sent' } as never
    if (e.tool === 'Bash') ran.push(e.command)
    return { isError: true, result: 'ls: /x: No such file or directory', text: 'ls: /x: No such file or directory' } as never
  })
  return { stopped, spawned, toasts, files, judged, ran }
}

const OPTIONS = { push: false }

// The engine's $ as a test holds it; typed loosely so helpers stay short.
type Engine = any

async function start($: Engine) {
  await $.session.start({ cwd: '/tmp/demo', surface: null, isInteractive: false })
}

async function spawnAgent($: Engine, description = 'Fix flaky test') {
  await $.agent.spawn({
    tool_use_id: `t-${description}`, prompt: `Task: ${description}`, description, subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  })
}

let seq = 0
async function loop($: Engine, agentId: string, times: number) {
  for (let i = 0; i < times; i++) {
    seq += 1
    await $.tool.call({ tool: 'Bash', command: 'ls /x', agentId, tool_use_id: `c${seq}` })
  }
}

async function setMode($: Engine, mode: string) {
  await $.command.run({ command: 'babysit', args: `mode ${mode}`, origin: { kind: 'composer' } })
}

/** What the mod holds, through its own `/babysit json`. */
async function state($: Engine): Promise<{ mode: string; agents: Record<string, AgentRec>; incidents: Incident[] }> {
  const r = await $.command.run({ command: 'babysit', args: 'json', origin: { kind: 'composer' } })
  return JSON.parse(r.text)
}

describe('tracking', () => {
  test('T1/T2: a spawned agent and its calls are recorded', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    world(on)
    await start($)
    await spawnAgent($)
    await loop($, 'ag1', 2)
    const { agents } = await state($)
    expect(agents.ag1?.description).toBe('Fix flaky test')
    expect(agents.ag1?.toolCalls).toBe(2)
    expect(agents.ag1?.consecutiveErrors).toBe(2)
    expect(agents.ag1?.recent[1]?.brief).toBe('Bash ls /x')
  })

  test('T6/T7: the main loop and unknown agents are not tracked', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world(on)
    await start($)
    for (let i = 0; i < 4; i++) await ($ as Engine).tool.call({ tool: 'Bash', command: 'ls /x', tool_use_id: `m${i}` })
    await loop($, 'workflow-agent', 4)
    await clock.advance(2_100)
    expect(w.stopped).toEqual([])
    expect(Object.keys((await state($)).agents)).toEqual([])
  })
})

describe('Kill & Correct', () => {
  test('C1→C4→C6: correct in place; stuck again → kill and respawn with what went wrong', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world(on)
    await start($)
    await spawnAgent($)
    await loop($, 'ag1', 3)
    await clock.advance(2_100)
    expect((await state($)).incidents.map(i => i.action)).toEqual(['corrected'])
    expect(w.stopped).toEqual([])

    await loop($, 'ag1', 3)
    await clock.advance(2_100)
    expect(w.stopped).toEqual(['ag1'])
    expect(w.spawned).toHaveLength(2)
    expect(w.spawned[1]?.description).toBe('↻ Fix flaky test')
    expect(w.spawned[1]?.prompt).toContain('Task: Fix flaky test')
    expect(w.spawned[1]?.prompt).toContain('A previous attempt at this task was stopped')
    expect(w.spawned[1]?.prompt).toContain('Bash ls /x → ERROR')

    const { agents, incidents } = await state($)
    expect(agents.ag1?.status).toBe('killed')
    expect(incidents.map(i => i.action)).toEqual(['corrected', 'killed', 'respawned'])
  })
  test('C7: a refused respawn keeps the corrected prompt for the Respawn button', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { refuseRespawn: true })
    await start($)
    await spawnAgent($)
    for (let round = 0; round < 2; round++) {
      await loop($, 'ag1', 3)
      await clock.advance(2_100)
    }
    const { agents, incidents } = await state($)
    expect(agents.ag1?.pendingRespawn).toContain('A previous attempt')
    expect(incidents[incidents.length - 1]?.action).toBe('needs-human')
    expect(incidents[incidents.length - 1]?.detail).toContain('Press Respawn')
  })
  test('D10: one problem, one intervention: no repeat while it is in hand', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world(on)
    await start($)
    await spawnAgent($)
    await loop($, 'ag1', 3)
    await clock.advance(2_100)
    await clock.advance(2_100)
    await clock.advance(2_100)
    expect((await state($)).incidents.map(i => i.action)).toEqual(['corrected'])
    expect(w.stopped).toEqual([])
  })
})

describe('modes', () => {
  test('the mode can be switched for the session', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    world(on)
    await start($)
    await setMode($, 'warn')
    expect((await state($)).mode).toBe('warn')
  })

  test('C12: warn mode flags once and never touches the agent', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world(on)
    await start($)
    await setMode($, 'warn')
    await spawnAgent($)
    await loop($, 'ag1', 6)
    await clock.advance(2_100)
    await clock.advance(2_100)
    await clock.advance(2_100)
    expect(w.stopped).toEqual([])
    expect(w.spawned).toHaveLength(1)
    expect((await state($)).incidents.map(i => i.action)).toEqual(['warned'])
  })

  test('C12: kill mode stops at once and does not respawn', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world(on)
    await start($)
    await setMode($, 'kill')
    await spawnAgent($)
    await loop($, 'ag1', 3)
    await clock.advance(2_100)
    expect(w.stopped).toEqual(['ag1'])
    expect(w.spawned).toHaveLength(1)
  })

  test('UI7: /babysit off keeps tracking but never steps in', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world(on)
    await start($)
    await ($ as Engine).command.run({ command: 'babysit', args: 'off', origin: { kind: 'composer' } })
    await spawnAgent($)
    await loop($, 'ag1', 4)
    await clock.advance(2_100)
    expect(w.stopped).toEqual([])
    expect((await state($)).agents.ag1?.toolCalls).toBe(4)
  })
})

describe('report', () => {
  test('R1/R4: one report, saved to a file, once every background agent is done', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world(on)
    await start($)
    await spawnAgent($, 'Add date tests')
    await ($ as Engine).turn.complete({ answer: 'Added 4 tests.', durationMs: 5_000, isAborted: false, turnId: 't1', agentId: 'ag1', reason: 'answer' })
    await clock.advance(6_000)
    await clock.advance(6_000)

    expect(w.files).toHaveLength(1)
    expect(JSON.stringify(w.files[0])).toContain('/tmp/demo/.babysitter/reports/')
    expect(JSON.stringify(w.files[0])).toContain('Add date tests')
    expect(w.toasts).toContain('🍼 1/1 done · session $0.42')
  })

  test('R2: no report while an agent still runs', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world(on)
    await start($)
    await spawnAgent($, 'Add date tests')
    await spawnAgent($, 'Refactor module X')
    await ($ as Engine).turn.complete({ answer: 'Done.', durationMs: 5_000, isAborted: false, turnId: 't1', agentId: 'ag1', reason: 'answer' })
    await clock.advance(6_000)
    expect(w.files).toHaveLength(0)
  })
})

describe('judge', () => {
  test('v2: the judge says it is progressing, so nothing is touched', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world(on, { judge: 'VERDICT: PROGRESS\nREASON: Each run edits the code first.\nFIX: -' })
    await start($)
    await spawnAgent($)
    await loop($, 'ag1', 3)
    await clock.advance(2_100)
    expect(w.judged).toHaveLength(1)
    expect(w.stopped).toEqual([])
    expect(w.spawned).toHaveLength(1)
    const { incidents } = await state($)
    expect(incidents.map(i => i.action)).toEqual(['cleared'])
    expect(incidents[0]?.detail).toContain('Each run edits the code first.')
  })

  test('v2: NO_PROGRESS lets the ladder act, with the judge\'s fix in the correction and the respawn', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world(on, { judge: 'VERDICT: NO_PROGRESS\nREASON: Same ECONNREFUSED every time.\nFIX: Mock fetch in the test.' })
    await start($)
    await spawnAgent($)
    for (let round = 0; round < 2; round++) {
      await loop($, 'ag1', 3)
      await clock.advance(2_100)
    }
    expect(w.judged).toHaveLength(2)
    expect(w.stopped).toEqual(['ag1'])
    expect(w.spawned[1]?.prompt).toContain('Diagnosis: Mock fetch in the test.')
  })
  test('/babysit judge shows what was sent and what came back', { options: OPTIONS }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { judge: 'VERDICT: NO_PROGRESS\nREASON: Stuck.\nFIX: Stop.' })
    await start($)
    await spawnAgent($)
    await loop($, 'ag1', 3)
    await clock.advance(2_100)
    const r = await ($ as Engine).command.run({ command: 'babysit', args: 'judge', origin: { kind: 'composer' } })
    expect(r.text).toContain('Judge on #1 Fix flaky test')
    expect(r.text).toContain('── sent to Haiku ──')
    expect(r.text).toContain('VERDICT: NO_PROGRESS')
  })
})

describe('guard', () => {
  test('a subagent\'s git push never runs, and it is told why', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    const w = world(on)
    await start($)
    await spawnAgent($, 'Make CI green')
    const r = await ($ as Engine).tool.call({ tool: 'Bash', command: 'git push origin main', agentId: 'ag1', tool_use_id: 'push1' })
    expect(w.ran).toEqual([])
    expect(JSON.stringify(r)).toContain('[babysitter] Blocked: pushing is out of scope')
    const { incidents } = await state($)
    expect(incidents.map(i => [i.kind, i.action])).toEqual([['guard', 'blocked']])
  })

  test('the main session is not guarded: it is the person\'s own', { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    const w = world(on)
    await start($)
    await ($ as Engine).tool.call({ tool: 'Bash', command: 'git push origin main', tool_use_id: 'push2' })
    expect(w.ran).toEqual(['git push origin main'])
  })
})

test('/babysit json shows the settings in force', { options: OPTIONS }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on)
  await start($)
  const settings = (await state($) as unknown as { settings: { th: { tokenBudget: number; stallMs: number }; guard: string } }).settings
  expect(settings.th.tokenBudget).toBe(2_000_000)
  expect(settings.th.stallMs).toBe(180_000)
  expect(settings.guard).toBe('block')
})

test('agents started at once get their own numbers', { options: OPTIONS }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on)
  await start($)
  await Promise.all(['Date tests', 'Fix rates', 'Health check', 'CI green'].map(d => spawnAgent($, d)))
  const nums = Object.values((await state($)).agents).map(a => a.num).sort()
  expect(nums).toEqual([1, 2, 3, 4])
})

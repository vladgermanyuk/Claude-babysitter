import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { ActionKind, AgentRec, AgentStatus, Incident } from '../types'
import { IGNORED_TOOLS, brief, clip, detect, oneLine, redact, signature, toolInput } from './detectors'
import type { Finding, Thresholds } from './detectors'
import { correctionMessage, decide, diagnosisPrompt, isMode, respawnPrompt, retriesOf } from './interventions'
import type { Mode } from './interventions'
import { checkGuard } from './guard'
import { judgePrompt, parseVerdict } from './judge'
import type { Verdict } from './judge'
import { duration, headline, iconOf, markdown, summaryPrompt } from './report'
import type { ReportInput } from './report'

const PANE = 'babysitter'
const TICK_MS = 1000
const REPORT_SETTLE_MS = 4000


type $ = EngineInterface

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function settings(o: PluginOptions) {
  const mode: Mode = o.mode === 'kill' || o.mode === 'nudge' || o.mode === 'warn' ? o.mode : 'correct'
  const th: Thresholds = {
    loopRepeats: num(o.loopRepeats, 3),
    loopWindow: 8,
    errorStreak: num(o.errorStreak, 4),
    stallMs: num(o.stallSeconds, 180) * 1000,
    runawayMs: num(o.runawayMinutes, 15) * 60_000,
    runawayCalls: num(o.runawayCalls, 60),
    tokenBudget: typeof o.tokenBudget === 'number' && o.tokenBudget >= 0 ? o.tokenBudget : 2_000_000,
  }
  return {
    mode,
    th,
    maxRetries: typeof o.maxRetries === 'number' && o.maxRetries >= 0 ? o.maxRetries : 1,
    useHaiku: o.useHaiku !== false,
    judge: o.judge !== false,
    guard: o.guard === 'ask' || o.guard === 'off' ? o.guard : 'block',
    push: o.push !== false,
  }
}

function newAgent(id: string, num: number, now: number, fields: Pick<AgentRec, 'description' | 'type' | 'model' | 'prompt' | 'background' | 'parentId'>): AgentRec {
  return {
    ...fields,
    id,
    num,
    startedAt: now,
    lastActivityAt: now,
    endedAt: null,
    status: 'running',
    toolCalls: 0,
    errors: 0,
    consecutiveErrors: 0,
    inFlight: 0,
    recent: [],
    stage: 0,
    armedCalls: 0,
    armedAt: now,
    armedTokens: 0,
    warned: [],
    diagnosis: '',
    rootId: id,
    retryOf: null,
    pendingRespawn: null,
    answer: '',
    tokens: 0,
  }
}

// State lives in this module (one writer, no races) and is mirrored into $.state,
// which redraws the pane and outlives a hot reload: session.start reads it back.
const mem = {
  agents: {} as Record<string, AgentRec>,
  incidents: [] as Incident[],
  isEnabled: true,
  reportedIds: [] as string[],
  now: 0,
}
type Key = keyof typeof mem
let persisting: Promise<void> = Promise.resolve()

/** Writes one key to $.state, in order. The validator wants each ref spelled as a literal. */
async function writeKey($: $, key: Key): Promise<void> {
  if (key === 'agents') await $.state.set({ plugin: 'babysitter', key: 'agents' }, mem.agents)
  else if (key === 'incidents') await $.state.set({ plugin: 'babysitter', key: 'incidents' }, mem.incidents)
  else if (key === 'isEnabled') await $.state.set({ plugin: 'babysitter', key: 'isEnabled' }, mem.isEnabled)
  else if (key === 'reportedIds') await $.state.set({ plugin: 'babysitter', key: 'reportedIds' }, mem.reportedIds)
  else await $.state.set({ plugin: 'babysitter', key: 'now' }, mem.now)
}

function persist($: $, key: Key): Promise<void> {
  persisting = persisting.then(() => writeKey($, key)).catch(() => undefined)
  return persisting
}

async function hydrate($: $): Promise<void> {
  try {
    mem.agents = (await $.state.get({ plugin: 'babysitter', key: 'agents' })).value ?? mem.agents
    mem.incidents = (await $.state.get({ plugin: 'babysitter', key: 'incidents' })).value ?? mem.incidents
    mem.isEnabled = (await $.state.get({ plugin: 'babysitter', key: 'isEnabled' })).value ?? mem.isEnabled
    mem.reportedIds = (await $.state.get({ plugin: 'babysitter', key: 'reportedIds' })).value ?? mem.reportedIds
  } catch {
    // no $.state here (the test engine): start empty
  }
}

/** Subscribes a drawing to the mirrored values; the drawing itself reads mem. */
async function subscribe($: $): Promise<void> {
  try {
    await $.state.get({ plugin: 'babysitter', key: 'agents' })
    await $.state.get({ plugin: 'babysitter', key: 'incidents' })
    await $.state.get({ plugin: 'babysitter', key: 'now' })
  } catch {
    // nothing to subscribe to
  }
}

async function getAgents(_: $): Promise<Record<string, AgentRec>> {
  return mem.agents
}
async function updateAgents($: $, fn: (v: Record<string, AgentRec>) => Record<string, AgentRec>): Promise<void> {
  mem.agents = fn(mem.agents)
  await persist($, 'agents')
}
async function getIncidents(_: $): Promise<Incident[]> {
  return mem.incidents
}
async function updateIncidents($: $, fn: (v: Incident[]) => Incident[]): Promise<void> {
  mem.incidents = fn(mem.incidents)
  await persist($, 'incidents')
}
async function getEnabled(_: $): Promise<boolean> {
  return mem.isEnabled
}
async function updateEnabled($: $, fn: (v: boolean) => boolean): Promise<void> {
  mem.isEnabled = fn(mem.isEnabled)
  await persist($, 'isEnabled')
}
async function getReported(_: $): Promise<string[]> {
  return mem.reportedIds
}
async function updateReported($: $, fn: (v: string[]) => string[]): Promise<void> {
  mem.reportedIds = fn(mem.reportedIds)
  await persist($, 'reportedIds')
}
async function updateNow($: $, fn: () => number): Promise<void> {
  mem.now = fn()
  await persist($, 'now')
}

async function patch($: $, id: string, fn: (a: AgentRec) => AgentRec): Promise<void> {
  await updateAgents($, all => {
    const a = all[id]
    return a === undefined ? all : { ...all, [id]: fn(a) }
  })
}

/**
 * Taken synchronously, before any await: four agents spawned at once each get
 * their own number (reading the max from mem alone gave all four #1).
 */
let lastNum = 0
function nextNum(): number {
  lastNum = Math.max(lastNum, ...Object.values(mem.agents).map(a => a.num)) + 1
  return lastNum
}

/** How the screen names an agent: `#3 Fix flaky test`. */
function label(a: AgentRec): string {
  return `#${a.num} ${oneLine(a.description, 28)}`
}

function tokensOf(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  return u.input_tokens + u.output_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

function handbackText(input: Record<string, unknown>): string {
  const text = Object.values(input).filter((v): v is string => typeof v === 'string').join('\n')
  return oneLine(text, 2000)
}

// Module state: a reload starts it over, the session's values live in $.state.
let cfg = settings({})
/** Agents with an intervention in flight: one at a time each. */
const busy = new Set<string>()
let isTicking = false
let isReporting = false
let lastHeadline: string | undefined
/** The judge's last call, for /babysit judge. */
let lastJudge: { who: string; prompt: string; answer: string } | null = null

// ---------- bookkeeping ----------

async function incident($: $, a: AgentRec, kind: Finding['kind'] | 'guard', detail: string, action: ActionKind) {
  const at = await $.clock.now()
  await updateIncidents($, list =>
    [...list, { at, agentId: a.id, description: a.description, kind, detail: redact(detail), action }].slice(-200))
  $.ui.toast(`🍼 ${action}: ${label(a)} (${kind})`)
}

/**
 * The guard, before a subagent's call runs: null to let it run, or the refusal
 * the agent reads instead of a result. In `ask` mode the person decides.
 */
async function guardCall($: $, a: AgentRec, tool: string, input: Record<string, unknown>): Promise<string | null> {
  if (cfg.guard === 'off') return null
  let root = ''
  try {
    root = await $.session.cwd()
  } catch {
    return null
  }
  // A Write over a whole test file: read what it replaces, to count the tests it would drop.
  let current: string | null = null
  const path = input.file_path
  if (tool === 'Write' && typeof path === 'string' && /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(path)) {
    try {
      const read = await $.fs.read(path.startsWith('/') ? path : `${root}/${path}`)
      current = typeof read === 'string' ? read : null
    } catch {
      current = null
    }
  }
  const reason = checkGuard(tool, input, root, current)
  if (reason === null) return null
  const what = brief(tool, input)
  if (cfg.guard === 'ask') {
    let answer = 'Block'
    try {
      answer = await $.ui.ask(`${label(a)} wants to run ${oneLine(what, 80)}: ${reason}. Allow it?`, ['Block', 'Allow'])
    } catch {
      answer = 'Block'
    }
    if (answer === 'Allow') {
      await incident($, a, 'guard', `${what}: ${reason} (you allowed it)`, 'allowed')
      return null
    }
  }
  $.ui.log(`🛑 babysitter blocked ${label(a)}: ${oneLine(what, 100)} (${reason})`)
  await incident($, a, 'guard', `${what}: ${reason}`, 'blocked')
  return `[babysitter] Blocked: ${reason}. That is outside what this task allows without a human. Do the task another way, or stop and report that it needs a human decision.`
}

/** One line in the transcript, said before the mod acts: what it saw and what it does next. */
function announce($: $, a: AgentRec, f: Finding, doing: string) {
  $.ui.log(`🍼 ${label(a)} · ${f.kind === 'manual' ? 'you asked' : `${f.kind}: ${oneLine(f.detail, 80)}`} → ${doing}`)
}

async function refreshStatus($: $) {
  const reported = new Set(await getReported($))
  const batch = Object.values(await getAgents($)).filter(a => !reported.has(a.id))
  const running = batch.filter(a => a.status === 'running')
  if (running.length === 0) {
    $.ui.status(lastHeadline)
    return
  }
  const ids = new Set(batch.map(a => a.id))
  const needs = (await getIncidents($)).filter(i => i.action === 'needs-human' && ids.has(i.agentId)).length
  const corrected = running.filter(a => a.stage > 0).length
  const parts = [`🍼 ${running.length} running`]
  if (corrected > 0) parts.push(`${corrected} corrected`)
  if (needs > 0) parts.push(`⚠️ ${needs} need you`)
  const tokens = running.reduce((n, a) => n + a.tokens, 0)
  if (tokens > 0) parts.push(`${Math.round(tokens / 1000)}k tok`)
  try {
    const usd = (await $.session.usage()).cost?.usd
    if (usd !== undefined) parts.push(`session $${usd.toFixed(2)}`)
  } catch {
    // no cost ledger here
  }
  $.ui.status(parts.join(' · '))
}

// ---------- interventions ----------

async function diagnose($: $, a: AgentRec, f: Finding): Promise<string> {
  if (!cfg.useHaiku) return ''
  try {
    const r = await $.model.complete({ model: 'haiku', prompt: diagnosisPrompt(a, f), maxTokens: 250 })
    return r.isAnswered ? clip(r.text, 400) : ''
  } catch {
    return ''
  }
}

function stampOf(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/**
 * Step 0: before touching an agent, ask Haiku whether it is really stuck.
 * The rules are cheap and jumpy; the judge reads the actual calls. Null when
 * there is no judge (off, or no answer in the format): the rules decide alone.
 */
async function askJudge($: $, a: AgentRec, f: Finding): Promise<Verdict | null> {
  if (!cfg.useHaiku || !cfg.judge) return null
  const now = await $.clock.now()
  const prompt = judgePrompt(a, f, now)
  let answer = ''
  try {
    const r = await $.model.complete({ model: 'haiku', prompt, maxTokens: 250 })
    answer = r.isAnswered ? r.text.trim() : ''
  } catch {
    answer = ''
  }
  const verdict = parseVerdict(answer)
  lastJudge = { who: label(a), prompt, answer: answer || '(no answer)' }
  $.ui.log(verdict === null
    ? `🍼 judge on ${label(a)}: no verdict, the rules decide`
    : `🍼 judge on ${label(a)}: ${verdict.isStuck ? 'NO_PROGRESS' : 'PROGRESS'}: ${oneLine(verdict.reason, 100)}`)
  try {
    const path = `${await $.session.cwd()}/.babysitter/judge/${stampOf(now)}-${a.num}.md`
    await $.fs.write(path, `# Judge on ${label(a)}\n\n## Sent\n\n${prompt}\n\n## Answer\n\n${lastJudge.answer}\n`)
  } catch {
    // the log is for the curious; the decision stands without it
  }
  return verdict
}

/** The judge says it is moving: leave it alone and re-arm the rules from here. */
async function clear($: $, a: AgentRec, f: Finding, reason: string) {
  const now = await $.clock.now()
  await patch($, a.id, x => ({
    ...x,
    recent: [],
    consecutiveErrors: 0,
    lastActivityAt: now,
    armedAt: now,
    armedCalls: x.toolCalls,
    armedTokens: x.tokens,
  }))
  await incident($, a, f.kind, `judge: still progressing (${reason})`, 'cleared')
}

/** Step 1: write the fix into the agent's own conversation. */
async function correct($: $, a: AgentRec, f: Finding, fix = ''): Promise<boolean> {
  const diagnosis = fix !== '' ? fix : await diagnose($, a, f)
  // The judge took a few seconds and the agent kept going: count from now, not from when it was flagged.
  const fresh = mem.agents[a.id] ?? a
  const text = correctionMessage(f, diagnosis, { calls: fresh.toolCalls, errors: fresh.errors })
  let isWritten = false
  try {
    const r = await $.session.append({ agentId: a.id, message: { type: 'user', content: [{ type: 'text', text }] } })
    isWritten = !('deny' in r && r.deny !== undefined)
  } catch {
    isWritten = false
  }
  if (!isWritten) {
    await incident($, a, f.kind, `${f.detail} (could not write to the agent)`, 'warned')
    return false
  }
  const now = await $.clock.now()
  await patch($, a.id, x => ({
    ...x,
    stage: Math.max(x.stage, 1),
    diagnosis,
    recent: [],
    consecutiveErrors: 0,
    lastActivityAt: now,
    armedAt: now,
    armedCalls: x.toolCalls,
    armedTokens: x.tokens,
    warned: [],
  }))
  await incident($, a, f.kind, f.detail, 'corrected')
  return true
}

/** Step 2: stop it. */
async function kill($: $, a: AgentRec, f: Finding): Promise<boolean> {
  let isStopped = false
  try {
    const r = await $.tool.call({ tool: 'TaskStop', task_id: a.id })
    isStopped = r.deny === undefined && r.isError !== true
  } catch {
    isStopped = false
  }
  if (!isStopped) return false
  const now = await $.clock.now()
  await patch($, a.id, x => ({ ...x, status: 'killed', stage: 2, endedAt: now }))
  await incident($, a, f.kind, f.detail, 'killed')
  // The parent only hears "stopped": tell it who stopped the agent and why.
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[babysitter] I stopped background agent ${label(a)} because it was stuck (${f.kind}: ${oneLine(f.detail, 200)}). If I respawn it, I will tell you its result when it finishes.` }] } })
  } catch {
    // the transcript line and the pane already say it
  }
  return true
}

/** Starts the corrected task; null when it started, else why not. */
async function spawnRetry($: $, a: AgentRec, prompt: string): Promise<string | null> {
  const root = (await getAgents($))[a.rootId] ?? a
  let r
  try {
    r = await $.agent.spawn({ prompt, description: `↻ ${root.description}`, subagentType: a.type })
  } catch (err) {
    return String(err)
  }
  if (r.deny !== undefined) return r.deny
  await patch($, a.id, x => ({ ...x, pendingRespawn: null }))
  const id = r.agentId
  if (id === undefined) return null // started, but the engine gave no id to follow it by
  // A plugin's own spawn skips its own agent.spawn hook: record the respawn here.
  if (mem.agents[id] === undefined) {
    const num = nextNum()
    const rec = newAgent(id, num, await $.clock.now(), {
      description: `↻ ${root.description}`, type: a.type, model: r.model, prompt, background: true, parentId: a.parentId,
    })
    await updateAgents($, all => ({ ...all, [id]: rec }))
  }
  await patch($, id, x => ({ ...x, rootId: a.rootId, retryOf: a.id, description: `↻ ${root.description}` }))
  return null
}

/** Step 3: start the task again with what went wrong spelled out. */
async function respawn($: $, a: AgentRec, f: Finding, fix = '') {
  const agents = await getAgents($)
  const root = agents[a.rootId] ?? a
  const retries = retriesOf(agents, a.rootId)
  if (retries >= cfg.maxRetries) {
    announce($, a, f, `stopped for good after ${retries} respawn(s): needs you`)
    await incident($, a, f.kind, `still stuck after ${retries} respawn(s): ${f.detail}`, 'needs-human')
    return
  }
  const prompt = respawnPrompt(root.prompt, a, f, fix !== '' ? fix : await diagnose($, a, f))
  announce($, a, f, `respawning ↻ with a corrected prompt`)
  const refused = await spawnRetry($, a, prompt)
  if (refused === null) {
    await incident($, a, f.kind, 'respawned with a corrected prompt', 'respawned')
    return
  }
  await patch($, a.id, x => ({ ...x, pendingRespawn: prompt }))
  await incident($, a, f.kind, `respawn needs your OK (${oneLine(refused, 140)}). Press Respawn in /babysit`, 'needs-human')
}

/** The ladder: correct in place → kill → respawn, as the mode allows (decide() is the table). */
async function escalate($: $, id: string, f: Finding) {
  const a = (await getAgents($))[id]
  if (a === undefined || a.status !== 'running') return
  const step = decide(cfg.mode, a.stage, f.kind !== 'manual' && a.warned.includes(f.kind))

  if (step === 'skip') return

  let fix = ''
  // The budget is a hard limit the person set: no judge talks it down.
  if (f.kind !== 'manual' && f.kind !== 'budget') {
    const verdict = await askJudge($, a, f)
    if (verdict !== null && !verdict.isStuck) {
      announce($, a, f, 'judge says it is progressing: leaving it alone')
      await clear($, a, f, verdict.reason)
      return
    }
    fix = verdict?.fix ?? ''
  }

  if (step === 'warn') {
    announce($, a, f, 'flagged')
    const kind = f.kind
    if (kind !== 'manual') await patch($, id, x => ({ ...x, warned: [...x.warned, kind] }))
    await incident($, a, f.kind, f.detail, 'warned')
    return
  }
  if (step === 'correct') {
    announce($, a, f, 'correcting: writing a fix into its conversation')
    const isWritten = await correct($, a, f, fix)
    // A correction that cannot reach the agent: in correct mode, go straight to the next rung.
    if (isWritten || cfg.mode !== 'correct') return
  }
  announce($, a, f, 'killing')
  const isStopped = await kill($, a, f)
  if (isStopped && step !== 'kill') await respawn($, a, f, fix)
}

function guarded($: $, id: string, work: () => Promise<unknown>) {
  if (busy.has(id)) return
  busy.add(id)
  void work()
    .catch(err => $.ui.log(`babysitter: ${String(err)}`, { to: 'debug' }))
    .finally(() => {
      busy.delete(id)
      void refreshStatus($)
    })
}

// ---------- report ----------

async function report($: $, batch: AgentRec[], now: number): Promise<string> {
  const ids = new Set(batch.map(a => a.id))
  const incidents = (await getIncidents($)).filter(i => ids.has(i.agentId))
  let costUsd: number | null = null
  try {
    costUsd = (await $.session.usage()).cost?.usd ?? null
  } catch {
    costUsd = null
  }
  const input: ReportInput = {
    agents: [...batch].sort((x, y) => x.startedAt - y.startedAt),
    incidents,
    costUsd,
    summary: '',
    now,
  }
  if (cfg.useHaiku) {
    try {
      const r = await $.model.complete({ model: 'haiku', prompt: summaryPrompt(input), maxTokens: 300 })
      if (r.isAnswered) input.summary = r.text.trim()
    } catch {
      input.summary = ''
    }
  }
  const md = markdown(input)
  const line = headline(input)

  let savedTo = ''
  try {
    const path = `${await $.session.cwd()}/.babysitter/reports/${stampOf(now)}.md`
    await $.fs.write(path, md)
    savedTo = path
  } catch (err) {
    $.ui.log(`babysitter: could not save the report (${String(err)})`, { to: 'debug' })
  }

  try {
    const text = savedTo === '' ? md : `${md}\n\nSaved to ${savedTo}`
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
  } catch {
    $.ui.log(line)
  }
  if (cfg.push) {
    try {
      await $.tool.call({ tool: 'PushNotification', message: line, status: 'proactive' })
    } catch {
      // a push is a bonus; the toast below always shows
    }
  }
  $.ui.toast(line, { timeoutMs: 8000 })
  lastHeadline = line
  return md
}

async function maybeReport($: $, now: number) {
  if (isReporting || busy.size > 0) return
  const reported = new Set(await getReported($))
  const batch = Object.values(await getAgents($)).filter(a => !reported.has(a.id))
  if (batch.length === 0 || batch.some(a => a.status === 'running')) return
  const lastEnd = Math.max(...batch.map(a => a.endedAt ?? now))
  if (now - lastEnd < REPORT_SETTLE_MS) return

  isReporting = true
  try {
    const ids = new Set(batch.map(a => a.id))
    const hasIncident = (await getIncidents($)).some(i => ids.has(i.agentId))
    // Foreground helpers (an Explore lookup) finish all the time: report background runs and trouble only.
    if (batch.some(a => a.background) || hasIncident) await report($, batch, now)
    await updateReported($, list => [...list, ...ids].slice(-500))
  } finally {
    isReporting = false
  }
}

// ---------- the watch loop ----------

async function syncStatuses($: $, now: number) {
  let listed
  try {
    listed = await $.agent.list()
  } catch {
    return
  }
  const byId = new Map(listed.map(info => [info.id, info.status]))
  const agents = await getAgents($)
  for (const a of Object.values(agents)) {
    const status = byId.get(a.id)
    if (a.status !== 'running' || status === undefined || status === 'running') continue
    const next: AgentStatus = status === 'completed' || status === 'killed' ? status : 'failed'
    await patch($, a.id, x => ({ ...x, status: next, endedAt: x.endedAt ?? now }))
  }
}

async function tick($: $) {
  if (isTicking) return
  isTicking = true
  try {
    const now = await $.clock.now()
    await syncStatuses($, now)
    const agents = Object.values(await getAgents($))
    if (agents.some(a => a.status === 'running')) await updateNow($, () => now)
    if (await getEnabled($)) {
      for (const a of agents) {
        if (a.status !== 'running') continue
        const f = detect(a, now, cfg.th)
        if (f !== null) guarded($, a.id, () => escalate($, a.id, f))
      }
    }
    await maybeReport($, now)
    await refreshStatus($)
  } catch (err) {
    $.ui.log(`babysitter: tick failed (${String(err)})`, { to: 'debug' })
  } finally {
    isTicking = false
  }
}

export const register: Register = (on, options) => {
  cfg = settings(options)
  mem.agents = {}
  mem.incidents = []
  mem.isEnabled = true
  mem.reportedIds = []
  mem.now = 0
  lastNum = 0
  busy.clear()
  isTicking = false
  isReporting = false

  // ---------- hooks ----------

  on('session.start', async ($, e, next) => {
    await hydrate($)
    await $.command.register({
      name: 'babysit',
      description: 'Babysitter: open the agents pane (or: report · judge · on · off · mode <correct|kill|nudge|warn> · json)',
    })
    $.clock.every(TICK_MS, () => void tick($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await updateAgents($, () => ({}))
      await updateIncidents($, () => [])
      await updateReported($, () => [])
      lastNum = 0
      lastHeadline = undefined
      $.ui.status(undefined)
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.agentId === undefined) return r
    const num = nextNum()
    const rec = newAgent(r.agentId, num, await $.clock.now(), {
      description: e.description,
      type: e.subagentType,
      model: r.model,
      prompt: e.prompt,
      background: e.background,
      parentId: e.parentAgentId ?? null,
    })
    await updateAgents($, all => ({ ...all, [rec.id]: rec }))
    await refreshStatus($)
    return r
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined || (await getAgents($))[id] === undefined) return next(e)
    const input = toolInput(e as unknown as Record<string, unknown>)

    if (IGNORED_TOOLS.has(e.tool)) {
      const r = await next(e)
      if ((e.tool as string) === 'SubagentHandback') await patch($, id, a => ({ ...a, answer: handbackText(input) }))
      return r
    }

    const watched = (await getAgents($))[id]
    const refusal = watched === undefined ? null : await guardCall($, watched, e.tool, input)
    const startedAt = await $.clock.now()
    await patch($, id, a => ({ ...a, inFlight: a.inFlight + 1, lastActivityAt: startedAt }))
    let r
    try {
      r = refusal === null ? await next(e) : { deny: refusal }
    } catch (err) {
      await patch($, id, a => ({ ...a, inFlight: Math.max(0, a.inFlight - 1) }))
      throw err
    }
    const at = await $.clock.now()
    const isError = r.deny !== undefined || r.isError === true
    const out = r.deny ?? r.text ?? ''
    const call = { tool: e.tool, sig: signature(e.tool, input), brief: brief(e.tool, input), isError, out: redact(oneLine(out, 300)), at }
    await patch($, id, a => ({
      ...a,
      inFlight: Math.max(0, a.inFlight - 1),
      lastActivityAt: at,
      toolCalls: a.toolCalls + 1,
      errors: a.errors + (isError ? 1 : 0),
      consecutiveErrors: isError ? a.consecutiveErrors + 1 : 0,
      recent: [...a.recent, call].slice(-20),
    }))
    // Look now rather than at the next tick: every second the agent keeps going is another wasted call.
    $.clock.after(0, () => void tick($))
    return r
  })

  // Tokens as the agent spends them, one model request at a time (the budget detector reads them).
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const id = e.agentId
    if (id !== undefined && mem.agents[id] !== undefined && r.usage !== null) {
      const used = tokensOf(r.usage)
      await patch($, id, a => ({ ...a, tokens: a.tokens + used }))
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const id = e.agentId
    const a = id === undefined ? undefined : (await getAgents($))[id]
    if (id === undefined || a === undefined) return r

    const now = await $.clock.now()
    const used = e.usage === undefined ? 0 : tokensOf(e.usage)
    const status: AgentStatus = a.status === 'killed' || e.isAborted ? 'killed' : e.reason === 'answer' ? 'completed' : 'failed'
    const answer = e.answer !== '' ? e.answer : a.answer
    // turn.step counted as it went; the turn's own total is the floor if a step slipped by.
    await patch($, id, x => ({ ...x, status, endedAt: now, answer, tokens: Math.max(x.tokens, used), inFlight: 0 }))

    // The parent was told the first attempt was killed: hand it the respawn's answer.
    if (a.retryOf !== null && status === 'completed') {
      const text = [
        `[babysitter] "${a.description}" is a respawn of a task I stopped because it got stuck. It has now finished.`,
        answer !== '' ? `Its result:\n${answer}` : 'Its report was delivered separately.',
      ].join('\n')
      try {
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      } catch {
        $.ui.log(`babysitter: ${a.description} finished`)
      }
    }
    await refreshStatus($)
    return r
  })

  on('command.run', { command: 'babysit' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      await updateEnabled($, () => arg === 'on')
      return { text: arg === 'on' ? 'Babysitter is watching and will step in.' : 'Babysitter keeps tracking but will not step in.' }
    }
    if (arg.startsWith('mode')) {
      const mode = arg.slice(4).trim()
      if (!isMode(mode)) return { text: `Mode is ${cfg.mode}. Use /babysit mode correct | kill | nudge | warn.` }
      cfg = { ...cfg, mode }
      return { text: `Babysitter mode: ${mode} (this session).` }
    }
    if (arg === 'judge') {
      if (lastJudge === null) return { text: 'The judge has not been called yet.' }
      return { text: `Judge on ${lastJudge.who}\n\n── sent to Haiku ──\n${lastJudge.prompt}\n\n── answer ──\n${lastJudge.answer}` }
    }
    if (arg === 'json') {
      return { text: JSON.stringify({ mode: cfg.mode, settings: cfg, isEnabled: mem.isEnabled, agents: mem.agents, incidents: mem.incidents }) }
    }
    if (arg === 'report') {
      const reported = new Set(await getReported($))
      const all = Object.values(await getAgents($))
      const batch = all.filter(a => !reported.has(a.id))
      if (all.length === 0) return { text: 'No subagents yet.' }
      await report($, batch.length > 0 ? batch : all, await $.clock.now())
      return { text: 'Report written.' }
    }
    await $.ui.open({ id: PANE, title: '🍼 Babysitter' })
    return { text: 'Babysitter pane opened.' }
  })

  // ---------- the pane ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await subscribe($)
    const agents = Object.values(await getAgents($)).sort((x, y) => x.startedAt - y.startedAt)
    const incidents = await getIncidents($)
    const isEnabled = await getEnabled($)
    const now = Math.max(mem.now, ...agents.map(a => a.lastActivityAt))

    const act = (a: AgentRec, work: (fresh: AgentRec) => Promise<unknown>) => () =>
      guarded($, a.id, async () => {
        const fresh = (await getAgents($))[a.id]
        if (fresh !== undefined) await work(fresh)
      })
    const manual: Finding = { kind: 'manual', detail: 'stopped from the babysitter pane' }

    return (
      <Box flexDirection="column">
        <Text bold>
          🍼 mode: {cfg.mode}{isEnabled ? '' : ' (paused: /babysit on)'}
        </Text>
        {agents.length === 0 && <Text dimColor>No subagents yet. Start some background agents and I will watch them.</Text>}
        {agents.slice(-12).map(a => {
          const f = a.status === 'running' ? detect(a, now, cfg.th) : null
          const last = a.recent[a.recent.length - 1]
          const took = duration((a.endedAt ?? now) - a.startedAt)
          const quiet = a.status === 'running' ? ` · quiet ${duration(now - a.lastActivityAt)}` : ''
          return (
            <Box key={a.id} flexDirection="column" marginTop={1}>
              <Text>
                {iconOf(a, f !== null)} {label(a)}
              </Text>
              <Text dimColor>
                {'   '}{a.type} · {took} · {a.toolCalls} calls · {a.errors} errors · {Math.round(a.tokens / 1000)}k tok{quiet}
              </Text>
              {last !== undefined && (
                <Text dimColor>
                  {'   └ '}{last.brief}{last.isError ? ' ✗' : ''}
                </Text>
              )}
              {f !== null && (
                <Text color="yellow">
                  {'   ⚠ '}{f.kind}: {oneLine(f.detail, 90)}
                </Text>
              )}
              {a.status === 'running' && (
                <Box gap={1}>
                  <Button key={`correct-${a.id}`} label="Correct" onPress={act(a, x => correct($, x, f ?? manual))} />
                  <Button key={`respawn-${a.id}`} label="Kill & respawn" onPress={act(a, async x => (await kill($, x, f ?? manual)) && respawn($, x, f ?? manual))} />
                  <Button key={`kill-${a.id}`} label="Kill" onPress={act(a, x => kill($, x, f ?? manual))} />
                </Box>
              )}
              {a.pendingRespawn !== null && (
                <Button
                  key={`retry-${a.id}`}
                  variant="primary"
                  label="Respawn with the corrected prompt"
                  onPress={act(a, async x => {
                    const prompt = x.pendingRespawn
                    if (prompt === null) return
                    const refused = await spawnRetry($, x, prompt)
                    if (refused === null) await incident($, x, 'manual', 'respawned by you', 'respawned')
                    else $.ui.toast(`🍼 respawn refused: ${oneLine(refused, 120)}`)
                  })}
                />
              )}
            </Box>
          )
        })}
        {incidents.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Interventions</Text>
            {incidents.slice(-6).map(i => (
              <Text key={`${i.at}-${i.agentId}-${i.action}`} dimColor>
                {new Date(i.at).toTimeString().slice(0, 8)} {i.action} · {oneLine(i.description, 32)} · {i.kind}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}

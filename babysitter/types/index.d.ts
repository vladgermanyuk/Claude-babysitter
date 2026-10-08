export type AgentStatus = 'running' | 'completed' | 'failed' | 'killed'
export type DetectorKind = 'loop' | 'errors' | 'stall' | 'runaway' | 'budget'
export type ActionKind = 'warned' | 'cleared' | 'corrected' | 'killed' | 'respawned' | 'needs-human' | 'blocked' | 'allowed'

/** One tool call of a watched agent. `sig` is tool + input, for loop detection. */
export type Call = {
  tool: string
  sig: string
  brief: string
  isError: boolean
  out: string
  at: number
}

export type AgentRec = {
  id: string
  /** 1, 2, 3… in the order the session started them: what the screen calls them. */
  num: number
  description: string
  type: string
  model: string
  prompt: string
  background: boolean
  parentId: string | null
  startedAt: number
  lastActivityAt: number
  endedAt: number | null
  status: AgentStatus
  toolCalls: number
  errors: number
  consecutiveErrors: number
  inFlight: number
  recent: Call[]
  /** 0 untouched, 1 corrected in place, 2 killed */
  stage: number
  /** Calls and time the runaway budget counts from (reset by a correction). */
  armedCalls: number
  armedAt: number
  armedTokens: number
  warned: DetectorKind[]
  diagnosis: string
  /** First attempt of this task; the agent's own id unless it is a respawn. */
  rootId: string
  retryOf: string | null
  /** A corrected prompt waiting for the person's Respawn press. */
  pendingRespawn: string | null
  answer: string
  tokens: number
}

export type Incident = {
  at: number
  agentId: string
  description: string
  kind: DetectorKind | 'manual' | 'guard'
  detail: string
  action: ActionKind
}

declare module 'claude-code' {
  interface PluginState {
    babysitter: {
      agents: Record<string, AgentRec>
      incidents: Incident[]
      isEnabled: boolean
      reportedIds: string[]
      now: number
    }
  }
}

import { operationFor } from './step-probability.js'

const VALID_ROLES = new Set(['planner', 'executor', 'verifier', 'other'])
const SHELL_TOOLS = new Set(['bash', 'pwsh'])
export const STEP_OBSERVATION_VERSION = 'structured-shell-exit-v1'

export function inferRole(agentPreset, roleByPreset = {}) {
  if (typeof agentPreset !== 'string' || agentPreset.length === 0) return 'other'
  if (Object.prototype.hasOwnProperty.call(roleByPreset, agentPreset)) {
    return roleByPreset[agentPreset]
  }
  const name = agentPreset.toLowerCase()
  if (['planner', 'planning', 'orchestrator', 'coordinator'].some(part => name.includes(part))) {
    return 'planner'
  }
  if (['verifier', 'verification', 'reviewer', 'auditor'].some(part => name.includes(part))) {
    return 'verifier'
  }
  if (['executor', 'browser', 'web', 'coder', 'coding', 'operator', 'tool'].some(part => name.includes(part))) {
    return 'executor'
  }
  return 'other'
}

export function validateRoleMap(roleByPreset) {
  if (roleByPreset === null || typeof roleByPreset !== 'object' || Array.isArray(roleByPreset)) {
    throw new TypeError('roleByPreset must be an object')
  }
  for (const [preset, role] of Object.entries(roleByPreset)) {
    if (preset.length === 0 || !VALID_ROLES.has(role)) {
      throw new RangeError('roleByPreset contains an invalid preset or role')
    }
  }
}

export function createFeatureCollector(roleByPreset = {}) {
  validateRoleMap(roleByPreset)
  // A DSH agent executes one step at a time. Keep only that step, with a
  // completed position for deduplication; never retain raw event objects.
  const sessions = new Map()
  const safeName = value => typeof value === 'string'
    ? value.replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 128) : ''
  const validPosition = (sessionId, turn, step) => typeof sessionId === 'string'
    && sessionId.length > 0 && sessionId.length <= 512
    && Number.isSafeInteger(turn) && turn >= 0 && Number.isSafeInteger(step) && step >= 0

  function stateFor(sessionId, turn, step) {
    if (!validPosition(sessionId, turn, step)) return null
    let state = sessions.get(sessionId)
    if (state) {
      const comparison = turn === state.turn ? step - state.step : turn - state.turn
      if (comparison < 0 || (comparison === 0 && state.ended)) return null
      if (comparison === 0) return state
    }
    state = { turn, step, evidence: new Set(), calls: new Map(), results: new Map(), shellResults: new Map(),
      ended: false, overflow: false, unpairedResult: false }
    sessions.delete(sessionId)
    sessions.set(sessionId, state)
    if (sessions.size > 1024) sessions.delete(sessions.keys().next().value)
    return state
  }

  function addEvidence(sessionId, turn, step, code) {
    stateFor(sessionId, turn, step)?.evidence.add(code)
  }

  function observeToolResult(exec, result) {
    const sessionId = exec?.agent?.session?.id
    const state = sessions.get(sessionId)
    const callId = exec?.callId
    if (!state || state.ended || exec?.parent !== undefined
      || typeof callId !== 'string' || callId.length > 512) return
    const name = state.calls.get(callId)
    if (!SHELL_TOOLS.has(name) || exec.name !== name || result?.isError !== false) return
    const value = result.value
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.kind !== 'foreground') return
    let verdict = 'unknown'
    if (value.timedOut === false && value.aborted === false && value.signal === null
      && value.stopped === undefined && value.sandbox?.denied !== true
      && value.sandbox?.runnerFailed !== true && Number.isSafeInteger(value.exitCode)) {
      verdict = value.exitCode === 0 ? 'success' : 'error'
    }
    state.shellResults.set(callId, verdict)
  }

  function observeSessionEvent(session, event) {
    const sessionId = session?.id
    const { turn, step } = event?.data ?? {}
    if (!['step/start', 'tool/call', 'tool/result', 'assistant/message', 'assistant/attempt', 'step/end'].includes(event?.type)) return null
    const state = stateFor(sessionId, turn, step)
    if (!state) return null
    if (event.type === 'tool/call') {
      const id = event.data.callId
      if (typeof id === 'string' && id.length <= 512 && state.calls.size < 1024)
        state.calls.set(id, safeName(event.data.name))
      else state.overflow = true
    }
    if (event.type === 'tool/result') {
      const message = event.data.message
      const rawId = message?.source?.callId
      if (typeof rawId !== 'string' || rawId.length > 512) state.unpairedResult = true
      const id = typeof rawId === 'string' && rawId.length <= 512 ? rawId
        : 'unpaired:' + (Number.isSafeInteger(event.seq) ? event.seq : state.results.size)
      const name = state.calls.get(id)
      const verdict = message?.isError === true ? 'error'
        : message?.isError === false
          ? SHELL_TOOLS.has(name) ? state.shellResults.get(id) ?? 'unknown' : 'success'
          : 'unknown'
      if (verdict === 'error') state.evidence.add('tool_error')
      if (state.results.size < 1024 || state.results.has(id)) {
        // A contradictory duplicate cannot erase a structured failure.
        if (state.results.get(id) !== 'error') state.results.set(id, verdict)
      } else state.overflow = true
    }
    if (event?.type === 'assistant/message' && event.data.interrupted === true) {
      state.evidence.add('interrupted')
    }
    if (event?.type === 'assistant/attempt') {
      state.evidence.add('model_attempt')
    }
    if (event?.type !== 'step/end') return null
    state.ended = true
    const evidenceCodes = [...state.evidence]
    const ids = new Set([...state.calls.keys(), ...state.results.keys()])
    const terminalError = state.evidence.has('agent_error')
    const failedIds = [...ids].filter(id => state.results.get(id) === 'error')
    const outcome = terminalError || failedIds.length > 0 ? 'error'
      : state.calls.size > 0 && state.calls.size === ids.size
        && !state.unpairedResult && !state.overflow && !state.evidence.has('interrupted')
        && [...ids].every(id => state.results.get(id) === 'success') ? 'success' : 'unknown'
    const relevant = failedIds.length ? failedIds : [...ids]
    const operations = new Set(relevant.map(id => operationFor({ toolName: state.calls.get(id) })))
    const operation = !terminalError && !state.overflow && operations.size === 1 ? [...operations][0] : 'unknown'
    const depth = session.header?.delegationDepth
    const parent = session.header?.parentSession
    const parentSessionId = typeof parent === 'string' && parent.length > 0
      && parent.length <= 512 && !/[\u0000-\u001f\u007f]/.test(parent)
      && parent !== sessionId ? parent : null
    return {
      sessionId,
      ...(parentSessionId === null ? {} : { parentSessionId }),
      turn,
      step,
      observationVersion: STEP_OBSERVATION_VERSION,
      role: inferRole(session.header?.agentPreset, roleByPreset),
      delegationDepth: Number.isSafeInteger(depth) && depth >= 0 ? depth : 0,
      evidenceCodes,
      outcome,
      operation,
      toolNames: [...new Set(state.calls.values())].filter(Boolean).slice(0, 128),
      toolCount: ids.size,
    }
  }

  function observeRequestError(payload) {
    addEvidence(payload?.agent?.session?.id, payload?.turn, payload?.step, 'request_error')
  }

  function observeAgentError(payload) {
    addEvidence(payload?.agent?.session?.id, payload?.turn, payload?.step, 'agent_error')
  }

  function forgetSession(sessionId) {
    sessions.delete(sessionId)
  }

  return { observeSessionEvent, observeToolResult, observeRequestError, observeAgentError, forgetSession }
}

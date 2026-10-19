#!/usr/bin/env node
// GFA-only evidence-disclosure replay. Claims stay unadjudicated in this log.
import { performance } from 'node:perf_hooks'
import { createEvidenceStore } from './gfa-inspection-evidence.mjs'

const MODES = new Set(['ranked', 'chronological', 'self_directed'])
const DEFAULT_LIMITS = { maxDistinctSteps: 30, maxElapsedMs: 600000,
  maxCalls: 120 }

function addUsage(total, usage) {
  if (!usage) return
  for (const key of ['input_tokens', 'output_tokens']) {
    if (!Number.isInteger(usage[key]) || usage[key] < 0)
      throw new Error('invalid_model_usage')
    total[key] += usage[key]
  }
  total.total_tokens = total.input_tokens + total.output_tokens
}

function disclosedRefs(piece) {
  if (!piece) return []
  if (piece.kind === 'step') return [
    ...piece.fields.filter(row => row.inline !== null)
      .map(row => `${piece.step}:${row.name}:0`),
    ...piece.images.map(row => `${piece.step}:image:${row.sha256}`),
  ]
  return [`${piece.step}:${piece.field}:${piece.chunkIndex}`]
}

function checkClaimRefs(checkpoint, visibleRefs) {
  for (const claim of [checkpoint?.actionable, checkpoint?.chain]) {
    if (claim === null || claim === undefined) continue
    if (!Array.isArray(claim.refs) || !claim.refs.length
      || claim.refs.some(ref => typeof ref !== 'string' || !visibleRefs.has(ref)))
      throw new Error('undisclosed_evidence_reference')
  }
}

export async function runJourney(item, mode, investigator, evidenceStore,
  options = {}) {
  if (!MODES.has(mode) || typeof investigator !== 'function'
    || !evidenceStore) throw new Error('invalid_journey_input')
  const limits = { ...DEFAULT_LIMITS, ...options }
  if (![limits.maxDistinctSteps, limits.maxElapsedMs, limits.maxCalls]
    .every(value => Number.isInteger(value) && value > 0))
    throw new Error('invalid_journey_limits')
  const clock = options.clock ?? (() => performance.now())
  const started = clock()
  const index = evidenceStore.index()
  const opened = new Set(), openedSteps = [], visibleRefs = new Set()
  const events = [], checkpoints = []
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  let lastEvidence = null, afterStep = null, memo = '', termination = null
  let actionError = null
  let transmittedImages = 0, transmittedImageBytes = 0, modelElapsedMs = 0
  for (let callIndex = 0; callIndex < limits.maxCalls; callIndex++) {
    const recommendations = evidenceStore.recommend(mode, opened)
    const result = await investigator({ caseId: item.id, task: item.instruction,
      mode, index, recommendations, openedSteps: [...openedSteps],
      visibleRefs: [...visibleRefs], memo, lastEvidence, actionError, callIndex })
    if (!result || !result.decision) throw new Error('invalid_investigator_result')
    const decision = result.decision
    addUsage(usage, result.usage)
    if (Number.isFinite(result.modelElapsedMs)) modelElapsedMs += result.modelElapsedMs
    if (lastEvidence?.kind === 'step') {
      transmittedImages += lastEvidence.images.length
      transmittedImageBytes += lastEvidence.images.reduce((sum, row) => sum + row.bytes, 0)
    }
    const elapsedMs = Math.round(clock() - started + (options.setupMs ?? 0) + (mode === 'ranked'
      ? item.proxyScoringMs ?? 0 : 0))
    if (typeof decision.memo !== 'string' || Array.from(decision.memo).length > 8000)
      throw new Error('invalid_investigation_memo')
    memo = decision.memo
    if (lastEvidence) {
      if (!decision.checkpoint || typeof decision.checkpoint !== 'object')
        throw new Error('checkpoint_required_after_evidence')
      checkClaimRefs(decision.checkpoint, visibleRefs)
      checkpoints.push({ index: checkpoints.length, afterStep,
        openedSteps: [...openedSteps], distinctSteps: opened.size,
        elapsedMs, actionable: decision.checkpoint.actionable ?? null,
        chain: decision.checkpoint.chain ?? null,
        visibleRefs: [...visibleRefs] })
    } else if (decision.checkpoint) throw new Error('claim_before_evidence')
    const event = { callIndex, action: decision.action,
      step: decision.step ?? null, field: decision.field ?? null,
      chunkIndex: decision.chunkIndex ?? null, elapsedMs,
      recommendations, openedCount: opened.size, usage: result.usage ?? null,
      memo, protocolViolations: result.protocolViolations ?? [] }
    events.push(event)
    if (elapsedMs >= limits.maxElapsedMs) {
      termination = 'time_budget'; break
    }
    if (decision.action === 'finish') {
      termination = 'investigator_finished'; break
    }
    if (callIndex === limits.maxCalls - 1) {
      termination = 'model_call_budget'; break
    }
    if (decision.action === 'open_step') {
      if (opened.size >= limits.maxDistinctSteps) {
        termination = 'step_budget'; break
      }
      if (!Number.isInteger(decision.step) || opened.has(decision.step)
        || !index.some(row => row.step === decision.step)) {
        actionError = 'invalid_open_step: choose an existing step that has not been opened'
        event.protocolViolations.push('invalid_open_step')
        lastEvidence = null
        continue
      }
      const openedEvidence = await evidenceStore.openStep(decision.step)
      actionError = null
      opened.add(decision.step); openedSteps.push(decision.step)
      lastEvidence = { kind: 'step', ...openedEvidence }
      event.disclosed = { step: decision.step,
        fields: openedEvidence.fields.map(row => ({ name: row.name,
          sha256: row.sha256, codePoints: row.codePoints,
          chunks: row.chunks, inline: row.inline !== null })),
        images: openedEvidence.images.map(row => ({ phase: row.phase,
          sha256: row.sha256, bytes: row.bytes })) }
      afterStep = decision.step
    } else if (decision.action === 'read_chunk') {
      if (!opened.has(decision.step)) {
        actionError = 'chunk_before_step_open: open the step before reading its field'
        event.protocolViolations.push('chunk_before_step_open')
        lastEvidence = null
        continue
      }
      try {
        lastEvidence = { kind: 'chunk', ...evidenceStore.readChunk(decision.step,
          decision.field, decision.chunkIndex) }
      } catch (error) {
        if (error.message !== 'unknown_field_chunk') throw error
        actionError = 'unknown_field_chunk: choose a disclosed field and valid chunk index'
        event.protocolViolations.push('unknown_field_chunk')
        lastEvidence = null
        continue
      }
      actionError = null
      event.disclosed = { step: decision.step, field: decision.field,
        chunkIndex: decision.chunkIndex,
        sourceSha256: lastEvidence.sourceSha256,
        codePoints: Array.from(lastEvidence.text).length }
      afterStep = decision.step
    } else throw new Error('invalid_investigation_action')
    for (const ref of disclosedRefs(lastEvidence)) visibleRefs.add(ref)
  }
  return { caseId: item.id, mode, events, checkpoints, openedSteps,
    termination: termination ?? 'model_call_budget', usage, modelElapsedMs,
    totalElapsedMs: Math.round(clock() - started + (options.setupMs ?? 0) + (mode === 'ranked'
      ? item.proxyScoringMs ?? 0 : 0)), setupMs: options.setupMs ?? 0,
    scoringMs: mode === 'ranked'
      ? item.proxyScoringMs ?? 0 : 0,
    transmittedImages, transmittedImageBytes,
    scoreSource: mode === 'ranked' ? 'gfa_inspection_proxy_v2' : null }
}

export { createEvidenceStore }

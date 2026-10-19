import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { STEP_OBSERVATION_VERSION } from './features.js'

export const TURN_RISK_MODEL_VERSION = 'turn-failure-empirical-v2'
export const TURN_RISK_FEATURE_VERSION = 'turn-prefix-structured-v2'

const HORIZON = 'turn_final_failure'
const MODEL_SCHEMA_VERSION = 1
const MAX_MODEL_BYTES = 256 * 1024
const MAX_PREFIX_ROWS = 1000
const MAX_LABELED_TURNS = 50_000
const MIN_LABELED_TURNS = 100
const MIN_HOLDOUT_TURNS = 30
const MIN_TRAIN_CLASS = 10
const MIN_HOLDOUT_CLASS = 5
const PRIOR_STRENGTH = 4
const MIN_EXACT_SUPPORT = 10
const MIN_BROAD_SUPPORT = 20
const SCORE_EPSILON = 1e-12
const COUNT_BUCKETS = new Set(['0', '1', '2-3', '4+'])
const ERROR_CLASSES = new Set(['none', 'probe', 'unknown', 'action'])
const OUTCOMES = new Set(['success', 'error', 'unknown'])
const OPERATIONS = new Set(['action', 'read', 'verification', 'unknown'])
const RANK = { none: 0, probe: 1, unknown: 2, action: 3 }
const ISO_COMPLETED_AT = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0
const exactKeys = (value, keys) => isRecord(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const classCounts = turns => ({
  success: turns.filter(turn => turn.outcome === 'success').length,
  failure: turns.filter(turn => turn.outcome === 'failure').length,
})
const countBucket = count => count === 0 ? '0' : count === 1 ? '1' : count <= 3 ? '2-3' : '4+'
const exactKey = summary => [summary.completedSteps, summary.maxError, Number(summary.requestError)].join('|')
const broadKey = summary => [summary.maxError, Number(summary.requestError)].join('|')

function stepFact(row) {
  if (!isRecord(row) || typeof row.sessionId !== 'string' || row.sessionId.length === 0
    || row.sessionId.length > 512 || /[\u0000-\u001f\u007f]/.test(row.sessionId)
    || !nonnegativeInteger(row.turn) || !nonnegativeInteger(row.step)
    || !OUTCOMES.has(row.outcome) || !OPERATIONS.has(row.operation)
    || !Array.isArray(row.evidenceCodes) || row.evidenceCodes.length > 32
    || row.evidenceCodes.some(code => typeof code !== 'string')) {
    throw new TypeError('invalid structured step fact')
  }
  const revision = row.revision ?? 0
  if (!nonnegativeInteger(revision)) throw new TypeError('invalid structured step revision')
  return {
    sessionId: row.sessionId, turn: row.turn, step: row.step, revision,
    outcome: row.outcome, operation: row.operation,
    requestError: row.evidenceCodes.includes('request_error'),
    legacyObservation: row.observationVersion !== STEP_OBSERVATION_VERSION,
  }
}

function latestSteps(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_PREFIX_ROWS) {
    throw new RangeError('turn prefix must contain at most 1000 structured steps')
  }
  const latest = new Map()
  let scope
  for (const row of rows) {
    const fact = stepFact(row)
    const key = fact.sessionId + '\u0000' + fact.turn
    if (scope === undefined) scope = key
    else if (scope !== key) throw new TypeError('turn prefix spans multiple sessions or turns')
    const previous = latest.get(fact.step)
    if (!previous || fact.revision >= previous.revision) latest.set(fact.step, fact)
  }
  return [...latest.values()].sort((a, b) => a.step - b.step)
}

// The rc.2 AgentLoop numbers each turn's completed steps from 1 without gaps.
// Retention can remove the start of a long turn, so absence must abstain.
function hasCompletePrefix(steps, expectedNextStep = null) {
  if (expectedNextStep !== null && (!nonnegativeInteger(expectedNextStep)
    || expectedNextStep !== steps.length + 1)) return false
  return steps.every((fact, index) => fact.step === index + 1)
}

function errorClass(fact) {
  if (fact.outcome !== 'error') return 'none'
  if (fact.operation === 'action') return 'action'
  if (fact.operation === 'read' || fact.operation === 'verification') return 'probe'
  return 'unknown'
}

function summariesForSteps(steps) {
  const summaries = [{ completedSteps: '0', maxError: 'none', requestError: false }]
  let maxError = 'none'
  let requestError = false
  for (let index = 0; index < steps.length; index += 1) {
    const observed = errorClass(steps[index])
    if (RANK[observed] > RANK[maxError]) maxError = observed
    requestError ||= steps[index].requestError
    summaries.push({ completedSteps: countBucket(index + 1), maxError, requestError })
  }
  return summaries
}

/** Accept explicit ISO 8601 completion instants, including a declared UTC offset. */
export function normalizeCompletedAt(value) {
  if (typeof value !== 'string' || value.length > 40 || !ISO_COMPLETED_AT.test(value)) return null
  try {
    const calendarDay = value.slice(0, 10)
    const midnight = new Date(`${calendarDay}T00:00:00.000Z`)
    const instant = new Date(value)
    if (!Number.isFinite(midnight.getTime()) || !Number.isFinite(instant.getTime())
      || midnight.toISOString().slice(0, 10) !== calendarDay) return null
    return instant.toISOString()
  } catch { return null }
}

/** Bounded observations from the completed steps of exactly one turn. */
export function summarizeTurnPrefix(rows) {
  const summaries = summariesForSteps(latestSteps(rows))
  return summaries[summaries.length - 1]
}

function normalizedTurn(raw) {
  const completedAt = normalizeCompletedAt(raw?.completedAt)
  if (!isRecord(raw) || typeof raw.sessionId !== 'string' || raw.sessionId.length === 0
    || raw.sessionId.length > 512 || /[\u0000-\u001f\u007f]/.test(raw.sessionId)
    || !nonnegativeInteger(raw.turn) || !['success', 'failure'].includes(raw.outcome)
    || completedAt === null) {
    throw new TypeError('invalid manually labeled turn')
  }
  const steps = latestSteps(raw.steps)
  if (steps.some(step => step.sessionId !== raw.sessionId || step.turn !== raw.turn)) {
    throw new TypeError('labeled turn and structured steps disagree')
  }
  if (!hasCompletePrefix(steps)) throw new TypeError('labeled turn has an incomplete step prefix')
  if (steps.some(step => step.legacyObservation)) throw new TypeError('labeled turn has a legacy step observation')
  return {
    sessionId: raw.sessionId, turn: raw.turn, outcome: raw.outcome,
    completedAtMs: Date.parse(completedAt), steps,
  }
}

function emptyReport(labeledTurns) {
  return {
    status: 'ineligible', eligible: false, reasons: [],
    labeledTurns, trainingTurns: 0, holdoutTurns: 0,
    trainingSessions: 0, holdoutSessions: 0,
    classCounts: {
      training: { success: 0, failure: 0 },
      holdout: { success: 0, failure: 0 },
    },
    metrics: null,
  }
}

function chronologicalSplit(turns) {
  const bySession = new Map()
  for (const turn of turns) {
    let group = bySession.get(turn.sessionId)
    if (!group) {
      group = {
        sessionId: turn.sessionId,
        firstCompletedAtMs: turn.completedAtMs,
        lastCompletedAtMs: turn.completedAtMs,
        turns: [],
      }
      bySession.set(turn.sessionId, group)
    }
    group.turns.push(turn)
    group.firstCompletedAtMs = Math.min(group.firstCompletedAtMs, turn.completedAtMs)
    group.lastCompletedAtMs = Math.max(group.lastCompletedAtMs, turn.completedAtMs)
  }
  const groups = [...bySession.values()].sort((a, b) =>
    a.lastCompletedAtMs - b.lastCompletedAtMs || a.sessionId.localeCompare(b.sessionId))
  const target = Math.max(MIN_HOLDOUT_TURNS, Math.ceil(turns.length * 0.3))
  let start = groups.length
  let heldOut = 0
  while (start > 0 && heldOut < target) {
    start -= 1
    heldOut += groups[start].turns.length
  }
  // No training turn may finish at or after the earliest held-out turn.
  let firstHeldOut = groups.slice(start).reduce((earliest, group) =>
    Math.min(earliest, group.firstCompletedAtMs), Infinity)
  while (start > 0 && groups[start - 1].lastCompletedAtMs >= firstHeldOut) {
    start -= 1
    firstHeldOut = Math.min(firstHeldOut, groups[start].firstCompletedAtMs)
  }
  return {
    trainingGroups: groups.slice(0, start),
    holdoutGroups: groups.slice(start),
  }
}

function addBucket(map, key, features, outcome) {
  let bucket = map.get(key)
  if (!bucket) {
    bucket = { ...features, count: 0, failures: 0 }
    map.set(key, bucket)
  }
  bucket.count += 1
  if (outcome === 'failure') bucket.failures += 1
}

function fittedTables(trainingTurns) {
  const failures = classCounts(trainingTurns).failure
  const global = { count: trainingTurns.length, failures, rate: failures / trainingTurns.length }
  const exact = new Map()
  const broad = new Map()
  for (const turn of trainingTurns) {
    const seenExact = new Set()
    const seenBroad = new Set()
    for (const summary of summariesForSteps(turn.steps)) {
      const eKey = exactKey(summary)
      if (!seenExact.has(eKey)) {
        addBucket(exact, eKey, summary, turn.outcome)
        seenExact.add(eKey)
      }
      const bKey = broadKey(summary)
      if (!seenBroad.has(bKey)) {
        addBucket(broad, bKey, {
          maxError: summary.maxError, requestError: summary.requestError,
        }, turn.outcome)
        seenBroad.add(bKey)
      }
    }
  }
  const sorted = map => [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value)
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    modelVersion: TURN_RISK_MODEL_VERSION,
    featureVersion: TURN_RISK_FEATURE_VERSION,
    horizon: HORIZON,
    global,
    smoothing: {
      priorStrength: PRIOR_STRENGTH,
      minExactSupport: MIN_EXACT_SUPPORT,
      minBroadSupport: MIN_BROAD_SUPPORT,
    },
    exactBuckets: sorted(exact),
    broadBuckets: sorted(broad),
  }
}

function estimateFromSummary(model, summary) {
  const exact = model.exactBuckets.find(bucket => bucket.completedSteps === summary.completedSteps
    && bucket.maxError === summary.maxError && bucket.requestError === summary.requestError)
  const broad = model.broadBuckets.find(bucket => bucket.maxError === summary.maxError
    && bucket.requestError === summary.requestError)
  const bucket = exact?.count >= MIN_EXACT_SUPPORT ? exact
    : broad?.count >= MIN_BROAD_SUPPORT ? broad : model.global
  const value = bucket === model.global ? model.global.rate
    : (bucket.failures + PRIOR_STRENGTH * model.global.rate) / (bucket.count + PRIOR_STRENGTH)
  return { value, support: bucket.count }
}

const clipped = value => Math.max(1e-12, Math.min(1 - 1e-12, value))
const logLoss = (value, label) => -label * Math.log(clipped(value))
  - (1 - label) * Math.log(1 - clipped(value))

function holdoutMetrics(model, holdoutTurns) {
  const bins = Array.from({ length: 5 }, () => ({ weight: 0, predicted: 0, observed: 0 }))
  const result = {
    model: { brier: 0, logLoss: 0, ece5: 0 },
    baseline: { brier: 0, logLoss: 0 },
  }
  for (const turn of holdoutTurns) {
    const label = turn.outcome === 'failure' ? 1 : 0
    const summaries = summariesForSteps(turn.steps)
    const weight = 1 / summaries.length
    for (const summary of summaries) {
      const value = estimateFromSummary(model, summary).value
      const baseline = model.global.rate
      result.model.brier += weight * (value - label) ** 2
      result.model.logLoss += weight * logLoss(value, label)
      result.baseline.brier += weight * (baseline - label) ** 2
      result.baseline.logLoss += weight * logLoss(baseline, label)
      // Include exactly 1.0 in the fifth calibration bin.
      const bin = bins[Math.min(4, Math.floor(value * 5))]
      bin.weight += weight
      bin.predicted += weight * value
      bin.observed += weight * label
    }
  }
  const turns = holdoutTurns.length
  for (const metrics of [result.model, result.baseline]) {
    metrics.brier /= turns
    metrics.logLoss /= turns
  }
  result.model.ece5 = bins.reduce((total, bin) =>
    total + Math.abs(bin.predicted - bin.observed) / turns, 0)
  return result
}

/** Fit aggregate frequencies from explicit turn labels and gate on later whole sessions. */
export function trainTurnRiskModel(labeledTurns) {
  if (!Array.isArray(labeledTurns) || labeledTurns.length > MAX_LABELED_TURNS) {
    throw new RangeError('labeled turns must be a bounded array')
  }
  const turns = labeledTurns.map(normalizedTurn)
  const seen = new Set()
  for (const turn of turns) {
    const key = turn.sessionId + '\u0000' + turn.turn
    if (seen.has(key)) throw new TypeError('duplicate manually labeled turn')
    seen.add(key)
  }
  const report = emptyReport(turns.length)
  if (turns.length < MIN_LABELED_TURNS) {
    report.reasons.push('insufficient_labeled_turns')
    return { eligible: false, model: null, report }
  }
  const split = chronologicalSplit(turns)
  const training = split.trainingGroups.flatMap(group => group.turns)
  const holdout = split.holdoutGroups.flatMap(group => group.turns)
  report.trainingTurns = training.length
  report.holdoutTurns = holdout.length
  report.trainingSessions = split.trainingGroups.length
  report.holdoutSessions = split.holdoutGroups.length
  report.classCounts = { training: classCounts(training), holdout: classCounts(holdout) }
  if (holdout.length < MIN_HOLDOUT_TURNS || training.length === 0) {
    report.reasons.push('insufficient_temporal_split')
  }
  if (report.classCounts.training.success < MIN_TRAIN_CLASS
    || report.classCounts.training.failure < MIN_TRAIN_CLASS
    || report.classCounts.holdout.success < MIN_HOLDOUT_CLASS
    || report.classCounts.holdout.failure < MIN_HOLDOUT_CLASS) {
    report.reasons.push('insufficient_class_support')
  }
  if (report.reasons.length) return { eligible: false, model: null, report }

  const candidate = fittedTables(training)
  report.metrics = holdoutMetrics(candidate, holdout)
  if (report.metrics.model.brier > report.metrics.baseline.brier + SCORE_EPSILON) {
    report.reasons.push('holdout_brier_worse_than_baseline')
  }
  if (report.metrics.model.logLoss > report.metrics.baseline.logLoss + SCORE_EPSILON) {
    report.reasons.push('holdout_log_loss_worse_than_baseline')
  }
  if (report.metrics.model.ece5 > 0.10 + SCORE_EPSILON) {
    report.reasons.push('holdout_calibration_error')
  }
  if (report.reasons.length) return { eligible: false, model: null, report }
  report.status = 'eligible'
  report.eligible = true
  const model = {
    ...candidate,
    gate: {
      eligible: true,
      trainingTurns: report.trainingTurns,
      holdoutTurns: report.holdoutTurns,
      trainingSessions: report.trainingSessions,
      holdoutSessions: report.holdoutSessions,
      classCounts: structuredClone(report.classCounts),
      metrics: structuredClone(report.metrics),
    },
  }
  return { eligible: true, model, report }
}

function sanitizedBucket(raw, broad, maxCount) {
  const keys = broad
    ? ['maxError', 'requestError', 'count', 'failures']
    : ['completedSteps', 'maxError', 'requestError', 'count', 'failures']
  if (!exactKeys(raw, keys) || (!broad && !COUNT_BUCKETS.has(raw.completedSteps))
    || !ERROR_CLASSES.has(raw.maxError) || typeof raw.requestError !== 'boolean'
    || !Number.isSafeInteger(raw.count) || raw.count < 1 || raw.count > maxCount
    || !nonnegativeInteger(raw.failures) || raw.failures > raw.count) return null
  return broad
    ? { maxError: raw.maxError, requestError: raw.requestError, count: raw.count, failures: raw.failures }
    : { completedSteps: raw.completedSteps, maxError: raw.maxError,
      requestError: raw.requestError, count: raw.count, failures: raw.failures }
}

function sanitizedMetric(raw, ece = false) {
  if (!exactKeys(raw, ece ? ['brier', 'logLoss', 'ece5'] : ['brier', 'logLoss'])) return null
  if (typeof raw.brier !== 'number' || !Number.isFinite(raw.brier) || raw.brier < 0 || raw.brier > 1
    || typeof raw.logLoss !== 'number' || !Number.isFinite(raw.logLoss) || raw.logLoss < 0) return null
  if (ece && (typeof raw.ece5 !== 'number' || !Number.isFinite(raw.ece5)
    || raw.ece5 < 0 || raw.ece5 > 1)) return null
  return ece
    ? { brier: raw.brier, logLoss: raw.logLoss, ece5: raw.ece5 }
    : { brier: raw.brier, logLoss: raw.logLoss }
}

function sanitizedClassCounts(raw, expected) {
  if (!exactKeys(raw, ['success', 'failure'])
    || !nonnegativeInteger(raw.success) || !nonnegativeInteger(raw.failure)
    || raw.success + raw.failure !== expected) return null
  return { success: raw.success, failure: raw.failure }
}

function sanitizedModel(raw) {
  if (!exactKeys(raw, [
    'schemaVersion', 'modelVersion', 'featureVersion', 'horizon', 'global',
    'smoothing', 'exactBuckets', 'broadBuckets', 'gate',
  ]) || raw.schemaVersion !== MODEL_SCHEMA_VERSION
    || raw.modelVersion !== TURN_RISK_MODEL_VERSION
    || raw.featureVersion !== TURN_RISK_FEATURE_VERSION || raw.horizon !== HORIZON
    || !exactKeys(raw.global, ['count', 'failures', 'rate'])
    || !Number.isSafeInteger(raw.global.count) || raw.global.count < 1
    || raw.global.count > MAX_LABELED_TURNS || !nonnegativeInteger(raw.global.failures)
    || raw.global.failures > raw.global.count
    || typeof raw.global.rate !== 'number' || !Number.isFinite(raw.global.rate)
    || raw.global.rate !== raw.global.failures / raw.global.count
    || !exactKeys(raw.smoothing, ['priorStrength', 'minExactSupport', 'minBroadSupport'])
    || raw.smoothing.priorStrength !== PRIOR_STRENGTH
    || raw.smoothing.minExactSupport !== MIN_EXACT_SUPPORT
    || raw.smoothing.minBroadSupport !== MIN_BROAD_SUPPORT
    || !Array.isArray(raw.exactBuckets) || raw.exactBuckets.length > 32
    || !Array.isArray(raw.broadBuckets) || raw.broadBuckets.length > 8) return null
  const exactBuckets = raw.exactBuckets.map(bucket => sanitizedBucket(bucket, false, raw.global.count))
  const broadBuckets = raw.broadBuckets.map(bucket => sanitizedBucket(bucket, true, raw.global.count))
  if (exactBuckets.includes(null) || broadBuckets.includes(null)) return null
  if (new Set(exactBuckets.map(exactKey)).size !== exactBuckets.length
    || new Set(broadBuckets.map(broadKey)).size !== broadBuckets.length) return null
  const gate = raw.gate
  if (!exactKeys(gate, [
    'eligible', 'trainingTurns', 'holdoutTurns', 'trainingSessions',
    'holdoutSessions', 'classCounts', 'metrics',
  ]) || gate.eligible !== true || gate.trainingTurns !== raw.global.count
    || !nonnegativeInteger(gate.holdoutTurns)
    || gate.trainingTurns + gate.holdoutTurns < MIN_LABELED_TURNS
    || gate.holdoutTurns < MIN_HOLDOUT_TURNS
    || !Number.isSafeInteger(gate.trainingSessions) || gate.trainingSessions < 1
    || gate.trainingSessions > gate.trainingTurns
    || !Number.isSafeInteger(gate.holdoutSessions) || gate.holdoutSessions < 1
    || gate.holdoutSessions > gate.holdoutTurns
    || !exactKeys(gate.classCounts, ['training', 'holdout'])
    || !exactKeys(gate.metrics, ['model', 'baseline'])) return null
  const trainingCounts = sanitizedClassCounts(gate.classCounts.training, gate.trainingTurns)
  const holdoutCounts = sanitizedClassCounts(gate.classCounts.holdout, gate.holdoutTurns)
  const modelMetrics = sanitizedMetric(gate.metrics.model, true)
  const baselineMetrics = sanitizedMetric(gate.metrics.baseline)
  if (!trainingCounts || !holdoutCounts || !modelMetrics || !baselineMetrics
    || trainingCounts.failure !== raw.global.failures
    || trainingCounts.success < MIN_TRAIN_CLASS || trainingCounts.failure < MIN_TRAIN_CLASS
    || holdoutCounts.success < MIN_HOLDOUT_CLASS || holdoutCounts.failure < MIN_HOLDOUT_CLASS
    || modelMetrics.brier > baselineMetrics.brier + SCORE_EPSILON
    || modelMetrics.logLoss > baselineMetrics.logLoss + SCORE_EPSILON
    || modelMetrics.ece5 > 0.10 + SCORE_EPSILON) return null
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    modelVersion: TURN_RISK_MODEL_VERSION,
    featureVersion: TURN_RISK_FEATURE_VERSION,
    horizon: HORIZON,
    global: { ...raw.global },
    smoothing: { ...raw.smoothing },
    exactBuckets,
    broadBuckets,
    gate: {
      eligible: true,
      trainingTurns: gate.trainingTurns, holdoutTurns: gate.holdoutTurns,
      trainingSessions: gate.trainingSessions, holdoutSessions: gate.holdoutSessions,
      classCounts: { training: trainingCounts, holdout: holdoutCounts },
      metrics: { model: modelMetrics, baseline: baselineMetrics },
    },
  }
}

function modelAvailability(state) {
  if (state?.status === 'missing_model') return { status: 'missing_model', model: null }
  if (state?.status !== 'ready') return { status: 'invalid_model', model: null }
  const model = sanitizedModel(state.model)
  return model ? { status: 'evaluated_model', model } : { status: 'invalid_model', model: null }
}

function unavailableRisk(status) {
  return { status, horizon: HORIZON, value: null, modelVersion: null, support: null }
}

function predictionFromSummary(availability, summary) {
  if (!availability.model) return unavailableRisk(availability.status)
  const estimate = estimateFromSummary(availability.model, summary)
  return {
    status: 'evaluated_model', horizon: HORIZON, value: estimate.value,
    modelVersion: availability.model.modelVersion, support: estimate.support,
  }
}

/** Predict the explicitly labeled final outcome of one turn from its completed prefix. */
export function predictTurnRisk(modelState, prefixRows, expectedNextStep = null) {
  const availability = modelAvailability(modelState)
  if (!availability.model) return unavailableRisk(availability.status)
  const steps = latestSteps(prefixRows)
  if (!hasCompletePrefix(steps, expectedNextStep)) return unavailableRisk('incomplete_prefix')
  if (steps.some(step => step.legacyObservation)) return unavailableRisk('legacy_observation')
  return predictionFromSummary(availability, summariesForSteps(steps).at(-1))
}

/** Decorate stored rows without changing the durable step schema or using future steps. */
export function projectTurnRisk(steps, modelState) {
  if (!Array.isArray(steps)) throw new TypeError('steps must be an array')
  const availability = modelAvailability(modelState)
  if (!availability.model) {
    return steps.map(row => ({
      ...row,
      turnRisk: {
        status: availability.status, horizon: HORIZON, pre: null, post: null,
        delta: null, modelVersion: null, support: null,
        projection: 'retrospective_current_model',
      },
    }))
  }
  const groups = new Map()
  for (const row of steps) {
    const fact = stepFact(row)
    const key = fact.sessionId + '\u0000' + fact.turn
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const projected = new Map()
  for (const [key, rows] of groups) {
    const facts = latestSteps(rows)
    if (!hasCompletePrefix(facts)) {
      projected.set(key, new Map(facts.map(fact => [fact.step, {
        status: 'incomplete_prefix', horizon: HORIZON, pre: null, post: null,
        delta: null, modelVersion: null, support: null,
        projection: 'retrospective_current_model',
      }])))
      continue
    }
    const summaries = summariesForSteps(facts)
    const byStep = new Map()
    let legacyObserved = false
    for (let index = 0; index < facts.length; index += 1) {
      const pre = legacyObserved ? unavailableRisk('legacy_observation')
        : predictionFromSummary(availability, summaries[index])
      legacyObserved ||= facts[index].legacyObservation
      const post = legacyObserved ? unavailableRisk('legacy_observation')
        : predictionFromSummary(availability, summaries[index + 1])
      byStep.set(facts[index].step, {
        status: post.status, horizon: HORIZON, pre: pre.value, post: post.value,
        delta: pre.value === null || post.value === null ? null : post.value - pre.value,
        modelVersion: post.modelVersion,
        support: post.support, projection: 'retrospective_current_model',
      })
    }
    projected.set(key, byStep)
  }
  return steps.map(row => ({
    ...row,
    turnRisk: { ...projected.get(row.sessionId + '\u0000' + row.turn).get(row.step) },
  }))
}

/** Load only a small, regular, gated aggregate artifact; any bad file abstains. */
export function loadTurnRiskModel(path) {
  if (path === null || path === undefined) return { status: 'missing_model', model: null }
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\u0000')) {
    return { status: 'invalid_model', model: null }
  }
  let fd
  try {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink()
      || before.size < 2 || before.size > MAX_MODEL_BYTES) {
      return { status: 'invalid_model', model: null }
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size !== before.size
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      return { status: 'invalid_model', model: null }
    }
    const buffer = Buffer.alloc(opened.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length)
      if (count === 0) break
      length += count
    }
    if (length !== opened.size) return { status: 'invalid_model', model: null }
    const model = sanitizedModel(JSON.parse(buffer.toString('utf8', 0, length)))
    return model ? { status: 'ready', model } : { status: 'invalid_model', model: null }
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'missing_model' : 'invalid_model', model: null }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

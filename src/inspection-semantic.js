import { normalizeCompletedAt } from './turn-risk.js'

export const SEMANTIC_VERSION = 'inspection-semantic-v1'
const FINDINGS = new Set([
  'goal_conflict', 'suspected_mismatch', 'unverified_downstream_use',
  'recovered', 'satisfied', 'unrelated',
])
const SOURCES = new Set(['manual_local', 'local_assessor'])
const RESULTS = new Set(['pass', 'fail', 'unknown'])
const validIndex = value => Number.isSafeInteger(value) && value >= 0
const validSession = value => typeof value === 'string' && value.length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const validRef = value => object(value) && Object.keys(value).length === 4
  && validSession(value.sessionId) && validIndex(value.turn) && validIndex(value.step)
  && validIndex(value.revision)
const laterPosition = (reference, input) => reference.sessionId !== input.sessionId
  || reference.turn > input.turn || reference.turn === input.turn && reference.step > input.step

// A best-effort local masker, not a claim that arbitrary tool output is safe.
// Callers must supply brief, already redacted summaries rather than raw bodies.
export function redactSemanticSummary(value, maxChars = 240) {
  if (typeof value !== 'string' || value.length > 4096
    || !Number.isSafeInteger(maxChars) || maxChars < 40 || maxChars > 500)
    throw new TypeError('invalid semantic summary')
  const safe = value.replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\bBearer\s+\S+/gi, '[redacted_token]')
    .replace(/\b(?:sk|ghp|gho|github_pat)-?[A-Za-z0-9_\-]{16,}\b/g, '[redacted_token]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted_email]')
    .replace(/https?:\/\/\S+/gi, '[redacted_url]')
    .replace(/\b[A-Za-z]:\\[^\s]+/g, '[redacted_path]')
    .replace(/\/(?:home|Users|root)\/[^\s]+/g, '[redacted_path]')
    .replace(/\b(?:[A-F0-9]{32,}|[A-Za-z0-9+/]{48,}={0,2})\b/gi, '[redacted_token]')
    .replace(/\s+/g, ' ').trim()
  if (!safe) throw new TypeError('invalid semantic summary')
  return [...safe].slice(0, maxChars).join('')
}

export function normalizeSemanticAssessment(input, { maxChars = 240 } = {}) {
  if (!object(input) || Object.keys(input).some(key => ![
    'version', 'sessionId', 'turn', 'step', 'stepRevision', 'assessedAt', 'source',
    'goalSummary', 'stepSummary', 'verificationSummary', 'verificationResult', 'findings',
    'verificationRef', 'downstreamRef',
  ].includes(key)) || input.version !== SEMANTIC_VERSION
    || !validSession(input.sessionId) || !validIndex(input.turn) || !validIndex(input.step)
    || !validIndex(input.stepRevision)
    || normalizeCompletedAt(input.assessedAt) === null
    || !SOURCES.has(input.source) || !RESULTS.has(input.verificationResult)
    || !Array.isArray(input.findings) || input.findings.length < 1
    || input.findings.length > 6 || input.findings.some(finding => !FINDINGS.has(finding))
    || new Set(input.findings).size !== input.findings.length)
    throw new TypeError('invalid semantic assessment')
  const goalSummary = redactSemanticSummary(input.goalSummary, maxChars)
  const stepSummary = redactSemanticSummary(input.stepSummary, maxChars)
  const verificationSummary = input.verificationSummary == null ? null
    : redactSemanticSummary(input.verificationSummary, maxChars)
  const verified = input.findings.some(finding => [
    'goal_conflict', 'recovered', 'satisfied', 'unrelated',
  ].includes(finding))
  if (verified && (verificationSummary === null || !validRef(input.verificationRef)))
    throw new TypeError('verification summary and reference required')
  if (input.findings.includes('unverified_downstream_use')
    && !validRef(input.downstreamRef)) throw new TypeError('downstream reference required')
  if (!verified && input.verificationRef !== undefined
    || !input.findings.includes('unverified_downstream_use')
      && input.downstreamRef !== undefined)
    throw new TypeError('unexpected semantic reference')
  if (input.findings.includes('recovered') && !laterPosition(input.verificationRef, input)
    || input.findings.includes('unverified_downstream_use')
      && !laterPosition(input.downstreamRef, input))
    throw new TypeError('semantic reference must point to a later step')
  if (input.verificationRef !== undefined && !validRef(input.verificationRef)
    || input.downstreamRef !== undefined && !validRef(input.downstreamRef))
    throw new TypeError('invalid semantic reference')
  if (input.findings.includes('goal_conflict') && input.verificationResult !== 'fail'
    || input.findings.some(finding => ['recovered', 'satisfied', 'unrelated'].includes(finding))
      && input.verificationResult !== 'pass')
    throw new TypeError('semantic finding and verification disagree')
  return {
    version: SEMANTIC_VERSION,
    sessionId: input.sessionId, turn: input.turn, step: input.step,
    stepRevision: input.stepRevision,
    assessedAt: normalizeCompletedAt(input.assessedAt), source: input.source,
    goalSummary, stepSummary, verificationSummary,
    verificationResult: input.verificationResult, findings: [...input.findings],
    ...(input.verificationRef === undefined ? {} : { verificationRef: { ...input.verificationRef } }),
    ...(input.downstreamRef === undefined ? {} : { downstreamRef: { ...input.downstreamRef } }),
  }
}

export function createSemanticAssessments(config = {}) {
  if (!object(config) || Object.keys(config).some(key => ![
    'enabled', 'maxChars', 'maxEntries',
  ].includes(key))) throw new TypeError('invalid semantic input config')
  const { enabled = false, maxChars = 240, maxEntries = 1000 } = config
  if (typeof enabled !== 'boolean' || !validIndex(maxEntries) || maxEntries < 1
    || maxEntries > 10000 || !validIndex(maxChars) || maxChars < 40 || maxChars > 500)
    throw new TypeError('invalid semantic input config')
  const entries = new Map()
  const key = row => `${row.sessionId}\u0000${row.turn}\u0000${row.step}`
  return {
    enabled,
    preview(input) { return enabled ? normalizeSemanticAssessment(input, { maxChars }) : null },
    put(input) {
      if (!enabled) return false
      const safe = normalizeSemanticAssessment(input, { maxChars })
      const id = key(safe)
      entries.delete(id)
      entries.set(id, safe)
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value)
      return true
    },
    get(row) {
      const value = enabled ? entries.get(key(row)) : null
      return value ? structuredClone(value) : null
    },
    forgetSession(sessionId) {
      for (const [id, assessment] of entries)
        if (assessment.sessionId === sessionId) entries.delete(id)
    },
  }
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateJourney } from '../scripts/evaluate-gfa-inspection-journey.mjs'

const result = { status: 'complete', cases: [{ id: 'c1', arms: {
  ranked: { usage: { total_tokens: 42 }, totalElapsedMs: 90, openedSteps: [7, 2],
    transmittedImages: 1, checkpoints: [
      { index: 0, distinctSteps: 1, elapsedMs: 30,
        actionable: { refs: ['7:output:0'] }, chain: null },
      { index: 1, distinctSteps: 2, elapsedMs: 80,
        actionable: null, chain: { refs: ['7:output:0', '2:output:0'] } },
    ] },
  chronological: { usage: { total_tokens: 45 }, totalElapsedMs: 100,
    openedSteps: [1, 2], transmittedImages: 0, checkpoints: [] },
} }] }

test('unadjudicated model claims never become success', () => {
  const summary = evaluateJourney(result, [])
  assert.equal(summary.adjudicationStatus, 'unadjudicated')
  assert.equal(summary.byArm.ranked.actionableReached, null)
  assert.equal(summary.byArm.ranked.costTokens, 42)
})

test('uses earliest valid checkpoint and keeps no-trace cases out of A/C denominator', () => {
  const rows = [
    { caseId: 'c1', kind: 'case', class: 'in_trace' },
    { caseId: 'c1', kind: 'checkpoint', mode: 'ranked', checkpointIndex: 0,
      actionableValid: true, chainValid: false },
    { caseId: 'c1', kind: 'checkpoint', mode: 'ranked', checkpointIndex: 1,
      actionableValid: false, chainValid: true },
  ]
  const summary = evaluateJourney(result, rows)
  assert.equal(summary.byArm.ranked.actionableReached, 1)
  assert.equal(summary.byArm.ranked.chainReached, 1)
  assert.equal(summary.byArm.ranked.actionableRestrictedSteps, 1)
  assert.equal(summary.byArm.ranked.chainRestrictedSteps, 2)
  assert.equal(summary.byArm.chronological.chainReached, 0)
  const external = structuredClone(result)
  external.cases[0].id = 'c2'
  const excluded = evaluateJourney(external, [{ caseId: 'c2', kind: 'case',
    class: 'external_only' }])
  assert.equal(excluded.byArm.ranked.actionableCases, 0)
  assert.equal(excluded.caseClasses.external_only, 1)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateInvestigation } from '../scripts/evaluate-investigation-prioritization.mjs'

const claim = { discrepancy: 'wrong value', hypothesis: 'the value was copied',
  nextCheck: 'inspect source', support: 'same value', refute: 'different value',
  refs: ['1:output:0'] }
const chain = { requirement: 'correct value', deviation: 'wrong value',
  propagation: 'copied', recovery: 'none', finalCondition: 'wrong output',
  alternative: 'source could be wrong', refs: ['1:output:0'] }

function checkpoint(index, steps, actionable, causal) {
  return { index, afterStep: steps, distinctSteps: steps,
    openedSteps: Array.from({ length: steps }, (_, i) => i + 1),
    elapsedMs: steps * 1000, actionable, chain: causal }
}

function verdict(mode, index, hypothesisValid, canonicalHypothesisId,
  supportedEdgeIds = [], completeChainValid = false,
  unsupportedEdgeCount = 0) {
  return { kind: 'checkpoint', caseId: 'case-1', mode, checkpointIndex: index,
    hypothesisValid, canonicalHypothesisId, supportedEdgeIds,
    completeChainValid, unsupportedEdgeCount }
}

const results = { cases: [{ id: 'case-1', arms: {
  ranked: { openedSteps: [1, 2, 3], totalElapsedMs: 3000,
    usage: { total_tokens: 90 }, checkpoints: [
      checkpoint(0, 1, claim, { ...chain, deviation: 'first edge' }),
      checkpoint(1, 2, claim, { ...chain, deviation: 'second edge' }),
      checkpoint(2, 3, claim, chain),
    ] },
  chronological: { openedSteps: [1, 2, 3, 4], totalElapsedMs: 4000,
    usage: { total_tokens: 120 }, checkpoints: [
      checkpoint(0, 1, null, null),
      checkpoint(1, 2, claim, null),
      checkpoint(2, 3, null, chain),
    ] },
} }] }

const labels = [
  { kind: 'case', caseId: 'case-1', class: 'in_trace',
    actionableEligible: true, chainEligible: true,
    goldChains: [{ id: 'chain-a', edgeIds: ['e1', 'e2', 'e3'] },
      { id: 'chain-b', edgeIds: ['e1', 'e4'] }] },
  verdict('ranked', 0, true, 'H1', ['e1']),
  verdict('ranked', 1, true, 'H1', ['e2']),
  verdict('ranked', 2, true, 'H2', ['e3'], true, 1),
  verdict('chronological', 1, true, 'H1'),
  verdict('chronological', 2, false, null, ['e1']),
]

test('computes first valid hypothesis, deduplicated yield and graph coverage', () => {
  const out = evaluateInvestigation(results, labels)
  assert.equal(out.status, 'adjudicated')
  const ranked = out.cases[0].arms.ranked
  const chronological = out.cases[0].arms.chronological
  assert.equal(ranked.fhc, 1)
  assert.equal(chronological.fhc, 2)
  assert.equal(ranked.hgrAt5, 2 / 5)
  assert.equal(ranked.repeatedHypotheses, 1)
  assert.equal(ranked.cccAt5, 1)
  assert.equal(ranked.chainSteps, 3)
  assert.equal(ranked.unsupportedEdgeCount, 1)
  assert.equal(chronological.cccAt5, 1 / 2)
  assert.equal(chronological.chainReached, false)
  assert.equal(chronological.chainRestrictedSteps, 31)
  assert.equal(out.rankedMinusChronological.meanFhcRestrictedStepDifference, -1)
})

test('missing checkpoint judgment stays unadjudicated', () => {
  const partial = evaluateInvestigation(results, labels.filter(row =>
    !(row.kind === 'checkpoint' && row.mode === 'ranked'
      && row.checkpointIndex === 0)))
  assert.equal(partial.status, 'unadjudicated')
  assert.equal(partial.cases[0].arms.ranked.status, 'unadjudicated')
  assert.equal(partial.byArm.ranked.adjudicatedCases, 0)
})

test('rejects unknown causal edge and contradictory claim labels', () => {
  assert.throws(() => evaluateInvestigation(results, labels.map(row =>
    row.kind === 'checkpoint' && row.mode === 'ranked'
      && row.checkpointIndex === 0
      ? { ...row, supportedEdgeIds: ['not-in-reference'] } : row)),
  /contradictory_checkpoint_label/)
  assert.throws(() => evaluateInvestigation(results, labels.map(row =>
    row.kind === 'checkpoint' && row.mode === 'chronological'
      && row.checkpointIndex === 2
      ? { ...row, hypothesisValid: true,
        canonicalHypothesisId: 'H3' } : row)),
  /contradictory_checkpoint_label/)
  assert.throws(() => evaluateInvestigation(results, labels.map(row =>
    row.kind === 'checkpoint' && row.mode === 'ranked'
      && row.checkpointIndex === 0
      ? { ...row, completeChainValid: true } : row)),
  /complete_chain_without_covered_reference/)
})

test('does not credit a valid claim that arrived after the time cap', () => {
  const late = structuredClone(results)
  late.cases[0].arms.chronological.checkpoints[1].elapsedMs = 601000
  late.cases[0].arms.chronological.checkpoints[2].elapsedMs = 602000
  const out = evaluateInvestigation(late, labels)
  assert.equal(out.cases[0].arms.chronological.fhcReached, false)
  assert.equal(out.cases[0].arms.chronological.fhcRestrictedSteps, 31)
  assert.equal(out.cases[0].arms.chronological.cccEnd, 0)
})

test('no observable chain has not-applicable coverage, not zero', () => {
  const noChainResults = { cases: [{ id: 'outside', arms: {
    ranked: { openedSteps: [1], checkpoints: [checkpoint(0, 1, null, null)] },
    chronological: { openedSteps: [1], checkpoints: [checkpoint(0, 1, null, null)] },
  } }] }
  const noChainLabels = [{ kind: 'case', caseId: 'outside',
    class: 'external_only', actionableEligible: false,
    chainEligible: false, goldChains: [] }]
  const out = evaluateInvestigation(noChainResults, noChainLabels)
  assert.equal(out.cases[0].arms.ranked.cccEnd, null)
  assert.equal(out.byArm.ranked.meanChainRestrictedSteps, null)
  assert.equal(out.rankedMinusChronological.chainPairedCases, 0)
  assert.equal(out.rankedMinusChronological.meanChainRestrictedStepDifference, null)
})

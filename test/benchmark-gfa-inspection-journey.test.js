import test from 'node:test'
import assert from 'node:assert/strict'
import { createEvidenceStore } from '../scripts/gfa-inspection-evidence.mjs'
import { runJourney } from '../scripts/benchmark-gfa-inspection-journey.mjs'

function setup() {
  const events = [
    { step: 1, step_type: 'tool_call', output: { text: 'first'.repeat(30) } },
    { step: 2, step_type: 'observation', output: { text: 'second' } },
  ]
  const item = { id: 'case', instruction: 'goal', events,
    ranked: [{ event: events[1], score: 60 }, { event: events[0], score: 20 }],
    proxyScoringMs: 2 }
  return { item, store: createEvidenceStore(item, { chunkChars: 25,
    loadImage: async () => { throw new Error('unexpected_image') } }) }
}

test('runner logs actual opened steps and requires a checkpoint before the next opening', async () => {
  const { item, store } = setup()
  const calls = [
    { decision: { action: 'open_step', step: 2, memo: '' }, usage: { input_tokens: 10, output_tokens: 5 } },
    { decision: { action: 'open_step', step: 1, memo: 'noted', checkpoint: {
      actionable: { refs: ['2:output:0'], discrepancy: 'missing',
        hypothesis: 'wrong', nextCheck: 'open 1', support: 'yes', refute: 'no' },
      chain: null } }, usage: { input_tokens: 20, output_tokens: 6 } },
    { decision: { action: 'finish', memo: 'done', checkpoint: {
      actionable: null, chain: null } }, usage: { input_tokens: 30, output_tokens: 7 } },
  ]
  const clockValues = [0, 10, 20, 30, 40, 50, 60, 70]
  const result = await runJourney(item, 'ranked', async () => calls.shift(), store,
    { clock: () => clockValues.shift(), maxDistinctSteps: 30 })
  assert.deepEqual(result.openedSteps, [2, 1])
  assert.equal(result.checkpoints.length, 2)
  assert.equal(result.checkpoints[0].afterStep, 2)
  assert.equal(result.usage.total_tokens, 78)
  assert.equal(result.termination, 'investigator_finished')
  assert.equal(result.scoringMs, 2)
})

test('runner rejects claims citing unopened evidence', async () => {
  const { item, store } = setup()
  const calls = [
    { decision: { action: 'open_step', step: 2, memo: '' } },
    { decision: { action: 'finish', memo: '', checkpoint: {
      actionable: { refs: ['1:output:0'] }, chain: null } } },
  ]
  await assert.rejects(runJourney(item, 'chronological', async () => calls.shift(),
    store), /undisclosed_evidence_reference/)
})

test('runner records budget exhaustion without accepting model claims as truth', async () => {
  const { item, store } = setup()
  const calls = [
    { decision: { action: 'open_step', step: 1, memo: '' } },
    { decision: { action: 'open_step', step: 2, memo: '', checkpoint: {
      actionable: { refs: ['1:step_type:0'], discrepancy: 'error' }, chain: null } } },
  ]
  const result = await runJourney(item, 'chronological', async () => calls.shift(),
    store, { maxDistinctSteps: 1 })
  assert.equal(result.termination, 'step_budget')
  assert.equal(result.openedSteps.length, 1)
  assert.equal(result.checkpoints[0].actionable.refs[0], '1:step_type:0')
  assert.equal(result.validatedActionable, undefined)
})

test('last allowed model call cannot open evidence that will never be shown', async () => {
  const { item, store } = setup()
  const calls = [
    { decision: { action: 'open_step', step: 1, memo: '' } },
    { decision: { action: 'open_step', step: 2, memo: '', checkpoint: {
      actionable: null, chain: null } } },
  ]
  const result = await runJourney(item, 'ranked', async () => calls.shift(),
    store, { maxCalls: 2 })
  assert.deepEqual(result.openedSteps, [1])
  assert.equal(result.termination, 'model_call_budget')
})

test('invalid opening is logged and retried without disclosing evidence', async () => {
  const { item, store } = setup()
  const states = []
  const calls = [
    { decision: { action: 'open_step', step: 999, memo: '' },
      usage: { input_tokens: 10, output_tokens: 2 } },
    { decision: { action: 'open_step', step: 2, memo: '' },
      usage: { input_tokens: 11, output_tokens: 3 } },
    { decision: { action: 'finish', memo: 'done', checkpoint: {
      actionable: null, chain: null } },
      usage: { input_tokens: 12, output_tokens: 4 } },
  ]
  const result = await runJourney(item, 'ranked', async state => {
    states.push(state)
    return calls.shift()
  }, store)
  assert.deepEqual(result.openedSteps, [2])
  assert.equal(result.events[0].protocolViolations[0], 'invalid_open_step')
  assert.match(states[1].actionError, /invalid_open_step/)
  assert.equal(states[1].lastEvidence, null)
  assert.equal(result.checkpoints.length, 1)
  assert.equal(result.usage.total_tokens, 42)
})

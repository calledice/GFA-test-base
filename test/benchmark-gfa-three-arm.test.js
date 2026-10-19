import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRankedOrder, runThreeArmCase } from '../scripts/benchmark-gfa-three-arm.mjs'

const events = Array.from({ length: 25 }, (_, index) => ({
  step: index + 1, step_type: 'tool_call', output: { text: `step ${index + 1}` },
  ...(index === 14 ? { screenshots: { post: {
    path: 'post.png', sha256: 'a'.repeat(64), bytes: 10 } } } : {}),
}))
const item = { id: 'test-case', instruction: 'Complete the task', events,
  gold: { origin_step: 15, decisive_step: 20 }, proxyScoringMs: 0.2,
  ranked: [events[15], events[17], events[19], events[21], events[23],
    ...events.filter(event => ![16, 18, 20, 22, 24].includes(event.step))]
    .map((event, index) => ({ event, score: 60 - index })) }

test('ranked evidence starts with five leads and includes a nearby image-bearing step', () => {
  const order = buildRankedOrder(item)
  assert.deepEqual(order.slice(0, 5).map(event => event.step), [16, 18, 20, 22, 24])
  assert.ok(order.slice(0, 10).some(event => event.step === 15))
  assert.equal(new Set(order.map(event => event.step)).size, events.length)
})

test('three arms use equal initial step caps and count every fallback transmission', async () => {
  const seen = []
  const fake = async (_api, _model, payload) => {
    const head = JSON.parse(payload.input[0].content[0].text)
    const shown = head.inspectedSteps
    seen.push({ mode: head.mode, shown, scoreSource: head.scoreSource,
      body: JSON.stringify(payload.input).slice(0, 2000) })
    const enough = shown.length === events.length
    return { model: 'same-model', elapsedMs: 5,
      usage: { input_tokens: shown.length * 10, output_tokens: 10,
        total_tokens: shown.length * 10 + 10 },
      answer: enough ? { origin_step: 15, decisive_step: 20,
        confidence: 0.9, done: true, support_steps: [15, 20],
        check_path: [15, 20], evidence: 'two steps' }
        : { origin_step: null, decisive_step: null, confidence: 0.4,
          done: false, support_steps: [], check_path: [], evidence: 'more' } }
  }
  const load = async () => 'data:image/jpeg;base64,abcd'
  const result = await runThreeArmCase(item, 'unused', 'unused', 'same-model',
    fake, () => load)
  assert.deepEqual(seen.map(row => row.shown.length), [25, 10, 20, 25, 10, 20, 25])
  assert.deepEqual(seen.map(row => row.mode), ['all_events',
    'budgeted_ranked', 'budgeted_ranked', 'budgeted_ranked',
    'budgeted_chronological', 'budgeted_chronological', 'budgeted_chronological'])
  assert.equal(seen[1].scoreSource, 'gfa_inspection_proxy_v2')
  assert.equal(seen[4].scoreSource, undefined)
  assert.equal(result.ranked.transmittedStepInstances, 55)
  assert.equal(result.chronological.transmittedStepInstances, 55)
  assert.equal(result.ranked.usage.total_tokens, 580)
  assert.equal(result.ranked.calls, 3)
  assert.equal(result.direct.calls, 1)
  assert.equal(result.ranked.answer.origin_step, 15)
  assert.equal(result.chronological.answer.decisive_step, 20)
  assert.ok(seen.every(row => !row.body.includes('origin_step')))
})

test('an unsupported confident answer does not stop a budgeted arm', async () => {
  const fake = async (_api, _model, payload) => {
    const shown = JSON.parse(payload.input[0].content[0].text).inspectedSteps
    return { model: 'same-model', elapsedMs: 1,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      answer: { origin_step: 15, decisive_step: 20, confidence: 0.95,
        done: true, support_steps: [15], check_path: [15], evidence: 'unsupported' } }
  }
  const result = await runThreeArmCase(item, 'unused', 'unused', 'same-model',
    fake, () => async () => 'data:image/jpeg;base64,abcd')
  assert.equal(result.ranked.calls, 3)
  assert.equal(result.ranked.answer.done, false)
  assert.equal(result.ranked.answer.origin_step, null)
})

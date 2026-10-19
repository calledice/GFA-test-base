import test from 'node:test'
import assert from 'node:assert/strict'
import { runSystemOneCase, scoreWithSystemOne, systemOneStates,
  SYSTEM_ONE_SCORE_SOURCE } from '../scripts/benchmark-gfa-system-one.mjs'

const events = Array.from({ length: 65 }, (_, index) => ({
  step: index + 1, step_type: 'tool_call',
  output: { text: `event ${index + 1}` },
}))
const item = { id: 'test', instruction: 'Complete a task', events }

test('System 1 uses bounded text states and splits a 65-step trajectory into two batches', async () => {
  const states = systemOneStates(item)
  assert.equal(states.length, 65)
  assert.match(states[1].body, /"CURRENT":\{"step":2/)
  assert.match(states[1].body, /"previous":\{"step":1/)
  const received = []
  const fetcher = async (_url, options) => {
    const body = JSON.parse(options.body)
    received.push(body)
    return { ok: true, json: async () => ({
      results: body.states.map(state => {
        const step = JSON.parse(state.body).CURRENT.step
        return { answers: {
          origin: { probabilities: { A: step === 65 ? 0.9 : 0.1, B: 0.1 } },
          decisive: { probabilities: { A: step === 1 ? 0.8 : 0.2, B: 0.2 } },
        } }
      }),
      total_usage: { input_tokens: body.states.length * 7,
        output_tokens: body.states.length * 2 },
    }) }
  }
  const result = await scoreWithSystemOne(item,
    'http://localhost:8000/v1/systemone/batch', 'jev-1', fetcher, '')
  assert.deepEqual(received.map(row => row.states.length), [64, 1])
  assert.equal(result.calls, 2)
  assert.equal(result.usage.total_tokens, 585)
  assert.deepEqual(result.entrySteps.slice(0, 2), [65, 1])
  assert.equal(result.imageCount, 0)
})

test('System 1 full arm sends verified screenshots to the localization model once', async () => {
  const smallEvents = events.slice(0, 3).map(event => ({ ...event }))
  smallEvents[1].screenshots = { post: {
    path: 'post.png', sha256: 'a'.repeat(64), bytes: 10,
  } }
  const smallItem = { ...item, events: smallEvents }
  const ranking = { scoreSource: SYSTEM_ONE_SCORE_SOURCE, model: 'jev-1',
    ranked: [smallEvents[1], smallEvents[0], smallEvents[2]]
      .map((event, index) => ({ event, score: 0.9 - index * 0.1 })),
    scores: [], entrySteps: [2, 1, 3], calls: 1, elapsedMs: 4,
    usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 },
    imageCount: 0 }
  let modelCalls = 0
  const modelCall = async (_url, _model, payload) => {
    modelCalls++
    const head = JSON.parse(payload.input[0].content[0].text)
    assert.equal(head.scoreSource, SYSTEM_ONE_SCORE_SOURCE)
    assert.deepEqual(head.inspectedSteps, [2, 1, 3])
    assert.equal(payload.imageCount, 1)
    assert.equal(payload.input[0].content.filter(part =>
      part.type === 'input_image').length, 1)
    return { model: 'same-model', elapsedMs: 8,
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      answer: { origin_step: 1, decisive_step: 2, done: true,
        confidence: 0.9, support_steps: [1, 2], check_path: [2, 1],
        evidence: 'supported' } }
  }
  const result = await runSystemOneCase(smallItem, 'unused', 'unused', 'jev-1',
    'unused', 'same-model', async () => ranking, modelCall,
    async () => 'data:image/jpeg;base64,abcd')
  assert.equal(modelCalls, 1)
  assert.equal(result.localization.answer.done, true)
  assert.equal(result.totalTokens, 134)
  assert.equal(result.transmittedImages, 1)
  assert.equal(result.totalModelCalls, 2)
})

test('malformed System 1 probabilities fail rather than silently rank events', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({
    results: [{ answers: { origin: { probabilities: {} },
      decisive: { probabilities: { A: 0.5 } } } }],
    total_usage: { input_tokens: 1, output_tokens: 1 },
  }) })
  await assert.rejects(scoreWithSystemOne({ ...item, events: events.slice(0, 1) },
    'unused', 'jev-1', fetcher, ''), /system_one_probability_unavailable/)
})

test('a truncated System 1 state cannot produce a ranking', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({
    results: [{ answers: {
      origin: { probabilities: { A: 0.8 } },
      decisive: { probabilities: { A: 0.2 } },
    }, usage: { truncated: true, state_tokens_dropped: 12 } }],
    total_usage: { input_tokens: 10, output_tokens: 0 },
  }) })
  await assert.rejects(scoreWithSystemOne({ ...item, events: events.slice(0, 1) },
    'unused', 'jev-1', fetcher, ''), /system_one_input_truncated:1:12/)
})

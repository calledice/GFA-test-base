import test from 'node:test'
import assert from 'node:assert/strict'
import { GFA_PROXY_VERSION, eventView, prepare, proxyScore, proxyScoreV1,
  runCase, summarize } from '../scripts/benchmark-gfa-proxy.mjs'

const fixture = {
  trajectory: {
    trajectory_id: 'private-case', framework: 'fixture', benchmark: 'fixture',
    source_sha256: 'source', atomic_events_sha256: 'events', order_verified: true,
    atomic_events: [
      { step: 0, step_type: 'task_definition', output: { instruction: 'Create a blue chart' } },
      { step: 1, step_type: 'tool_call', output: { action: 'create chart' } },
      { step: 2, step_type: 'model_response', output: { text: 'used red' } },
      { step: 3, step_type: 'observation', output: { capture_error: 'failed' } },
    ],
  },
  run_identity: { identity_matches: true },
  annotation: { confidence: 0.9, position_status: {
    origin_step: 'applicable', decisive_step: 'applicable' },
    labels: { fault_domain: 'agent_harness',
    origin_event_step: 2, decisive_event_step: 3 } },
}

test('GFA rows abstain in native v3 while proxy sorts without gold labels', () => {
  const item = prepare(fixture)
  assert.equal(item.nativeScoreCoverage, 0)
  assert.deepEqual(item.ranked.map(row => row.event.step), [3, 2, 1])
  const changedGold = prepare({ ...fixture, annotation: { ...fixture.annotation,
    labels: { ...fixture.annotation.labels, origin_event_step: 1 } } })
  assert.deepEqual(changedGold.ranked.map(row => row.event.step), [3, 2, 1])
  assert.equal(proxyScore(fixture.trajectory.atomic_events[3]), 60)
  assert.match(eventView(fixture.trajectory.atomic_events[3]).content, /failed/)
  assert.throws(() => prepare({ ...fixture, annotation: { labels: {
    fault_domain: 'task_evaluator', origin_event_step: 2, decisive_event_step: 3,
  } } }), /case_not_eligible/)
})

test('event view includes OpenAI CUA message actions and final response text', () => {
  const proposed = eventView({ step: 15, step_type: 'model_response', output: {
    text: null, messages: [{ actions: [{ type: 'type', text: 'sed -i edit calculator.py' }] }],
  } })
  assert.match(proposed.content, /sed -i edit calculator\.py/)
  const final = eventView({ step: 22, step_type: 'model_response', output: {
    text: null, response: 'Sorted array is: 5 6 11 12 13',
    messages: [{ content: [{ type: 'output_text', text: 'Sorted array is: 5 6 11 12 13' }] }],
  } })
  assert.match(final.content, /Sorted array is: 5 6 11 12 13/)
})

test('v2 ranks concrete decisions and completion claims above passive screenshots and waits', () => {
  const make = (step_type, output) => ({ step_type, output })
  const screenshot = make('model_response', { messages: [{ actions: [{ type: 'screenshot' }] }] })
  const edit = make('model_response', { messages: [{ actions: [
    { type: 'type', text: 'edit calculator.py' }, { type: 'keypress', keys: ['ENTER'] },
  ] }] })
  const stop = make('model_response', { model_output: { tool_call: 'stop [Done]' } })
  const wait = make('tool_call', { action: 'import time; time.sleep(2.0)' })
  const done = make('tool_call', { action: { action_type: 'DONE' }, done: true })
  const failed = make('tool_call', { error: 'executor failed' })
  assert.equal(GFA_PROXY_VERSION, 'gfa_inspection_proxy_v2')
  assert.equal(proxyScoreV1(screenshot), proxyScoreV1(edit))
  assert.ok(proxyScore(edit) > proxyScore(screenshot))
  assert.ok(proxyScore(stop) > proxyScore(edit))
  assert.ok(proxyScore(done) > proxyScore(wait))
  assert.ok(proxyScore(failed) > proxyScore(stop))
  assert.equal(proxyScore(make('observation', { dispatch_status: 'completed', error: null })), 22)
})

test('v2 scoring ignores gold positions and final task outcome', () => {
  const event = { step: 2, step_type: 'model_response', output: {
    model_output: { tool_call: 'goto [http://example.test/item]' } } }
  assert.equal(proxyScore({ ...event, annotation: { origin_event_step: 2 },
    official_score: 0 }), proxyScore(event))
  assert.equal(proxyScore({ ...event, annotation: { origin_event_step: 9 },
    official_score: 1 }), proxyScore(event))
})

test('guided arm counts only disclosed steps and sums real call usage', async () => {
  const item = prepare(fixture)
  const prompts = []
  const fake = async (_url, model, input) => {
    prompts.push(JSON.parse(input))
    return { model, answer: { origin_step: 2, decisive_step: 3,
      confidence: 0.9, need_more: false, evidence: 'test' }, elapsedMs: 7,
    usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 } }
  }
  const arms = await runCase(item, 'unused', 'fixture-model', fake)
  const guided = await arms.guided()
  const direct = await arms.direct()
  assert.equal(guided.inspectedSteps, 3)
  assert.equal(guided.usage.total_tokens, 15)
  assert.deepEqual(prompts[0].events.map(event => event.step), [3, 2, 1])
  assert.deepEqual(prompts[1].events.map(event => event.step), [1, 2, 3])
  const report = summarize([{ gold: item.gold, guided, direct }])
  assert.equal(report.guided.pairExact, 1)
  assert.equal(report.direct.origin_stepExact, 1)
})

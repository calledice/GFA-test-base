import test from 'node:test'
import assert from 'node:assert/strict'
import { screenshotRefs, modelInput, runMultimodalCase, verifySelectedCase } from '../scripts/benchmark-gfa-multimodal.mjs'

const event = step => ({ step, step_type: step <= 2 ? 'model_response' : 'tool_call',
  acting_agent: 'agent', output: { text: `event ${step}` },
  ...(step === 2 ? { screenshots: {
    pre: { path: 'pre.png', sha256: 'a'.repeat(64), bytes: 10 },
    model: { path: 'same.png', sha256: 'a'.repeat(64), bytes: 10 },
    post: { path: 'post.png', sha256: 'b'.repeat(64), bytes: 11 },
  } } : {}) })

const events = Array.from({ length: 7 }, (_, i) => event(i + 1))
const item = { id: 'fixture', instruction: 'Do task', events,
  ranked: [events[1], events[0], ...events.slice(2)].map((event, i) => ({ event, score: 40 - i })) }

test('one step sends distinct pre/post screenshots and keeps the same image contract in both arms', async () => {
  assert.deepEqual(screenshotRefs(events[1]).map(ref => ref.phase), ['pre', 'post'])
  const extra = { ...events[2], artifact_refs: [{ path: 'late.png',
    sha256: 'c'.repeat(64), bytes: 12 }] }
  assert.deepEqual(screenshotRefs(extra).map(ref => [ref.phase, ref.index]), [['unverified', 0]])
  const load = async (_id, ref) => `data:image/jpeg;base64,${ref.sha256.slice(0, 4)}`
  const payload = await modelInput(item, [events[1]], 'test', load)
  assert.equal(payload.imageCount, 2)
  assert.equal(payload.input[0].content.filter(part => part.type === 'input_image').length, 2)
  assert.match(payload.input[0].content[0].text, /"step":7/)
  const sameImage = { ...events[2], screenshots: { pre: events[1].screenshots.pre } }
  const deduped = await modelInput(item, [events[1], sameImage], 'test', load)
  assert.equal(deduped.imageCount, 2)
})

test('scored full trajectory gives one ranked, scored call; baseline gives one chronological call', async () => {
  const prompts = []
  const fake = async (_url, model, payload) => {
    const header = JSON.parse(payload.input[0].content[0].text)
    const shown = payload.input[0].content.filter(part => part.type === 'input_text')
      .slice(1).map(part => { try { return JSON.parse(part.text)?.step } catch { return null } })
      .filter(Number.isInteger)
    prompts.push({ header, shown, imageCount: payload.imageCount })
    const answer = { done: true, origin_step: 2, decisive_step: 7, confidence: 0.9,
      support_steps: [2, 7], check_path: [2, 1, 7], evidence: 'causal chain' }
    return { model, answer, elapsedMs: 4, imageCount: payload.imageCount,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
  }
  const load = async () => 'data:image/jpeg;base64,abcd'
  const arms = await runMultimodalCase(item, 'unused', 'unused', 'same-model', fake, load)
  const guided = await arms.guided()
  const direct = await arms.direct()
  assert.equal(prompts.length, 2)
  assert.equal(prompts[0].header.mode, 'scored_full_trajectory')
  assert.equal(prompts[0].header.scoreSource, 'gfa_inspection_proxy_v2')
  assert.deepEqual(prompts[0].header.entrySteps, [2, 1, 3, 4, 5])
  assert.deepEqual(prompts[0].header.ranking, [2, 1, 3, 4, 5, 6, 7]
    .map((step, index) => ({ step, rank: index + 1, score: 40 - index })))
  assert.deepEqual(prompts[0].shown, [2, 1, 3, 4, 5, 6, 7])
  assert.equal(prompts[1].header.mode, 'all_events')
  assert.equal('ranking' in prompts[1].header, false)
  assert.equal('scoreSource' in prompts[1].header, false)
  assert.deepEqual(prompts[1].shown, [1, 2, 3, 4, 5, 6, 7])
  assert.equal(prompts[0].imageCount, prompts[1].imageCount)
  assert.equal(guided.calls, 1)
  assert.equal(direct.calls, 1)
  assert.equal(guided.inspectedSteps, 7)
  assert.equal(guided.usage.total_tokens, 15)
  assert.equal(guided.answer.done, true)
  assert.deepEqual(guided.answer.check_path, [2, 1, 7])
  assert.equal(direct.inspectedSteps, 7)
  assert.equal(direct.model, 'same-model')
})

test('failure cohort requires a completed failed official result and pinned source hashes', () => {
  const record = { trajectory: { official_score: 0,
    report: { outcome: 'failure', evaluation_status: 'completed', execution_complete: true },
    official_evaluator_evidence: { available: true,
      reports: [{ outcome: 'failure', evaluation_status: 'completed' }] } } }
  const prepared = { sourceSha256: 'a'.repeat(64), atomicEventsSha256: 'b'.repeat(64) }
  const selected = { sourceSha256: prepared.sourceSha256,
    atomicEventsSha256: prepared.atomicEventsSha256 }
  assert.doesNotThrow(() => verifySelectedCase(record, prepared, selected, true))
  assert.throws(() => verifySelectedCase(record, prepared,
    { ...selected, sourceSha256: 'c'.repeat(64) }, true), /source_changed/)
  assert.throws(() => verifySelectedCase({ trajectory: { ...record.trajectory,
    report: { ...record.trajectory.report, outcome: 'success' } } },
  prepared, selected, true), /not_completed_official_failure/)
  assert.throws(() => verifySelectedCase({ trajectory: { ...record.trajectory,
    official_score: 0.5 } }, prepared, selected, true), /not_completed_official_failure/)
})

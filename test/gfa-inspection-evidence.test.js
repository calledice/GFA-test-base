import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createEvidenceStore, prepareInspectionCase } from '../scripts/gfa-inspection-evidence.mjs'

function fixture() {
  const body = '异常🙂'.repeat(41)
  const item = { id: 'case-1', instruction: '完成任务', events: [
    { step: 2, step_type: 'observation', acting_agent: 'agent-a',
      input: { query: 'a' }, output: { text: body }, screenshots: {} },
    { step: 4, step_type: 'tool_call', acting_agent: 'agent-a',
      output: { action: 'click' }, screenshots: {} },
  ], ranked: [] }
  item.ranked = [{ event: item.events[1], score: 60 },
    { event: item.events[0], score: 20 }]
  return { item, body }
}

test('oversize field is reachable without text loss; common index hides score and body', async () => {
  const { item } = fixture()
  const store = createEvidenceStore(item, { chunkChars: 37,
    loadImage: async () => { throw new Error('unexpected_image') } })
  const index = store.index()
  assert.deepEqual(index.map(row => row.step), [2, 4])
  assert.equal(JSON.stringify(index).includes('异常'), false)
  assert.equal(JSON.stringify(index).includes('score'), false)
  assert.deepEqual(store.recommend('ranked', new Set()), [4, 2])
  assert.deepEqual(store.recommend('chronological', new Set()), [2, 4])
  const opened = await store.openStep(2)
  const manifest = opened.fields.find(row => row.name === 'output')
  assert.equal(manifest.inline, null)
  const chunks = Array.from({ length: manifest.chunks }, (_, i) =>
    store.readChunk(2, 'output', i).text)
  const reconstructed = chunks.join('')
  assert.equal(reconstructed, JSON.stringify(item.events[0].output))
  assert.equal(createHash('sha256').update(reconstructed).digest('hex'), manifest.sha256)
})

test('opening discloses all verified image references on that step', async () => {
  const { item } = fixture()
  item.events[0].screenshots = { pre: { path: 'pre.png', sha256: 'a'.repeat(64), bytes: 12 },
    post: { path: 'post.png', sha256: 'b'.repeat(64), bytes: 13 } }
  const calls = []
  const store = createEvidenceStore(item, { loadImage: async (id, ref) => {
    calls.push([id, ref.sha256]); return `data:image/jpeg;base64,${ref.sha256}`
  } })
  const opened = await store.openStep(2)
  assert.deepEqual(calls.map(row => row[1]), ['a'.repeat(64), 'b'.repeat(64)])
  assert.equal(opened.images.length, 2)
  assert.equal(opened.images[0].sha256, 'a'.repeat(64))
})

test('inspection preparation accepts an unlabelled failed trace and never needs gold', () => {
  const { item } = fixture()
  const record = { run_identity: { identity_matches: true },
    trajectory: { trajectory_id: 'new-case', order_verified: true,
      source_sha256: 'a'.repeat(64), atomic_events_sha256: 'b'.repeat(64),
      framework: 'test', benchmark: 'test', atomic_events: [
        { step: 0, step_type: 'task_definition', output: {
          instruction: '完整任务说明' } }, ...item.events ],
      report: { outcome: 'failure', evaluation_status: 'completed',
        execution_complete: true }, official_score: 0 } }
  const prepared = prepareInspectionCase(record)
  assert.equal(prepared.instruction, '完整任务说明')
  assert.equal('gold' in prepared, false)
  assert.deepEqual(prepared.ranked.map(row => row.event.step), [4, 2])
})

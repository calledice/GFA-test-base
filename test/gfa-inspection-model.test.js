import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelInvestigator } from '../scripts/gfa-inspection-model.mjs'

test('model adapter sends only the latest verified image and reads real usage', async () => {
  let request
  const investigator = createModelInvestigator({ apiUrl: 'https://example.test/v1/responses',
    model: 'same-model', apiKey: 'test-key', fetcher: async (_url, init) => {
      request = JSON.parse(init.body)
      return { ok: true, json: async () => ({ status: 'completed', model: 'same-model',
        usage: { input_tokens: 12, output_tokens: 4 }, output: [{ content: [
          { type: 'output_text', text: JSON.stringify({ action: 'finish', step: null,
            field: null, chunkIndex: null, memo: 'x', checkpoint: {
              actionable: null, chain: null } }) } ] }] }) }
    } })
  const result = await investigator({ caseId: 'c', task: 'task', mode: 'ranked',
    index: [{ step: 2 }], recommendations: [2], openedSteps: [2],
    visibleRefs: ['2:image:a'], memo: '', callIndex: 1,
    lastEvidence: { kind: 'step', step: 2, fields: [], images: [{
      sha256: 'a', phase: 'pre', bytes: 3,
      imageUrl: 'data:image/jpeg;base64,AAAA' }] } })
  assert.equal(result.usage.input_tokens, 12)
  assert.equal(result.decision.action, 'finish')
  assert.equal(request.input[0].content.filter(x => x.type === 'input_image').length, 1)
  assert.equal(request.input[0].content[0].text.includes('data:image'), false)
  assert.equal(JSON.parse(request.input[0].content[0].text).mode, undefined)
})

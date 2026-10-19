import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runManifest } from '../scripts/run-gfa-inspection-journey.mjs'

test('confirmatory run rejects missing independent final-condition evidence before fetch', async () => {
  const manifest = fileURLToPath(new URL('./fixtures/missing-final-condition.json', import.meta.url))
  await assert.rejects(runManifest({
    manifest, out: 'unused.json', site: 'https://example.test/',
    dryRun: true, requireFinalCondition: true,
  }), /verified_final_unmet_condition_required/)
})

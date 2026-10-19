import test from 'node:test'
import assert from 'node:assert/strict'
import { eligibleCandidate, selectCandidates } from '../scripts/select-gfa-inspection-cohort.mjs'

function record(id, framework = 'a') {
  return { run_identity: { identity_matches: true },
    trajectory: { trajectory_id: id, benchmark: 'bench', task_key: id,
      framework, order_verified: true, source_sha256: 'a'.repeat(64),
      atomic_events_sha256: 'b'.repeat(64), official_score: 0,
      report: { outcome: 'failure', evaluation_status: 'completed',
        execution_complete: true },
      atomic_events: Array.from({ length: 30 }, (_, step) => ({
        step, step_type: 'tool_call' })) } }
}

test('candidate selection needs official failure but never needs annotation labels', () => {
  const row = record('id1')
  assert.equal(eligibleCandidate(row, new Set(), new Set()).id, 'id1')
  row.trajectory.report.outcome = 'success'
  assert.equal(eligibleCandidate(row, new Set(), new Set()), null)
})

test('round robin gives different frameworks a deterministic opportunity', () => {
  const a = eligibleCandidate(record('a1', 'a'), new Set(), new Set())
  const b = eligibleCandidate(record('b1', 'b'), new Set(), new Set())
  const c = eligibleCandidate(record('a2', 'a'), new Set(), new Set())
  const selected = selectCandidates([c, b, a], 2)
  assert.deepEqual(selected.map(row => row.framework), ['a', 'b'])
})

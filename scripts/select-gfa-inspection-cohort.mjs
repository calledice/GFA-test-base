#!/usr/bin/env node
// Candidate freeze only. Independent failure and A/C adjudication remain required.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { screenshotRefs } from './benchmark-gfa-multimodal.mjs'

function groupKey(trajectory) {
  return `${trajectory.benchmark}:${trajectory.task_key}`
}

export function eligibleCandidate(record, excludedIds, excludedGroups) {
  const t = record?.trajectory, r = t?.report
  if (!t || excludedIds.has(t.trajectory_id)
    || excludedGroups.has(groupKey(t))
    || typeof t.benchmark !== 'string' || !t.benchmark
    || typeof t.task_key !== 'string' || !t.task_key
    || t.order_verified !== true
    || record.run_identity?.identity_matches !== true
    || r?.outcome !== 'failure' || r.evaluation_status !== 'completed'
    || r.execution_complete !== true || t.official_score !== 0
    || !t.source_sha256 || !t.atomic_events_sha256)
    return null
  const events = t.atomic_events?.filter(event => event.step_type !== 'task_definition')
  if (!events || events.length < 30
    || new Set(events.map(event => event.step)).size !== events.length)
    return null
  const imageHashes = new Set(events.flatMap(screenshotRefs).map(ref => ref.sha256))
  return { id: t.trajectory_id, sourceSha256: t.source_sha256,
    atomicEventsSha256: t.atomic_events_sha256,
    framework: t.framework, benchmark: t.benchmark,
    taskKey: t.task_key, steps: events.length,
    distinctImages: imageHashes.size,
    groupKey: groupKey(t) }
}

function stableHash(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function selectCandidates(candidates, count) {
  const byFramework = new Map()
  for (const candidate of candidates) {
    const rows = byFramework.get(candidate.framework) ?? []
    rows.push(candidate)
    byFramework.set(candidate.framework, rows)
  }
  for (const rows of byFramework.values())
    rows.sort((a, b) => stableHash(a.groupKey).localeCompare(stableHash(b.groupKey)))
  const frameworks = [...byFramework.keys()].sort()
  const selected = [], groups = new Set()
  while (selected.length < count) {
    let added = false
    for (const framework of frameworks) {
      const rows = byFramework.get(framework)
      while (rows.length && groups.has(rows[0].groupKey)) rows.shift()
      if (!rows.length) continue
      const row = rows.shift()
      groups.add(row.groupKey); selected.push(row); added = true
      if (selected.length === count) break
    }
    if (!added) break
  }
  return selected
}

async function main(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2)
    args[argv[index]] = argv[index + 1]
  if (!args['--site'] || !args['--exclude'] || !args['--out']
    || argv.length % 2) throw new Error('usage: --site URL --exclude FILE --out FILE [--count N]')
  const count = Number(args['--count'] ?? 20)
  if (!Number.isInteger(count) || count < 1) throw new Error('invalid_count')
  const prior = JSON.parse(await readFile(args['--exclude'], 'utf8'))
  const excludedIds = new Set(prior.cases?.map(row => row.id) ?? [])
  if (!excludedIds.size) throw new Error('empty_exclusion_set')
  const excludedGroups = new Set()
  for (const row of prior.cases ?? []) {
    const id = row.id
    const tail = id.slice((row.benchmark?.length ?? 0) + 1)
    const last = tail.lastIndexOf(':')
    if (last > 0) excludedGroups.add(`${row.benchmark}:${tail.slice(0, last)}`)
  }
  const response = await fetch(new URL('/records', args['--site']),
    { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`records_http_${response.status}`)
  const records = await response.json()
  if (!Array.isArray(records)) throw new Error('invalid_record_list')
  const candidates = []
  for (const listed of records) {
    if (excludedIds.has(listed.trajectory_id)) continue
    const url = new URL('/record', args['--site'])
    url.searchParams.set('id', listed.trajectory_id)
    const rowResponse = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!rowResponse.ok) throw new Error(`record_http_${rowResponse.status}`)
    const candidate = eligibleCandidate(await rowResponse.json(), excludedIds,
      excludedGroups)
    if (candidate) candidates.push(candidate)
  }
  const selected = selectCandidates(candidates, count)
  const manifest = { status: 'provisional_requires_independent_outcome_and_AC_labels',
    cohort: 'gfa_inspection_journey_new_candidates', site: args['--site'],
    selectionRule: 'Exclude prior v2 IDs and task groups; require order/identity verified, completed official failure, >=30 atomic events; SHA-256 order within each framework and deterministic framework round-robin; no annotation labels consulted.',
    excludedPriorCases: excludedIds.size, eligibleNewGroups: new Set(candidates.map(c => c.groupKey)).size,
    requestedCases: count, cases: selected }
  await writeFile(args['--out'], JSON.stringify(manifest, null, 2))
  console.log(JSON.stringify({ listed: records.length, excluded: excludedIds.size,
    eligibleNewGroups: manifest.eligibleNewGroups, selected: selected.length,
    frameworks: selected.reduce((acc, row) =>
      (acc[row.framework] = (acc[row.framework] ?? 0) + 1, acc), {}) }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message); process.exitCode = 1
  })

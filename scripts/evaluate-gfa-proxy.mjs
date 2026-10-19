#!/usr/bin/env node
// Retrospective label-coverage check for GFA-only inspection-order heuristics.
// The labels choose eligible cases and evaluate ranks; they never enter scoring.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { GFA_PROXY_VERSION, prepare, proxyScore, proxyScoreV1 } from './benchmark-gfa-proxy.mjs'
import { screenshotRefs } from './benchmark-gfa-multimodal.mjs'

export function splitFor(benchmark, taskKey) {
  const digest = createHash('sha256').update(`${benchmark}:${taskKey}`).digest('hex')
  return parseInt(digest.slice(0, 8), 16) % 5 === 0 ? 'holdout' : 'development'
}

function positions(item, score) {
  const ranked = item.events.map(event => ({ step: event.step, score: score(event) }))
    .sort((a, b) => b.score - a.score || a.step - b.step)
  return {
    top5: ranked.slice(0, 5),
    originRank: ranked.findIndex(row => row.step === item.gold.origin_step) + 1,
    decisiveRank: ranked.findIndex(row => row.step === item.gold.decisive_step) + 1,
  }
}

export function summarizeRanks(cases, version) {
  const n = cases.length
  const rows = cases.map(row => row[version])
  const count = predicate => rows.filter(predicate).length
  const meanReciprocalRank = field => n
    ? Math.round(1000 * rows.reduce((sum, row) => sum + 1 / row[field], 0) / n) / 1000
    : null
  return {
    cases: n,
    originTop1: count(row => row.originRank === 1),
    decisiveTop1: count(row => row.decisiveRank === 1),
    originTop5: count(row => row.originRank <= 5),
    decisiveTop5: count(row => row.decisiveRank <= 5),
    eitherTop5: count(row => row.originRank <= 5 || row.decisiveRank <= 5),
    bothTop5: count(row => row.originRank <= 5 && row.decisiveRank <= 5),
    originMrr: meanReciprocalRank('originRank'),
    decisiveMrr: meanReciprocalRank('decisiveRank'),
  }
}

export function evaluateRecords(records) {
  const cases = []
  for (const record of records) {
    let item
    try { item = prepare(record) } catch (error) {
      if (error.message === 'case_not_eligible') continue
      throw error
    }
    const trajectory = record.trajectory
    const report = trajectory.report
    if (!record.annotation?.reviewed_at
      || report?.outcome !== 'failure' || report.evaluation_status !== 'completed'
      || report.execution_complete !== true || trajectory.official_score !== 0
      || !item.events.some(event => screenshotRefs(event).length)) continue
    const taskKey = record.run_identity?.task_key
    if (typeof taskKey !== 'string' || !taskKey) continue
    cases.push({ id: item.id, benchmark: item.benchmark,
      framework: item.framework, sourceSha256: item.sourceSha256,
      atomicEventsSha256: item.atomicEventsSha256,
      split: splitFor(item.benchmark, taskKey), totalSteps: item.events.length,
      gold: item.gold, baseline: positions(item, proxyScoreV1),
      v2: positions(item, proxyScore) })
  }
  const summaries = {}
  for (const [name, rows] of [
    ['all', cases], ['development', cases.filter(row => row.split === 'development')],
    ['holdout', cases.filter(row => row.split === 'holdout')],
  ]) {
    summaries[name] = { baseline: summarizeRanks(rows, 'baseline'),
      v2: summarizeRanks(rows, 'v2') }
    summaries[name].byFramework = Object.fromEntries([...new Set(rows.map(row => row.framework))]
      .sort().map(framework => {
        const subset = rows.filter(row => row.framework === framework)
        return [framework, { baseline: summarizeRanks(subset, 'baseline'),
          v2: summarizeRanks(subset, 'v2') }]
      }))
  }
  return {
    cohort: 'completed_official_failure_with_images_and_applicable_agent_harness_labels',
    nativeScorer: 'inspection-priority-v3_abstained',
    baselineVersion: 'gfa_event_type_proxy_v1', candidateVersion: GFA_PROXY_VERSION,
    splitRule: 'SHA-256(benchmark:task_key) first 8 hex digits mod 5; zero is holdout',
    metricCaveat: 'Top-k and MRR measure reviewed origin/decisive position coverage, not true first-inspection value or causal accuracy.',
    recordCount: records.length, summaries, cases,
  }
}

async function fetchRecords(site) {
  const index = await fetch(new URL('/records', site), { signal: AbortSignal.timeout(30000) })
  if (!index.ok) throw new Error(`site_index_http_${index.status}`)
  const rows = await index.json()
  if (!Array.isArray(rows)) throw new Error('invalid_site_index')
  const records = []
  for (let offset = 0; offset < rows.length; offset += 12) {
    const group = await Promise.all(rows.slice(offset, offset + 12).map(async row => {
      const url = new URL('/record', site)
      url.searchParams.set('id', row.trajectory_id)
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!response.ok) throw new Error(`site_record_http_${response.status}`)
      return response.json()
    }))
    records.push(...group)
  }
  return records
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 4 || !['--site', '--records'].includes(args[0])
    || args[2] !== '--out') throw new Error('usage: --site URL | --records JSON --out report.json')
  const records = args[0] === '--site' ? await fetchRecords(args[1])
    : JSON.parse(await readFile(args[1], 'utf8'))
  if (!Array.isArray(records)) throw new Error('invalid_record_file')
  const result = { ...evaluateRecords(records),
    input: args[1], generatedAt: new Date().toISOString() }
  await writeFile(args[3], JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ recordCount: result.recordCount,
    summaries: result.summaries }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1 })

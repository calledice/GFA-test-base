#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const CASE_CLASSES = new Set(['in_trace', 'external_only', 'trace_missing', 'unresolved'])

function key(caseId, mode, checkpointIndex) {
  return `${caseId}\u0000${mode}\u0000${checkpointIndex}`
}

export function evaluateJourney(results, adjudications = [],
  { stepBudget = 30, timeBudgetMs = 600000 } = {}) {
  if (!Array.isArray(results?.cases) || !Array.isArray(adjudications))
    throw new Error('invalid_journey_results')
  const classes = new Map(), verdicts = new Map()
  for (const row of adjudications) {
    if (row.kind === 'case') {
      if (!CASE_CLASSES.has(row.class) || classes.has(row.caseId))
        throw new Error('invalid_case_adjudication')
      classes.set(row.caseId, row)
    } else if (row.kind === 'checkpoint') {
      const id = key(row.caseId, row.mode, row.checkpointIndex)
      if (verdicts.has(id) || typeof row.actionableValid !== 'boolean'
        || typeof row.chainValid !== 'boolean')
        throw new Error('invalid_checkpoint_adjudication')
      verdicts.set(id, row)
    } else throw new Error('invalid_adjudication_kind')
  }
  const byArm = {}, caseClasses = Object.fromEntries([...CASE_CLASSES].map(x => [x, 0]))
  let unadjudicatedClaims = 0, unclassifiedCases = 0
  for (const c of results.cases) {
    const category = classes.get(c.id)
    if (category) caseClasses[category.class]++
    else unclassifiedCases++
    for (const [mode, arm] of Object.entries(c.arms ?? {})) {
      const out = byArm[mode] ??= { cases: 0, actionableCases: 0,
        chainCases: 0, actionableReached: 0, chainReached: 0,
        actionableRestrictedSteps: 0, chainRestrictedSteps: 0,
        actionableRestrictedMs: 0, chainRestrictedMs: 0,
        costTokens: 0, costElapsedMs: 0, openedSteps: 0,
        transmittedImages: 0, unadjudicated: 0 }
      out.cases++
      out.costTokens += arm.usage?.total_tokens ?? 0
      out.costElapsedMs += arm.totalElapsedMs ?? 0
      out.openedSteps += arm.openedSteps?.length ?? 0
      out.transmittedImages += arm.transmittedImages ?? 0
      const checkpoints = arm.checkpoints ?? []
      const unknown = checkpoints.some(checkpoint => {
        if (!checkpoint.actionable && !checkpoint.chain) return false
        const verdict = verdicts.get(key(c.id, mode, checkpoint.index))
        if (!verdict) { unadjudicatedClaims++; return true }
        if (verdict.actionableValid && !checkpoint.actionable
          || verdict.chainValid && !checkpoint.chain)
          throw new Error('verdict_without_claim')
        return false
      })
      if (!category || unknown) {
        out.unadjudicated++
        continue
      }
      const actionableEligible = category.actionableEligible
        ?? category.class === 'in_trace'
      const chainEligible = category.chainEligible
        ?? category.class === 'in_trace'
      const first = field => checkpoints.find(checkpoint =>
        verdicts.get(key(c.id, mode, checkpoint.index))?.[field] === true)
      if (actionableEligible) {
        out.actionableCases++
        const point = first('actionableValid')
        if (point) out.actionableReached++
        out.actionableRestrictedSteps += point?.distinctSteps ?? stepBudget + 1
        out.actionableRestrictedMs += point?.elapsedMs ?? timeBudgetMs
      }
      if (chainEligible) {
        out.chainCases++
        const point = first('chainValid')
        if (point) out.chainReached++
        out.chainRestrictedSteps += point?.distinctSteps ?? stepBudget + 1
        out.chainRestrictedMs += point?.elapsedMs ?? timeBudgetMs
      }
    }
  }
  for (const out of Object.values(byArm)) {
    if (!out.actionableCases && out.unadjudicated) out.actionableReached = null
    if (!out.chainCases && out.unadjudicated) out.chainReached = null
    out.meanActionableRestrictedSteps = out.actionableCases
      ? out.actionableRestrictedSteps / out.actionableCases : null
    out.meanChainRestrictedSteps = out.chainCases
      ? out.chainRestrictedSteps / out.chainCases : null
    out.meanActionableRestrictedMs = out.actionableCases
      ? out.actionableRestrictedMs / out.actionableCases : null
    out.meanChainRestrictedMs = out.chainCases
      ? out.chainRestrictedMs / out.chainCases : null
  }
  return { adjudicationStatus: unclassifiedCases || unadjudicatedClaims
    ? adjudications.length ? 'partial' : 'unadjudicated' : 'complete',
  caseClasses, unclassifiedCases, unadjudicatedClaims,
  budgets: { stepBudget, timeBudgetMs }, byArm }
}

async function main(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2)
    args[argv[index]] = argv[index + 1]
  if (!args['--results'] || !args['--out'] || argv.length % 2)
    throw new Error('usage: --results FILE --out FILE [--labels JSONL]')
  const results = JSON.parse(await readFile(args['--results'], 'utf8'))
  const labels = args['--labels']
    ? (await readFile(args['--labels'], 'utf8')).split(/\r?\n/)
      .filter(Boolean).map(line => JSON.parse(line)) : []
  await writeFile(args['--out'], JSON.stringify(evaluateJourney(results, labels), null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message); process.exitCode = 1
  })

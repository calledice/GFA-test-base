#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const CLASSES = new Set(['in_trace', 'external_only', 'trace_missing', 'unresolved'])
const PREFIXES = [5, 10]

function checkpointKey(caseId, mode, index) {
  return JSON.stringify([caseId, mode, index])
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function buildLabels(labels) {
  const cases = new Map(), checkpoints = new Map()
  for (const row of labels) {
    if (row.kind === 'case') {
      if (!nonemptyString(row.caseId) || cases.has(row.caseId)
        || !CLASSES.has(row.class)
        || typeof row.actionableEligible !== 'boolean'
        || typeof row.chainEligible !== 'boolean'
        || !Array.isArray(row.goldChains))
        throw new Error('invalid_case_label')
      const ids = new Set(), allEdges = new Set()
      for (const chain of row.goldChains) {
        if (!nonemptyString(chain.id) || ids.has(chain.id)
          || !Array.isArray(chain.edgeIds) || !chain.edgeIds.length
          || chain.edgeIds.some(edge => !nonemptyString(edge))
          || new Set(chain.edgeIds).size !== chain.edgeIds.length)
          throw new Error('invalid_gold_chain')
        ids.add(chain.id)
        for (const edge of chain.edgeIds) allEdges.add(edge)
      }
      if (row.chainEligible !== (row.goldChains.length > 0))
        throw new Error('chain_eligibility_mismatch')
      cases.set(row.caseId, { ...row, allEdges })
    } else if (row.kind === 'checkpoint') {
      const key = checkpointKey(row.caseId, row.mode, row.checkpointIndex)
      if (!nonemptyString(row.caseId) || !nonemptyString(row.mode)
        || !Number.isInteger(row.checkpointIndex) || row.checkpointIndex < 0
        || checkpoints.has(key)
        || typeof row.hypothesisValid !== 'boolean'
        || row.canonicalHypothesisId !== null
          && !nonemptyString(row.canonicalHypothesisId)
        || row.hypothesisValid !== (row.canonicalHypothesisId !== null)
        || !Array.isArray(row.supportedEdgeIds)
        || row.supportedEdgeIds.some(edge => !nonemptyString(edge))
        || new Set(row.supportedEdgeIds).size !== row.supportedEdgeIds.length
        || !Number.isInteger(row.unsupportedEdgeCount)
        || row.unsupportedEdgeCount < 0
        || typeof row.completeChainValid !== 'boolean')
        throw new Error('invalid_checkpoint_label')
      checkpoints.set(key, row)
    } else throw new Error('invalid_label_kind')
  }
  return { cases, checkpoints }
}

function coverage(goldChains, supported) {
  if (!goldChains.length) return null
  return Math.max(...goldChains.map(chain =>
    chain.edgeIds.filter(edge => supported.has(edge)).length / chain.edgeIds.length))
}

function metricsForArm(caseId, mode, arm, category, verdicts, budgets) {
  if (!Array.isArray(arm.checkpoints) || !Array.isArray(arm.openedSteps)
    || arm.openedSteps.length > budgets.stepBudget)
    throw new Error('invalid_arm_log')
  const seenIds = new Set(), supported = new Set()
  const prefixes = Object.fromEntries(PREFIXES.map(k =>
    [k, { hypothesisIds: new Set(), supportedEdges: new Set() }]))
  let firstHypothesis = null, firstChain = null, invalidHypotheses = 0
  let repeatedHypotheses = 0, unsupportedEdgeCount = 0
  let previousSteps = 0, previousMs = 0
  for (let i = 0; i < arm.checkpoints.length; i++) {
    const point = arm.checkpoints[i]
    if (point.index !== i || !Number.isInteger(point.distinctSteps)
      || point.distinctSteps < 1 || point.distinctSteps > arm.openedSteps.length
      || point.distinctSteps < previousSteps
      || !Number.isFinite(point.elapsedMs) || point.elapsedMs < previousMs
      || point.openedSteps?.length !== point.distinctSteps
      || point.openedSteps.some((step, n) => step !== arm.openedSteps[n]))
      throw new Error('invalid_checkpoint_log')
    previousSteps = point.distinctSteps
    previousMs = point.elapsedMs
    // A model response arriving after the time cap cannot create a reached outcome.
    if (point.elapsedMs > budgets.timeBudgetMs) continue
    const hasHypothesis = point.actionable != null
    const hasChain = point.chain != null
    if (!hasHypothesis && !hasChain) continue
    const verdict = verdicts.get(checkpointKey(caseId, mode, point.index))
    if (!verdict) return { status: 'unadjudicated',
      missingCheckpoint: point.index }
    if ((!hasHypothesis && (verdict.hypothesisValid
      || verdict.canonicalHypothesisId !== null))
      || (!hasChain && (verdict.supportedEdgeIds.length
        || verdict.unsupportedEdgeCount || verdict.completeChainValid))
      || verdict.supportedEdgeIds.some(edge => !category.allEdges.has(edge))
      || (verdict.hypothesisValid && !category.actionableEligible)
      || (verdict.completeChainValid && !category.chainEligible))
      throw new Error('contradictory_checkpoint_label')
    if (hasHypothesis) {
      if (!verdict.hypothesisValid) invalidHypotheses++
      else if (seenIds.has(verdict.canonicalHypothesisId))
        repeatedHypotheses++
      else {
        seenIds.add(verdict.canonicalHypothesisId)
        firstHypothesis ??= { steps: point.distinctSteps, ms: point.elapsedMs,
          checkpointIndex: point.index }
      }
    }
    if (hasChain) {
      unsupportedEdgeCount += verdict.unsupportedEdgeCount
      for (const edge of verdict.supportedEdgeIds) supported.add(edge)
      if (verdict.completeChainValid && coverage(category.goldChains, supported) !== 1)
        throw new Error('complete_chain_without_covered_reference')
      if (verdict.completeChainValid)
        firstChain ??= { steps: point.distinctSteps, ms: point.elapsedMs,
          checkpointIndex: point.index }
    }
    for (const k of PREFIXES) {
      if (point.distinctSteps > k) continue
      if (verdict.hypothesisValid)
        prefixes[k].hypothesisIds.add(verdict.canonicalHypothesisId)
      for (const edge of verdict.supportedEdgeIds)
        prefixes[k].supportedEdges.add(edge)
    }
  }
  const at = Object.fromEntries(PREFIXES.map(k => [k, {
    hgr: category.actionableEligible
      ? prefixes[k].hypothesisIds.size / k : null,
    ccc: category.chainEligible
      ? coverage(category.goldChains, prefixes[k].supportedEdges) : null,
  }]))
  return {
    status: 'adjudicated',
    fhc: category.actionableEligible ? firstHypothesis?.steps ?? null : null,
    fhcMs: category.actionableEligible ? firstHypothesis?.ms ?? null : null,
    fhcReached: category.actionableEligible ? Boolean(firstHypothesis) : null,
    fhcRestrictedSteps: category.actionableEligible
      ? firstHypothesis?.steps ?? budgets.stepBudget + 1 : null,
    fhcRestrictedMs: category.actionableEligible
      ? firstHypothesis?.ms ?? budgets.timeBudgetMs : null,
    chainSteps: category.chainEligible ? firstChain?.steps ?? null : null,
    chainMs: category.chainEligible ? firstChain?.ms ?? null : null,
    chainReached: category.chainEligible ? Boolean(firstChain) : null,
    chainRestrictedSteps: category.chainEligible
      ? firstChain?.steps ?? budgets.stepBudget + 1 : null,
    chainRestrictedMs: category.chainEligible
      ? firstChain?.ms ?? budgets.timeBudgetMs : null,
    hgrAt5: at[5].hgr, hgrAt10: at[10].hgr,
    cccAt5: at[5].ccc, cccAt10: at[10].ccc,
    cccEnd: category.chainEligible
      ? coverage(category.goldChains, supported) : null,
    validDistinctHypotheses: seenIds.size, invalidHypotheses,
    repeatedHypotheses, unsupportedEdgeCount,
    openedSteps: arm.openedSteps.length,
    totalElapsedMs: arm.totalElapsedMs ?? null,
    totalTokens: arm.usage?.total_tokens ?? null,
  }
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

function summarize(perCase, modes) {
  const byArm = {}
  for (const mode of modes) {
    const rows = perCase.map(row => row.arms[mode])
      .filter(row => row?.status === 'adjudicated')
    const nonNull = key => rows.map(row => row[key]).filter(value => value !== null)
    const fhcRows = rows.filter(row => row.fhcReached !== null)
    const chainRows = rows.filter(row => row.chainReached !== null)
    byArm[mode] = {
      adjudicatedCases: rows.length,
      fhcEligibleCases: fhcRows.length,
      chainEligibleCases: chainRows.length,
      meanFhcRestrictedSteps: mean(nonNull('fhcRestrictedSteps')),
      meanFhcRestrictedMs: mean(nonNull('fhcRestrictedMs')),
      fhcReachRate: mean(nonNull('fhcReached').map(Number)),
      fhcReachByStep: Object.fromEntries([1, 3, 5, 10, 30].map(k =>
        [k, mean(fhcRows.map(row => Number(row.fhc !== null && row.fhc <= k)))])),
      meanChainRestrictedSteps: mean(nonNull('chainRestrictedSteps')),
      meanChainRestrictedMs: mean(nonNull('chainRestrictedMs')),
      chainReachRate: mean(nonNull('chainReached').map(Number)),
      meanHgrAt5: mean(nonNull('hgrAt5')),
      meanHgrAt10: mean(nonNull('hgrAt10')),
      meanCccAt5: mean(nonNull('cccAt5')),
      meanCccAt10: mean(nonNull('cccAt10')),
      meanCccEnd: mean(nonNull('cccEnd')),
      meanTotalElapsedMs: mean(nonNull('totalElapsedMs')),
      meanTotalTokens: mean(nonNull('totalTokens')),
      meanOpenedSteps: mean(nonNull('openedSteps')),
      invalidHypotheses: rows.reduce((sum, row) => sum + row.invalidHypotheses, 0),
      repeatedHypotheses: rows.reduce((sum, row) => sum + row.repeatedHypotheses, 0),
      unsupportedEdges: rows.reduce((sum, row) => sum + row.unsupportedEdgeCount, 0),
    }
  }
  const paired = perCase.filter(row =>
    row.arms.ranked?.status === 'adjudicated'
    && row.arms.chronological?.status === 'adjudicated')
  const fhcPairs = paired.filter(row => row.arms.ranked.fhcRestrictedSteps !== null
    && row.arms.chronological.fhcRestrictedSteps !== null)
  const chainPairs = paired.filter(row =>
    row.arms.ranked.chainRestrictedSteps !== null
    && row.arms.chronological.chainRestrictedSteps !== null)
  return { byArm, rankedMinusChronological: {
    pairedCases: paired.length,
    fhcPairedCases: fhcPairs.length,
    chainPairedCases: chainPairs.length,
    meanFhcRestrictedStepDifference: mean(fhcPairs.map(row =>
      row.arms.ranked.fhcRestrictedSteps - row.arms.chronological.fhcRestrictedSteps)),
    meanChainRestrictedStepDifference: mean(chainPairs.map(row =>
      row.arms.ranked.chainRestrictedSteps
      - row.arms.chronological.chainRestrictedSteps)),
  } }
}

export function evaluateInvestigation(results, labels = [],
  budgets = { stepBudget: 30, timeBudgetMs: 600000 }) {
  if (!Array.isArray(results?.cases) || !results.cases.length
    || !Array.isArray(labels)
    || !Number.isInteger(budgets.stepBudget) || budgets.stepBudget < 1
    || !Number.isInteger(budgets.timeBudgetMs) || budgets.timeBudgetMs < 1)
    throw new Error('invalid_evaluation_input')
  const { cases, checkpoints } = buildLabels(labels)
  const seenCases = new Set(), usedLabels = new Set()
  const modes = new Set(), perCase = []
  for (const c of results.cases) {
    if (!nonemptyString(c.id) || seenCases.has(c.id) || !c.arms)
      throw new Error('invalid_case_log')
    seenCases.add(c.id)
    const category = cases.get(c.id)
    const entry = { caseId: c.id, class: category?.class ?? null, arms: {} }
    for (const [mode, arm] of Object.entries(c.arms)) {
      modes.add(mode)
      if (!category) {
        entry.arms[mode] = { status: 'unadjudicated', reason: 'missing_case_label' }
        continue
      }
      const result = metricsForArm(c.id, mode, arm, category, checkpoints, budgets)
      entry.arms[mode] = result
      for (const point of arm.checkpoints ?? [])
        if (point.actionable != null || point.chain != null)
          usedLabels.add(checkpointKey(c.id, mode, point.index))
    }
    perCase.push(entry)
  }
  if ([...checkpoints.keys()].some(key => !usedLabels.has(key))
    || [...cases.keys()].some(key => !seenCases.has(key)))
    throw new Error('label_without_log')
  const summary = summarize(perCase, modes)
  return { version: 'investigation-prioritization-evaluation-v1',
    status: perCase.every(row => Object.values(row.arms)
      .every(arm => arm.status === 'adjudicated'))
      ? 'adjudicated' : 'unadjudicated',
    budgets,
    caseClasses: Object.fromEntries([...CLASSES].map(name =>
      [name, perCase.filter(row => row.class === name).length])),
    unclassifiedCases: perCase.filter(row => row.class === null).length,
    cases: perCase, ...summary }
}

async function main(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2)
    args[argv[i]] = argv[i + 1]
  if (argv.length % 2 || !args['--results'] || !args['--labels']
    || !args['--out'])
    throw new Error('usage: --results FILE --labels JSONL --out FILE')
  const results = JSON.parse(await readFile(args['--results'], 'utf8'))
  const labels = (await readFile(args['--labels'], 'utf8'))
    .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  await writeFile(args['--out'],
    JSON.stringify(evaluateInvestigation(results, labels), null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message); process.exitCode = 1
  })

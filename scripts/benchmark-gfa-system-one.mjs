#!/usr/bin/env node
// GFA-only System 1 text ranking followed by one full multimodal localization.
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { eventView, prepare } from './benchmark-gfa-proxy.mjs'
import { createImageLoader, runMultimodalCase, screenshotRefs,
  verifySelectedCase } from './benchmark-gfa-multimodal.mjs'

export const SYSTEM_ONE_SCORE_SOURCE = 'gfa_system_one_text_candidate_v1'
const BATCH_SIZE = 64
const ENTRY_COUNT = 5
export const SYSTEM_ONE_QUESTIONS = {
  origin: {
    type: 'choice',
    instructions: 'Does the CURRENT numbered event contain the earliest causally wrong agent decision or action for this task?',
    criteria: {
      A: 'The current event is the earliest causally wrong agent decision or action.',
      B: 'The current event is not established as the earliest causally wrong agent decision or action.',
    },
  },
  decisive: {
    type: 'choice',
    instructions: 'Does the CURRENT numbered event establish this task failure after considering any visible recovery?',
    criteria: {
      A: 'The current event establishes the task failure.',
      B: 'The current event does not establish the task failure.',
    },
  },
}

export function systemOneStates(item) {
  return item.events.map((event, index) => {
    const previous = item.events[index - 1]
    const next = item.events[index + 1]
    const view = eventView(event)
    const context = neighbor => neighbor ? {
      step: neighbor.step, type: neighbor.step_type,
      content: eventView(neighbor).content.slice(0, 100),
    } : null
    return { body: JSON.stringify({
      CURRENT: { ...view, content: view.content.slice(0, 500) },
      task: item.instruction.slice(0, 300), totalEvents: item.events.length,
      previous: context(previous), next: context(next),
      screenshotCount: screenshotRefs(event).length,
    }) }
  })
}

function candidateProbability(result, question) {
  const probability = result?.answers?.[question]?.probabilities?.A
  if (!Number.isFinite(probability) || probability < 0 || probability > 1)
    throw new Error('system_one_probability_unavailable')
  return probability
}

export async function scoreWithSystemOne(item, url, model, fetcher = fetch,
  apiKey = process.env.SYSTEM_ONE_API_KEY ?? '') {
  const states = systemOneStates(item)
  const scores = []
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  let elapsedMs = 0, truncatedStates = 0, stateTokensDropped = 0
  for (let offset = 0; offset < states.length; offset += BATCH_SIZE) {
    const batch = states.slice(offset, offset + BATCH_SIZE)
    const started = performance.now()
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, states: batch,
        questions: SYSTEM_ONE_QUESTIONS }),
      signal: AbortSignal.timeout(240000),
    })
    const payload = await response.json()
    elapsedMs += Math.round(performance.now() - started)
    if (!response.ok) throw new Error(`system_one_http_${response.status}`)
    if (!Array.isArray(payload.results) || payload.results.length !== batch.length
      || !Number.isInteger(payload.total_usage?.input_tokens)
      || !Number.isInteger(payload.total_usage?.output_tokens))
      throw new Error('invalid_system_one_batch')
    usage.input_tokens += payload.total_usage.input_tokens
    usage.output_tokens += payload.total_usage.output_tokens
    usage.total_tokens += payload.total_usage.input_tokens
      + payload.total_usage.output_tokens
    for (let index = 0; index < payload.results.length; index++) {
      const event = item.events[offset + index]
      const result = payload.results[index]
      if (result.usage?.truncated === true) truncatedStates++
      stateTokensDropped += result.usage?.state_tokens_dropped ?? 0
      scores.push({ step: event.step,
        origin: candidateProbability(result, 'origin'),
        decisive: candidateProbability(result, 'decisive') })
    }
  }
  if (truncatedStates || stateTokensDropped)
    throw new Error(`system_one_input_truncated:${truncatedStates}:${stateTokensDropped}`)
  const ranked = scores.map(row => ({ event: item.events.find(event =>
    event.step === row.step), score: Math.max(row.origin, row.decisive) }))
    .sort((a, b) => b.score - a.score || a.event.step - b.event.step)
  return { model, scoreSource: SYSTEM_ONE_SCORE_SOURCE, scores, ranked,
    entrySteps: ranked.slice(0, ENTRY_COUNT).map(row => row.event.step),
    calls: Math.ceil(states.length / BATCH_SIZE), elapsedMs, usage,
    imageCount: 0, truncatedStates, stateTokensDropped }
}

export async function runSystemOneCase(item, site, systemOneUrl, systemOneModel,
  apiUrl, localizationModel, scoreCall = scoreWithSystemOne,
  localizationCall, imageLoader = createImageLoader(site)) {
  const started = performance.now()
  const ranking = await scoreCall(item, systemOneUrl, systemOneModel)
  if (ranking.ranked.length !== item.events.length
    || new Set(ranking.ranked.map(row => row.event.step)).size !== item.events.length)
    throw new Error('incomplete_system_one_ranking')
  const scoredItem = { ...item, ranked: ranking.ranked,
    scoreSource: SYSTEM_ONE_SCORE_SOURCE }
  const arm = await runMultimodalCase(scoredItem, site, apiUrl, localizationModel,
    localizationCall, imageLoader)
  const localization = await arm.guided()
  return { ranking: {
    scoreSource: ranking.scoreSource, model: ranking.model,
    scores: ranking.scores, entrySteps: ranking.entrySteps,
    calls: ranking.calls, elapsedMs: ranking.elapsedMs,
    usage: ranking.usage, imageCount: ranking.imageCount,
    truncatedStates: ranking.truncatedStates ?? null,
    stateTokensDropped: ranking.stateTokensDropped ?? null },
  localization, totalElapsedMs: Math.round(performance.now() - started),
  totalTokens: ranking.usage.total_tokens + localization.usage.total_tokens,
  totalModelCalls: ranking.calls + localization.calls,
  transmittedImages: ranking.imageCount + localization.transmittedImages }
}

export function summarizeSystemOne(cases) {
  const sum = fn => cases.reduce((total, row) => total + fn(row.systemOne), 0)
  const exact = field => cases.filter(row =>
    row.systemOne.localization.answer[field] === row.gold[field]).length
  const summary = { cases: cases.length, originExact: exact('origin_step'),
    decisiveExact: exact('decisive_step'),
    pairExact: cases.filter(row =>
      row.systemOne.localization.answer.origin_step === row.gold.origin_step
      && row.systemOne.localization.answer.decisive_step === row.gold.decisive_step).length,
    abstentions: sum(row => Number(!row.localization.answer.done)),
    systemOneCalls: sum(row => row.ranking.calls),
    localizationCalls: sum(row => row.localization.calls),
    systemOneTokens: sum(row => row.ranking.usage.total_tokens),
    localizationTokens: sum(row => row.localization.usage.total_tokens),
    totalTokens: sum(row => row.totalTokens),
    systemOneElapsedMs: sum(row => row.ranking.elapsedMs),
    localizationElapsedMs: sum(row => row.localization.elapsedMs),
    totalElapsedMs: sum(row => row.totalElapsedMs),
    transmittedStepInstances: sum(row => row.localization.inspectedSteps),
    transmittedImages: sum(row => row.transmittedImages) }
  if (cases.length && cases.every(row => row.historicalDirect)) {
    const previous = fn => cases.reduce((total, row) =>
      total + fn(row.historicalDirect), 0)
    summary.historicalDirect = {
      originExact: cases.filter(row => row.historicalDirect.answer.origin_step
        === row.gold.origin_step).length,
      decisiveExact: cases.filter(row => row.historicalDirect.answer.decisive_step
        === row.gold.decisive_step).length,
      pairExact: cases.filter(row => row.historicalDirect.answer.origin_step
        === row.gold.origin_step && row.historicalDirect.answer.decisive_step
        === row.gold.decisive_step).length,
      totalTokens: previous(row => row.usage.total_tokens),
      totalElapsedMs: previous(row => row.totalElapsedMs),
      transmittedStepInstances: previous(row => row.transmittedStepInstances),
      transmittedImages: previous(row => row.transmittedImages),
    }
  }
  return summary
}

function argumentsFrom(argv) {
  if (argv.length % 2) throw new Error('expected_flag_value_pairs')
  const args = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--') || args.has(argv[index]))
      throw new Error('invalid_arguments')
    args.set(argv[index], argv[index + 1])
  }
  const required = ['--manifest', '--out', '--site', '--system-one-url',
    '--system-one-model', '--api-url', '--model']
  if (required.some(key => !args.get(key))
    || [...args.keys()].some(key => ![...required, '--baseline'].includes(key)))
    throw new Error(`usage: ${required.map(key => `${key} VALUE`).join(' ')} [--baseline THREE_ARM_RESULTS]`)
  return args
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2))
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY_required')
  const manifest = JSON.parse(await readFile(args.get('--manifest'), 'utf8'))
  if (manifest.cohort !== 'completed_official_failure_holdout_long_traces'
    || manifest.site !== args.get('--site') || manifest.cases?.length !== 6)
    throw new Error('invalid_manifest')
  const baseline = args.has('--baseline')
    ? JSON.parse(await readFile(args.get('--baseline'), 'utf8')) : null
  const cases = []
  for (const selected of manifest.cases) {
    const url = new URL('/record', args.get('--site'))
    url.searchParams.set('id', selected.id)
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`site_http_${response.status}`)
    const record = await response.json()
    const item = prepare(record)
    verifySelectedCase(record, item, selected, true)
    if (selected.steps !== item.events.length
      || selected.distinctImages !== new Set(item.events.flatMap(screenshotRefs)
        .map(ref => ref.sha256)).size)
      throw new Error('manifest_event_or_image_count_changed')
    const previous = baseline?.cases?.find(row => row.id === item.id)
    if (baseline && (!previous || previous.sourceSha256 !== item.sourceSha256
      || previous.atomicEventsSha256 !== item.atomicEventsSha256))
      throw new Error('baseline_case_mismatch')
    const systemOne = await runSystemOneCase(item, args.get('--site'),
      args.get('--system-one-url'), args.get('--system-one-model'),
      args.get('--api-url'), args.get('--model'))
    cases.push({ id: item.id, sourceSha256: item.sourceSha256,
      atomicEventsSha256: item.atomicEventsSha256,
      framework: item.framework, benchmark: item.benchmark,
      totalSteps: item.events.length, gold: item.gold,
      historicalDirect: previous?.direct ?? null, systemOne })
    await writeFile(args.get('--out'), JSON.stringify({ status: 'partial',
      cases, summary: summarizeSystemOne(cases) }, null, 2))
    console.log(`completed ${cases.length}/${manifest.cases.length}`)
  }
  await writeFile(args.get('--out'), JSON.stringify({ status: 'complete',
    cohort: manifest.cohort, scoreSource: SYSTEM_ONE_SCORE_SOURCE,
    systemOneInput: 'text event and adjacent summaries; screenshots are not read by System 1',
    localizationInput: 'one full trajectory with all verified screenshots',
    model: args.get('--model'), systemOneModel: args.get('--system-one-model'),
    historicalBaseline: baseline ? args.get('--baseline') : null,
    cases, summary: summarizeSystemOne(cases) }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1 })

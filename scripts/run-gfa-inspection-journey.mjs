#!/usr/bin/env node
import { readFile, writeFile, rename } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { GFA_PROXY_VERSION } from './benchmark-gfa-proxy.mjs'
import { createImageLoader, verifySelectedCase } from './benchmark-gfa-multimodal.mjs'
import { createEvidenceStore, prepareInspectionCase } from './gfa-inspection-evidence.mjs'
import { runJourney } from './benchmark-gfa-inspection-journey.mjs'
import { createModelInvestigator } from './gfa-inspection-model.mjs'

const ARMS = ['ranked', 'chronological', 'self_directed']

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key.startsWith('--')) throw new Error('invalid_argument')
    if (key === '--dry-run') args.dryRun = true
    else { args[key.slice(2)] = argv[++i]; if (args[key.slice(2)] == null)
      throw new Error(`missing_value_${key}`) }
  }
  if (!args.manifest || !args.out || !args.site)
    throw new Error('required: --manifest FILE --out FILE --site URL')
  if (!args.dryRun && (!args['api-url'] || !args.model || !process.env.OPENAI_API_KEY))
    throw new Error('model_run_requires_api_url_model_and_OPENAI_API_KEY')
  if (args['case-limit'] && (!Number.isInteger(Number(args['case-limit']))
    || Number(args['case-limit']) < 1)) throw new Error('invalid_case_limit')
  if (args['case-index'] && (!Number.isInteger(Number(args['case-index']))
    || Number(args['case-index']) < 1)) throw new Error('invalid_case_index')
  if (args.arms && args.arms.split(',').some(arm => !ARMS.includes(arm)))
    throw new Error('invalid_arms')
  return args
}

export function createDryRunInvestigator() {
  let opened = false, read = false
  return async state => {
    if (!opened) {
      opened = true
      return { decision: { action: 'open_step',
        step: state.recommendations[0] ?? state.index[0].step, memo: '' } }
    }
    const checkpoint = { actionable: null, chain: null }
    if (!read && state.lastEvidence?.kind === 'step') {
      const longField = state.lastEvidence.fields.find(field => field.inline === null)
      if (longField) {
        read = true
        return { decision: { action: 'read_chunk',
          step: state.lastEvidence.step, field: longField.name,
          chunkIndex: 0, memo: '', checkpoint } }
      }
    }
    return { decision: { action: 'finish', memo: '', checkpoint } }
  }
}

async function saveJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, JSON.stringify(value, null, 2))
  await rename(temporary, path)
}

export async function runManifest(args, modelFactory = createModelInvestigator) {
  const manifest = JSON.parse(await readFile(args.manifest, 'utf8'))
  if (!Array.isArray(manifest.cases) || !manifest.cases.length
    || manifest.site !== args.site
    || new Set(manifest.cases.map(row => row.id)).size !== manifest.cases.length)
    throw new Error('invalid_manifest')
  const output = { status: 'partial', kind: 'gfa_inspection_journey_pilot',
    scoreSource: GFA_PROXY_VERSION, evidencePolicy: 'full fields, chunked on demand; all verified step images',
    adjudication: 'none', model: args.dryRun ? null : args.model,
    cases: [] }
  const startIndex = Number(args['case-index'] ?? 1) - 1
  if (startIndex >= manifest.cases.length) throw new Error('case_index_out_of_range')
  const caseLimit = Math.min(manifest.cases.length - startIndex,
    Number(args['case-limit'] ?? manifest.cases.length))
  output.selection = { manifestCases: manifest.cases.length,
    firstCaseIndex: startIndex + 1, selectedCases: caseLimit,
    arms: args.arms?.split(',') ?? ARMS,
    dryRun: args.dryRun === true,
    maxDistinctSteps: Number(args['max-steps'] ?? 30),
    maxElapsedMs: Number(args['max-ms'] ?? 600000),
    maxCalls: Number(args['max-calls'] ?? 120) }
  for (let offset = 0; offset < caseLimit; offset++) {
    const caseIndex = startIndex + offset
    const selected = manifest.cases[caseIndex]
    const url = new URL('/record', args.site)
    url.searchParams.set('id', selected.id)
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`case_http_${response.status}`)
    const record = await response.json()
    const item = prepareInspectionCase(record)
    verifySelectedCase(record, item, selected, true)
    const caseResult = { id: item.id, sourceSha256: item.sourceSha256,
      atomicEventsSha256: item.atomicEventsSha256,
      totalSteps: item.events.length, framework: item.framework,
      benchmark: item.benchmark, arms: {} }
    output.cases.push(caseResult)
    const order = [...ARMS.slice(caseIndex % 3), ...ARMS.slice(0, caseIndex % 3)]
      .filter(mode => !args.arms || args.arms.split(',').includes(mode))
    for (const mode of order) {
      const setupStart = performance.now()
      const loadImage = createImageLoader(args.site)
      const store = createEvidenceStore(item, { loadImage })
      const setupMs = performance.now() - setupStart
      const investigator = args.dryRun ? createDryRunInvestigator()
        : modelFactory({ apiUrl: args['api-url'], model: args.model })
      const run = await runJourney(item, mode, investigator, store, {
        maxDistinctSteps: Number(args['max-steps'] ?? 30),
        maxElapsedMs: Number(args['max-ms'] ?? 600000),
        maxCalls: Number(args['max-calls'] ?? 120), setupMs })
      if (args.dryRun) {
        run.simulatedImageDeliveries = run.transmittedImages
        run.simulatedImageBytes = run.transmittedImageBytes
        run.transmittedImages = 0
        run.transmittedImageBytes = 0
      }
      caseResult.arms[mode] = run
      await saveJson(args.out, output)
      console.log(`case ${offset + 1}/${caseLimit} ${mode}: steps=${run.openedSteps.length} calls=${run.events.length} images=${run.transmittedImages} tokens=${run.usage.total_tokens} end=${run.termination}`)
    }
  }
  output.status = 'complete'
  await saveJson(args.out, output)
  return output
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runManifest(parseArgs(process.argv.slice(2))).catch(error => {
    console.error(error.message); process.exitCode = 1
  })

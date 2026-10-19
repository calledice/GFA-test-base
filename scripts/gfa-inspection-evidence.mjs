import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { screenshotRefs } from './benchmark-gfa-multimodal.mjs'
import { proxyScore } from './benchmark-gfa-proxy.mjs'

const DEFAULT_CHUNK_CHARS = 6000

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function chunksOf(text, size) {
  const chars = Array.from(text)
  const chunks = []
  for (let offset = 0; offset < chars.length; offset += size)
    chunks.push(chars.slice(offset, offset + size).join(''))
  return chunks.length ? chunks : ['']
}

export function prepareInspectionCase(record) {
  const trajectory = record?.trajectory
  if (!trajectory || trajectory.order_verified !== true
    || record.run_identity?.identity_matches !== true
    || !Array.isArray(trajectory.atomic_events))
    throw new Error('invalid_inspection_trajectory')
  const events = trajectory.atomic_events.filter(event =>
    event.step_type !== 'task_definition')
  if (events.length < 2 || new Set(events.map(event => event.step)).size !== events.length)
    throw new Error('invalid_inspection_events')
  const instruction = trajectory.atomic_events.find(event =>
    event.step_type === 'task_definition')?.output?.instruction
    ?? trajectory.instruction
  if (typeof instruction !== 'string' || !instruction.length)
    throw new Error('full_task_instruction_unavailable')
  const scoringStart = performance.now()
  const ranked = events.map(event => ({ event, score: proxyScore(event) }))
    .sort((a, b) => b.score - a.score || a.event.step - b.event.step)
  return { id: trajectory.trajectory_id,
    sourceSha256: trajectory.source_sha256,
    atomicEventsSha256: trajectory.atomic_events_sha256,
    framework: trajectory.framework, benchmark: trajectory.benchmark,
    instruction, events, ranked,
    proxyScoringMs: performance.now() - scoringStart }
}

export function createEvidenceStore(item, { loadImage, chunkChars = DEFAULT_CHUNK_CHARS } = {}) {
  if (!item || !Array.isArray(item.events) || !Array.isArray(item.ranked)
    || !Number.isInteger(chunkChars) || chunkChars < 1
    || typeof loadImage !== 'function') throw new Error('invalid_evidence_store_input')
  const events = new Map(item.events.map(event => [event.step, event]))
  if (events.size !== item.events.length) throw new Error('duplicate_step')
  const fields = new Map(item.events.map(event => {
    const rows = new Map(Object.entries(event)
      .map(([name, value]) => {
        const text = JSON.stringify(value)
        return [name, { text, parts: chunksOf(text, chunkChars), sha256: sha256(text) }]
      }))
    return [event.step, rows]
  }))
  const index = () => item.events.map(event => ({
    step: event.step, type: event.step_type,
    actor: event.acting_agent ?? event.producer?.id ?? 'unknown',
    hasImage: screenshotRefs(event).length > 0,
  }))
  const recommend = (mode, opened) => {
    if (!(opened instanceof Set)) throw new Error('opened_steps_required')
    if (mode === 'self_directed') return []
    const ordered = mode === 'ranked' ? item.ranked.map(row => row.event)
      : mode === 'chronological' ? item.events : null
    if (!ordered) throw new Error('invalid_inspection_mode')
    return ordered.filter(event => !opened.has(event.step)).slice(0, 5)
      .map(event => event.step)
  }
  const openStep = async step => {
    const event = events.get(step)
    if (!event) throw new Error('unknown_step')
    const refs = screenshotRefs(event)
    const seen = new Set()
    const images = []
    for (const ref of refs) {
      if (seen.has(ref.sha256)) continue
      images.push({ step, phase: ref.phase, index: ref.index,
        sha256: ref.sha256, bytes: ref.bytes,
        imageUrl: await loadImage(item.id, ref) })
      seen.add(ref.sha256)
    }
    return { step, fields: [...fields.get(step)].map(([name, value]) => ({
      name, sha256: value.sha256, codePoints: Array.from(value.text).length,
      chunks: value.parts.length,
      inline: value.parts.length === 1 ? value.text : null,
    })), images }
  }
  const readChunk = (step, field, chunkIndex) => {
    const value = fields.get(step)?.get(field)
    if (!value || !Number.isInteger(chunkIndex) || chunkIndex < 0
      || chunkIndex >= value.parts.length) throw new Error('unknown_field_chunk')
    return { step, field, chunkIndex, chunks: value.parts.length,
      sourceSha256: value.sha256, text: value.parts[chunkIndex] }
  }
  return { index, recommend, openStep, readChunk }
}

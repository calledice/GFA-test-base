import { normalizeSemanticAssessment } from './inspection-semantic.js'

export const INSPECTION_PRIORITY_VERSION = 'inspection-priority-v3'

const MISSING_CONTEXT = Object.freeze([
  'task_goal', 'final_unmet_condition', 'downstream_dependency', 'recovery',
])
const EVIDENCE = new Set(['tool_error', 'request_error', 'agent_error', 'interrupted'])
const OUTCOMES = new Set(['success', 'error', 'unknown'])
const OPERATIONS = new Set(['action', 'read', 'verification', 'unknown'])

function evidenceRefs(row) {
  if (!Number.isSafeInteger(row.turn) || row.turn < 0
    || !Number.isSafeInteger(row.step) || row.step < 0) return []
  const codes = Array.isArray(row.evidenceCodes)
    ? [...new Set(row.evidenceCodes.filter(code => EVIDENCE.has(code)))] : []
  return codes.map(code => `turn:${row.turn}/step:${row.step}/${code}`)
}

// This is a fallback order for deciding which step to open first. Its discrete
// bands represent strength of an inspection lead, not a failure probability,
// causal attribution, or estimated minutes saved.
export function scoreInspectionPriority(row, assessment = null, resolveReference = null) {
  const base = {
    version: INSPECTION_PRIORITY_VERSION,
    phase: 'online_prefix',
    tier: null,
    rankScore: null,
    reasons: [],
    evidenceRefs: [],
    missingContext: [...MISSING_CONTEXT],
    coverage: 'structured_execution_only',
    scoreKind: 'unvalidated_heuristic_order',
  }
  if (row?.observationVersion !== 'structured-shell-exit-v1') {
    return { ...base, status: 'legacy_observation',
      reasons: ['沿用旧观测口径展示原记录的执行结果；不按当前判据评分。'] }
  }
  if (!OUTCOMES.has(row.outcome) || !OPERATIONS.has(row.operation)
    || !Number.isSafeInteger(row.turn) || row.turn < 0
    || !Number.isSafeInteger(row.step) || row.step < 0
    || !Number.isSafeInteger(row.toolCount) || row.toolCount < 0
    || !Array.isArray(row.toolNames) || !Array.isArray(row.evidenceCodes)
    || (row.outcome === 'success' && row.toolCount === 0)
    || (row.outcome !== 'error'
      && row.evidenceCodes.some(code => code === 'tool_error' || code === 'agent_error'))
    || (row.outcome === 'success' && row.evidenceCodes.includes('interrupted'))) {
    return { ...base, status: 'invalid_observation',
      reasons: ['步骤执行事实不完整，无法按当前规则排序。'] }
  }

  const refs = evidenceRefs(row)
  const hasTool = row.toolCount > 0
  const hasNamedTool = hasTool && Array.isArray(row.toolNames)
    && row.toolNames.some(name => typeof name === 'string'
      && /^[A-Za-z0-9_.:/-]{1,128}$/.test(name))
  const checkability = hasNamedTool ? 2 : 0
  const kind = row.operation === 'read' ? '读取'
    : row.operation === 'verification' ? '验证'
      : row.operation === 'action' ? '执行动作' : '性质未明的操作'
  let fallback
  if (row.outcome === 'error') {
    const baseScore = row.operation === 'action' ? 58
      : row.operation === 'read' || row.operation === 'verification' ? 50 : 54
    fallback = {
      ...base, status: 'provisional', tier: 'observed_anomaly',
      rankScore: baseScore + checkability, evidenceRefs: refs,
      reasons: [
        `本步${kind}出现明确执行错误，适合作为检查入口；它可能只是上游问题的症状。`,
        '尚未核验该错误是否影响最终目标，也未核验后续是否修复。',
      ],
    }
  } else if (row.outcome === 'unknown') {
    fallback = {
      ...base, status: 'execution_outcome_unknown', tier: 'unresolved_observation',
      rankScore: (hasTool ? 34 : 30) + checkability, evidenceRefs: refs,
      reasons: [hasTool
        ? '工具执行结论未知，检查此步可补齐一个未决执行事实；未知不等于报错。'
        : '本步没有可判定的工具结果，推理或目标影响需要结合任务内容检查。'],
    }
  } else {
    fallback = {
      ...base, status: 'observed_execution_success', tier: 'unverified_step',
      rankScore: (row.operation === 'action' ? 24 : 20) + checkability,
      evidenceRefs: refs,
      reasons: ['工具执行未见错误，但目标是否满足、结果是否被下游正确使用仍待核验；此分仅是低证据的检查顺序。'],
    }
  }
  const semanticAbstention = (semanticStatus, reason) => ({
    ...fallback, semanticStatus, reasons: [reason, ...fallback.reasons],
  })

  if (assessment !== null) {
    let semantic
    try { semantic = normalizeSemanticAssessment(assessment) }
    catch {
      return semanticAbstention('invalid_semantic_context',
        '本地语义证据格式或验证状态不一致，仅使用结构化执行事实排序。')
    }
    if (semantic.sessionId !== row.sessionId || semantic.turn !== row.turn
      || semantic.step !== row.step) {
      return semanticAbstention('invalid_semantic_context',
        '本地语义证据未匹配当前步骤，仅使用结构化执行事实排序。')
    }
    if (semantic.stepRevision !== row.revision) {
      return semanticAbstention('stale_semantic_context',
        '步骤修订后原语义判断失效，仅使用结构化执行事实排序。')
    }
    if (!Number.isFinite(Date.parse(row.observedAt))) {
      return semanticAbstention('invalid_semantic_context',
        '本步缺少可核验的观测时间，仅使用结构化执行事实排序。')
    }
    if (Date.parse(semantic.assessedAt) < Date.parse(row.observedAt)) {
      return semanticAbstention('stale_semantic_context',
        '步骤在语义判断后更新，仅使用结构化执行事实排序。')
    }
    for (const reference of [semantic.verificationRef, semantic.downstreamRef].filter(Boolean)) {
      const referenced = resolveReference?.(reference)
      if (!referenced || !Number.isFinite(Date.parse(referenced.observedAt))) {
        return semanticAbstention('invalid_semantic_context',
          '本地语义证据引用的步骤不可核验，仅使用结构化执行事实排序。')
      }
      const requiresLater = semantic.findings.includes('recovered')
        && reference === semantic.verificationRef
        || semantic.findings.includes('unverified_downstream_use')
          && reference === semantic.downstreamRef
      if (referenced.revision !== reference.revision
        || Date.parse(referenced.observedAt) > Date.parse(semantic.assessedAt)
        || requiresLater && Date.parse(referenced.observedAt) <= Date.parse(row.observedAt)) {
        return semanticAbstention('stale_semantic_context',
          '依据步骤已修订或不是后续证据，仅使用结构化执行事实排序。')
      }
    }
    const findings = new Set(semantic.findings)
    const positive = ['goal_conflict', 'suspected_mismatch', 'unverified_downstream_use']
      .filter(finding => findings.has(finding))
    const negative = ['recovered', 'satisfied', 'unrelated']
      .filter(finding => findings.has(finding))
    if (positive.length && negative.length || negative.length > 1) {
      return semanticAbstention('semantic_conflict',
        '本地语义证据同时支持提高和降低优先级，仅使用结构化执行事实排序。')
    }
    const selected = findings.has('goal_conflict') ? 'goal_conflict'
      : findings.has('suspected_mismatch') ? 'suspected_mismatch'
        : findings.has('unverified_downstream_use') ? 'unverified_downstream_use'
          : negative[0]
    const scores = {
      goal_conflict: 84, suspected_mismatch: 70, unverified_downstream_use: 66,
      recovered: 12, satisfied: 10, unrelated: 8,
    }
    const reasons = {
      goal_conflict: '本地语义判断报告目标冲突，且验证结果为失败；优先核对摘要和原步骤证据。',
      suspected_mismatch: '本地语义判断报告可能偏离目标，尚缺独立验证；适合优先检查。',
      unverified_downstream_use: '本地语义判断报告未验证结果被后续使用；应核查传播关系。',
      recovered: '本地语义判断报告后续验证通过并已恢复；仍需核对恢复是否覆盖最终目标。',
      satisfied: '本地语义判断报告本步目标已验证满足；仍需核对其它目标条件。',
      unrelated: '本地语义判断报告本步与失败目标无关；仍需核对任务范围。',
    }
    return {
      ...base, phase: 'retrospective_review', status: 'semantic_provisional',
      tier: selected, rankScore: scores[selected], reasons: [reasons[selected]],
      evidenceRefs: ['local:goal_summary', `turn:${row.turn}/step:${row.step}/semantic_summary`,
        ...(semantic.verificationRef ? [`session:${encodeURIComponent(semantic.verificationRef.sessionId)}/turn:${semantic.verificationRef.turn}/step:${semantic.verificationRef.step}/verification`] : []),
        ...(semantic.downstreamRef ? [`session:${encodeURIComponent(semantic.downstreamRef.sessionId)}/turn:${semantic.downstreamRef.turn}/step:${semantic.downstreamRef.step}/downstream_use`] : [])],
      missingContext: MISSING_CONTEXT.filter(code => code !== 'task_goal'
        && !(code === 'recovery' && selected === 'recovered')
        && !(code === 'downstream_dependency' && selected === 'unverified_downstream_use')),
      coverage: 'local_semantic_assessment',
      scoreKind: 'unvalidated_review_assisted_order',
    }
  }

  return fallback
}

export function projectInspectionPriority(rows, assessments = null, getSessionRows = null) {
  const cache = new Map()
  for (const row of rows) {
    if (!cache.has(row.sessionId)) cache.set(row.sessionId, new Map())
    cache.get(row.sessionId).set(`${row.turn}\u0000${row.step}`, row)
  }
  function resolveReference(reference) {
    if (!cache.has(reference.sessionId) && getSessionRows) {
      const session = new Map()
      try {
        for (const row of getSessionRows(reference.sessionId))
          session.set(`${row.turn}\u0000${row.step}`, row)
      } catch {
        // An unavailable referenced session invalidates that review, not the snapshot.
      }
      cache.set(reference.sessionId, session)
    }
    return cache.get(reference.sessionId)?.get(`${reference.turn}\u0000${reference.step}`)
  }
  return rows.map(row => ({ ...row,
    inspectionPriority: scoreInspectionPriority(row, assessments?.get(row) ?? null,
      resolveReference) }))
}

export const STEP_FAILURE_MODEL_VERSION = 'step-failure-chain-v1'

// These are disclosed design priors, not learned frequencies or calibration data.
// The factors form a conditional chain, not three independent marginal events:
// P(problem) * P(persists | problem) * P(contributes to failure | problem, persists).
// Each step has its own possibly overlapping failure-contribution event.
const PRIORS = Object.freeze({
  unknownProblem: 0.15,
  successfulOperationProblem: 0.04,
  failedActionProblem: 0.70,
  failedUnknownOperationProblem: 0.45,
  // A read/probe error can expose a problem without creating it. With no
  // provenance it receives the unknown prior, never the failed-action prior.
  failedProbeProblem: 0.15,
  persistence: 0.60,
  impact: 0.50,
})

const OPERATIONS = new Set(['action', 'read', 'verification', 'unknown'])
const TOOL_OPERATIONS = new Map([
  ...['apply_patch', 'write', 'write_file', 'edit', 'edit_file', 'multi_edit', 'multiedit']
    .map(name => [name, 'action']),
  ...['read', 'read_file', 'read_text_file', 'read_multiple_files', 'list_directory',
    'glob', 'grep', 'search', 'view_image', 'read_mcp_resource', 'list_mcp_resources']
    .map(name => [name, 'read']),
  ...['verify', 'validate', 'run_tests', 'test', 'review', 'audit', 'code_review']
    .map(name => [name, 'verification']),
])

export function operationFor(event) {
  if (OPERATIONS.has(event.operation)) return event.operation
  if (event.kind === 'subagent') return 'unknown'
  const name = typeof event.toolName === 'string'
    ? event.toolName.toLowerCase().split(/__|\./).at(-1) : ''
  // Bash, exec_command and arbitrary MCP tools can run either actions or
  // probes. Their names/roles alone do not establish operation semantics.
  return TOOL_OPERATIONS.get(name) ?? 'unknown'
}

function stringList(value, name, fallback = []) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string'))
    throw new TypeError(name + ' must be an array of strings')
  return [...value]
}

export function composeStepFailure(factors, details = {}) {
  if (!factors || typeof factors !== 'object' || Array.isArray(factors))
    throw new TypeError('factors must be an object')
  const validated = {}
  for (const name of ['problem', 'persistence', 'impact']) {
    const value = factors[name]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
      throw new RangeError('factor ' + name + ' must be a finite number in [0, 1]')
    validated[name] = value
  }
  if (!details || typeof details !== 'object' || Array.isArray(details))
    throw new TypeError('details must be an object')
  const source = details.source === undefined ? 'rules' : details.source
  if (!['rules', 'luna'].includes(source)) throw new TypeError('invalid source')
  const evidenceQuality = details.evidenceQuality === undefined ? 'low' : details.evidenceQuality
  if (!['low', 'medium', 'high'].includes(evidenceQuality))
    throw new TypeError('invalid evidenceQuality')
  const summary = details.summary === undefined
    ? '根据问题发生、持续及最终影响三个条件因素估计。' : details.summary
  if (typeof summary !== 'string') throw new TypeError('summary must be a string')

  return {
    modelVersion: STEP_FAILURE_MODEL_VERSION,
    status: 'model_estimate',
    value: validated.problem * validated.persistence * validated.impact,
    source,
    factors: validated,
    evidenceQuality,
    summary,
    reasons: stringList(details.reasons, 'reasons'),
    limitations: stringList(details.limitations, 'limitations', ['模型估计尚未经真实任务结果验证。']),
    evidenceRefs: stringList(details.evidenceRefs, 'evidenceRefs'),
  }
}

export function estimateStepFailure(input) {
  const event = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const outcome = ['success', 'error', 'unknown'].includes(event.outcome)
    ? event.outcome : 'unknown'
  const operation = operationFor(event)
  let problem = PRIORS.unknownProblem
  let summary = '缺少明确判据，按默认先验估计本步可能留下的问题。'
  let reason = '结果未知：本步引入或留下相关问题的设计先验为 15%，未知不等于成功。'

  if (outcome === 'success') {
    problem = PRIORS.successfulOperationProblem
    summary = '工具结果未标为错误，但仍可能留下与最终目标有关的问题。'
    reason = '工具未标错：本步引入或留下相关问题的设计先验为 4%，该信号不证明预期操作或最终目标成功。'
  } else if (outcome === 'error' && operation === 'action') {
    problem = PRIORS.failedActionProblem
    summary = '本步操作报错，可能留下影响最终目标的问题。'
    reason = '已知动作执行报错：本步引入或留下相关问题的设计先验为 70%，工具报错不等于任务必然失败。'
  } else if (outcome === 'error' && (operation === 'read' || operation === 'verification')) {
    problem = PRIORS.failedProbeProblem
    summary = '读取或验证报告错误，尚无证据表明本步制造了问题。'
    reason = '读取或验证报错不等于本步制造了问题：缺少问题来源证据，仍采用 15% 的未知问题设计先验。'
  } else if (outcome === 'error') {
    problem = PRIORS.failedUnknownOperationProblem
    summary = '观察到报错，但尚不清楚本步属于执行动作还是诊断检查。'
    reason = '操作性质未知且结果报错：采用 45% 的问题设计先验，未按明确动作失败处理。'
  }

  return composeStepFailure({ problem, persistence: PRIORS.persistence, impact: PRIORS.impact }, {
    source: 'rules',
    // Even a reliable exit code does not resolve task relevance or recovery.
    evidenceQuality: 'low',
    summary,
    reasons: [
      reason,
      '在已有问题的条件下，问题直到任务结束仍未消除的设计先验为 60%。',
      '在问题存在且未消除的条件下，它对最终目标失败产生实质影响的设计先验为 50%。',
    ],
    limitations: [
      '上述参数均为公开设计先验，尚未经真实任务结果验证。',
      '规则模型缺少目标关联与后续恢复证据；执行事实不足以单独确定最终失败原因。',
      '这是步骤完成时的模型预测；多个步骤可共同影响失败，各步概率无需合计为 100%。',
    ],
    evidenceRefs: ['target'],
  })
}

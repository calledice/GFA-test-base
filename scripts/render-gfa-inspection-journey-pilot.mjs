#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const modeNames = {
  ranked: '代理高分入口',
  chronological: '时间顺序入口',
  self_directed: '自主选择',
}

function seconds(ms) {
  return (ms / 1000).toFixed(1)
}

function candidate(arm, kind) {
  const point = arm.checkpoints.find(row => row[kind])
  return point ? `${point.distinctSteps} 步 / Step ${point.afterStep} / ${seconds(point.elapsedMs)} 秒` : '未提出'
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function invalidOpenings(arm) {
  return arm.events.filter(event => event.protocolViolations?.includes('invalid_open_step')).length
}

function recommendationUse(arm) {
  if (arm.mode === 'self_directed') return '无推荐'
  const opened = arm.events.filter(event => event.action === 'open_step' && event.disclosed)
  return `${opened.filter(event => event.recommendations.includes(event.step)).length}/${opened.length}`
}

function pathGraph(arms, caseIndex) {
  const rows = ['```mermaid', 'flowchart LR']
  for (const [modeIndex, [mode, arm]] of Object.entries(arms).entries()) {
    const prefix = `C${caseIndex}M${modeIndex}`
    rows.push(`  subgraph ${prefix}["${modeNames[mode]}"]`)
    const chunks = []
    for (let offset = 0; offset < arm.openedSteps.length; offset += 5) {
      const steps = arm.openedSteps.slice(offset, offset + 5)
      const label = `${offset + 1}-${offset + steps.length}: ${steps.join(' → ')}`
      chunks.push(`${prefix}N${chunks.length}["${label}"]`)
    }
    if (chunks.length) rows.push(`    ${chunks.join(' --> ')}`)
    else rows.push(`    ${prefix}N0["未打开 Step"]`)
    rows.push('  end')
  }
  rows.push('```')
  return rows.join('\n')
}

export function renderPilot(results) {
  const rows = [
    '# GFA 检查入口：三案探索性试跑',
    '',
    `运行状态：**${results.status}**。模型：\`${results.model}\`，代理排序：\`${results.scoreSource}\`。所有 A/C 声明均为 **unadjudicated**，表中的首次位置只是模型提出候选的时点，不能解释为有效命中或定位准确率。`,
    '',
    '调查模型打开 Step 后收到完整短字段、按需读取的长字段块，以及该 Step 已核验的截图。三组均使用同一模型；排序组只改变初始推荐编号。图中的箭头是实际 `open_step` 顺序，每个框最多列 5 个 Step，不代表因果边。',
    '',
  ]
  rows.push('## 三案描述性汇总', '',
    '| 组别 | 首次 A 候选步数（逐案） | 首次 A 候选耗时合计 | 提出 C 候选案数 | 全程 Token | 全程秒数 | 图片传入次数 | 无效开步请求 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const mode of Object.keys(modeNames)) {
    const arms = results.cases.map(selected => selected.arms[mode]).filter(Boolean)
    const aPoints = arms.map(arm => arm.checkpoints.find(point => point.actionable))
    const firstA = aPoints.map(point => point?.distinctSteps ?? '未提出').join(' / ')
    const aTime = aPoints.every(Boolean)
      ? `${seconds(aPoints.reduce((sum, point) => sum + point.elapsedMs, 0))} 秒`
      : '有案例未提出'
    const cCases = arms.filter(arm => arm.checkpoints.some(point => point.chain)).length
    const total = key => arms.reduce((sum, arm) => sum + arm[key], 0)
    const tokens = arms.reduce((sum, arm) => sum + arm.usage.total_tokens, 0)
    rows.push(`| ${modeNames[mode]} | ${firstA} | ${aTime} | ${cCases}/${arms.length} | ${tokens.toLocaleString('en-US')} | ${seconds(total('totalElapsedMs'))} | ${total('transmittedImages')} | ${arms.reduce((sum, arm) => sum + invalidOpenings(arm), 0)} |`)
  }
  rows.push('', '上述 A/C 均为模型候选，尚无有效性裁决；全程成本受模型何时自行结束影响，不能单靠这张表推断定位效率。', '')
  for (const [caseIndex, selected] of results.cases.entries()) {
    rows.push(`## 案例 ${caseIndex + 1}：${selected.framework} / ${selected.benchmark}`,
      '', `轨迹 ID：\`${selected.id}\`；共 ${selected.totalSteps} 个原子 Step。`, '',
      '| 组别 | 实际打开 Step | 建议内打开 | 首次 A 候选 | 首次 C 候选 | Token | 模型秒数 | 全流程秒数 | 图片传入次数 | 结束原因 |',
      '| --- | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | --- |')
    for (const [mode, arm] of Object.entries(selected.arms))
      rows.push(`| ${modeNames[mode]} | ${arm.openedSteps.length} | ${recommendationUse(arm)} | ${candidate(arm, 'actionable')} | ${candidate(arm, 'chain')} | ${arm.usage.total_tokens.toLocaleString('en-US')} | ${seconds(arm.modelElapsedMs)} | ${seconds(arm.totalElapsedMs)} | ${arm.transmittedImages} | \`${arm.termination}\` |`)
    rows.push('', pathGraph(selected.arms, caseIndex + 1), '')
    rows.push('### 模型提出的候选说法（未裁决）', '')
    for (const [mode, arm] of Object.entries(selected.arms)) {
      const firstA = arm.checkpoints.find(point => point.actionable)
      const firstC = arm.checkpoints.find(point => point.chain)
      if (firstA) rows.push(`- **${modeNames[mode]} A**：${oneLine(firstA.actionable.discrepancy)} 下一检查：${oneLine(firstA.actionable.nextCheck)}`)
      if (firstC) rows.push(`- **${modeNames[mode]} C**：${oneLine(firstC.chain.finalCondition)} 替代解释：${oneLine(firstC.chain.alternative)}`)
    }
    rows.push('')
    const errors = Object.entries(selected.arms).flatMap(([mode, arm]) =>
      arm.events.flatMap(event => (event.protocolViolations ?? []).map(code => `${mode}#${event.callIndex}: ${code}`)))
    if (errors.length) rows.push(`协议错误：${errors.join('；')}。调用、token 和耗时已计入对应组。`, '')
  }
  rows.push('## 解释边界', '',
    '- A 要由独立评审确认其差异、可证伪下一检查及所引用的已打开证据。C 还需核验任务要求、偏离、影响、恢复、最终未满足条件与替代解释。',
    '- 官方失败仅作选样条件，不等于故障因果链已在轨迹内可证。没有独立真值和 A/C 裁决时，不能计算定位准确率、有效 A/C 达到率或效率收益。',
    '- 本次共同任务卡只告知“官方运行失败”，没有独立核验的具体最终未满足条件；这与确认性协议的要求有差距，因此只能作为探索性试跑。',
    '- 这三条 GFA 轨迹使用的是代理排序；本次不是 DSH `inspection-priority-v3` 原生评分验证。', '')
  return rows.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, array) => {
    if (index % 2 === 0) pairs.push([value, array[index + 1]])
    return pairs
  }, []))
  if (!args['--results'] || !args['--out']) throw new Error('usage: --results FILE --out FILE')
  const results = JSON.parse(await readFile(args['--results'], 'utf8'))
  await writeFile(args['--out'], renderPilot(results))
}

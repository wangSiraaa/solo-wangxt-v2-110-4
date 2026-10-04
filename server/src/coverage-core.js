/**
 * 覆盖计算与版本差异（纯函数）。
 *
 * 覆盖结论只读两类数据：生效映射（url_mappings）与验证裁决
 * （verification_verdicts）——本模块从不触发任何 HTTP 请求，
 * 隔离记录（external/invalid）只会得到 unverifiable 标记。
 *
 * 规则差异：事件入库时记录所用规则指纹；与当前映射版本的规则指纹
 * 不一致时，结论为 incomparable —— 不用旧规则算出的键去碰新规则
 * 下的映射表，避免错位匹配造成“假覆盖/假未覆盖”。
 */

export const COVERAGE_LABEL = {
  covered: '已覆盖·验证通过',
  covered_unverified: '已映射·未验证',
  covered_failing: '已映射·验证未通过',
  gone_ok: '已删除·消亡正确',
  gone_unverified: '已删除·未验证',
  gone_failing: '已删除·消亡状态错误',
  conflicted: '映射歧义未裁决',
  uncovered: '未覆盖（当前映射无此旧址）',
  unverifiable: '不可验证（已隔离，绝不请求）',
  incomparable: '规则差异·无法比较',
};

/** 视为“已覆盖”的结论集合（迁移验证通过 / 已删除消亡正确） */
export const COVERED_SET = new Set(['covered', 'gone_ok']);

/**
 * 单条事件的覆盖结论。
 * @param {object} event observation_events 行
 * @param {{mappingsByNorm: Map, verdictsByNorm: Map, currentRulesFingerprint: string|null}} ctx
 */
export function classifyEvent(event, { mappingsByNorm, verdictsByNorm, currentRulesFingerprint }) {
  if (event.origin_class !== 'local') {
    return {
      coverage: 'unverifiable', verdict: null, mapping: null,
      reason: event.quarantine_reason ?? '记录已隔离',
    };
  }
  if (
    currentRulesFingerprint &&
    event.rules_fingerprint &&
    event.rules_fingerprint !== currentRulesFingerprint
  ) {
    return {
      coverage: 'incomparable', verdict: null, mapping: null,
      reason: `记录按规则指纹 ${event.rules_fingerprint} 归一，当前版本为 ` +
        `${currentRulesFingerprint}，规则差异无法直接比较`,
    };
  }
  const m = mappingsByNorm.get(event.norm_key);
  if (!m) {
    return { coverage: 'uncovered', verdict: null, mapping: null, reason: '当前映射中没有该旧址' };
  }
  const mapping = { target_raw: m.target_raw, mapping_type: m.mapping_type, status: m.status };
  if (m.status === 'conflicted') {
    return { coverage: 'conflicted', verdict: null, mapping, reason: '归一化歧义未裁决，映射未生效' };
  }
  const v = verdictsByNorm.get(event.norm_key);
  if (m.mapping_type === 'deleted') {
    if (!v) return { coverage: 'gone_unverified', verdict: null, mapping, reason: '已删除栏目尚未验证' };
    if (v.verdict === 'deleted_gone_ok') {
      return { coverage: 'gone_ok', verdict: v.verdict, mapping, reason: null };
    }
    return {
      coverage: 'gone_failing', verdict: v.verdict, mapping,
      reason: `已删除栏目期望 410/404，验证裁决为 ${v.verdict}`,
    };
  }
  if (!v) {
    return {
      coverage: 'covered_unverified', verdict: null, mapping,
      reason: '映射存在但尚未验证（填表不等于迁移完成）',
    };
  }
  if (v.verdict === 'ok') return { coverage: 'covered', verdict: v.verdict, mapping, reason: null };
  return {
    coverage: 'covered_failing', verdict: v.verdict, mapping,
    reason: `验证裁决为 ${v.verdict}，迁移未生效`,
  };
}

/** 汇总：条数与访问次数分别按结论统计（次数是运营关注的热度证据） */
export function summarizeCoverage(items) {
  const by = {};
  for (const it of items) {
    by[it.coverage] ??= { events: 0, hits: 0 };
    by[it.coverage].events += 1;
    by[it.coverage].hits += it.hits;
  }
  return {
    total_events: items.length,
    total_hits: items.reduce((a, b) => a + b.hits, 0),
    by_coverage: by,
  };
}

/**
 * 版本差异：旧报告明细 vs 当前计算明细（按 event_id 对齐）。
 *  - newly_uncovered：当前未覆盖，而旧报告中并非未覆盖（或旧报告中不存在）；
 *  - newly_covered：当前已覆盖，而旧报告中并非已覆盖（或旧报告中不存在）；
 *  - incomparable：因规则差异无法比较的项（不参与上面两类）。
 * 迟到记录只会出现在 newItems 一侧 —— 它们进入差异清单，但旧报告本身不变。
 */
export function diffCoverageItems(oldItems, newItems) {
  const oldByEvent = new Map(oldItems.map((i) => [i.event_id, i]));
  const newly_uncovered = [];
  const newly_covered = [];
  const incomparable = [];
  for (const n of newItems) {
    if (n.coverage === 'incomparable') {
      incomparable.push(n);
      continue;
    }
    const o = oldByEvent.get(n.event_id);
    const wasCovered = o ? COVERED_SET.has(o.coverage) : false;
    const isCovered = COVERED_SET.has(n.coverage);
    if (isCovered && !wasCovered) newly_covered.push(n);
    if (n.coverage === 'uncovered' && (!o || o.coverage !== 'uncovered')) newly_uncovered.push(n);
  }
  return { newly_uncovered, newly_covered, incomparable };
}

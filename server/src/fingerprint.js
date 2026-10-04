/**
 * 指纹工具：规则指纹、内容摘要。
 * 规则指纹随 config.rules 变化即变 —— 这是“规则升级后历史记录无法直接比较”
 * 的判定依据；内容摘要用于批次/事件的幂等与快照版本识别。
 */
import { createHash } from 'node:crypto';
import { config } from './config.js';

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

/** 键序稳定的 JSON 序列化（undefined 视为 null），用于可复现的摘要 */
export function stableStringify(v) {
  if (v === undefined || v === null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(',')}}`;
}

/** 规范化规则指纹：规则（尾斜杠模式、追踪参数集等）任何变化都会改变它 */
export function rulesFingerprint() {
  return sha256(stableStringify(config.rules)).slice(0, 16);
}

/** 映射集快照指纹：规则指纹 + 全量生效映射内容 */
export function snapshotContentHash(rulesFp, snapshotRows) {
  return sha256(`${rulesFp}\n${stableStringify(snapshotRows)}`);
}

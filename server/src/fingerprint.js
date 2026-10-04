/** 稳定摘要工具：版本指纹、批次/记录内容摘要共用。 */
import { createHash } from 'node:crypto';

export function sha256hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

/** 键序无关的稳定序列化（用于指纹/摘要，避免对象键顺序造成假差异） */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(',')}}`;
}

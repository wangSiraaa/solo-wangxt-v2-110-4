/**
 * 观察包记录的分类与摘要（纯函数，不触库、不发请求）。
 *
 * 安全纪律（与 verifier 完全一致）：
 *  - 只有 origin 为随项目启动的本地站点（127.0.0.1:固定端口，http）的记录
 *    才以 local 入库并参与覆盖计算；
 *  - 外网/其它端口一律标记 external（不可验证）——观察记录不是访问外网的许可，
 *    验证器绝不会对它们发起请求；
 *  - 格式错误的记录标记 invalid。
 * 隔离记录同样入库保存（证据），只是绝不进入验证流程。
 */
import { config } from './config.js';
import { normalize, splitQuery } from './normalize.js';
import { sha256, stableStringify, rulesFingerprint } from './fingerprint.js';

/** 与 verifier.allowed 完全相同的白名单判定 */
export function isAllowedOrigin(u) {
  return (
    u.protocol === 'http:' &&
    u.hostname === config.fixture.host &&
    u.port === String(config.fixture.port)
  );
}

/** 单条记录的内容指纹：同一 event_id 重传时判断“内容是否一致” */
export function recordFingerprint(rec) {
  return sha256(stableStringify({
    event_id: rec?.event_id ?? null,
    url: rec?.url ?? null,
    observed_start: rec?.observed_start ?? null,
    observed_end: rec?.observed_end ?? null,
    hits: rec?.hits ?? null,
    content_digest: rec?.content_digest ?? null,
  }));
}

/** 批次摘要：记录按 event_id 排序后的 canonical 形式，整包重传可识别 */
export function batchDigest(records) {
  const canon = (records ?? []).map((r, i) => ({
    event_id: r?.event_id ?? `#missing-${i}`,
    url: r?.url ?? null,
    observed_start: r?.observed_start ?? null,
    observed_end: r?.observed_end ?? null,
    hits: r?.hits ?? null,
    content_digest: r?.content_digest ?? null,
  }));
  canon.sort((a, b) => String(a.event_id).localeCompare(String(b.event_id)));
  return sha256(stableStringify(canon));
}

function parseTime(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 分类一条观察记录。
 * @returns {{
 *   eventId: string|null, rawUrl: string, normKey: string|null,
 *   rulesFp: string|null, originClass: 'local'|'external'|'invalid',
 *   quarantineReason: string|null, trackerParams: Object,
 *   observedStart: Date|null, observedEnd: Date|null,
 *   hits: number, contentDigest: string|null
 * }}
 */
export function classifyRecord(rec) {
  const out = {
    eventId: null,
    rawUrl: typeof rec?.url === 'string' ? rec.url : '',
    normKey: null,
    rulesFp: null,
    originClass: 'invalid',
    quarantineReason: null,
    trackerParams: {},
    observedStart: null,
    observedEnd: null,
    hits: 0,
    contentDigest: rec?.content_digest != null ? String(rec.content_digest) : null,
  };
  const problems = [];

  if (typeof rec?.event_id === 'string' && rec.event_id.trim() !== '') {
    out.eventId = rec.event_id.trim();
  } else {
    problems.push('缺少稳定事件标识 event_id');
  }
  if (out.rawUrl.trim() === '') problems.push('缺少 url');

  const s = parseTime(rec?.observed_start);
  const e = parseTime(rec?.observed_end);
  if (!s || !e) {
    problems.push('观察时间范围 observed_start/observed_end 缺失或无法解析');
  } else if (s > e) {
    problems.push('observed_start 晚于 observed_end');
  } else {
    out.observedStart = s;
    out.observedEnd = e;
  }

  const hits = Number(rec?.hits);
  if (!Number.isInteger(hits) || hits <= 0) {
    problems.push(`hits 非法（${JSON.stringify(rec?.hits ?? null)}），应为正整数`);
  } else {
    out.hits = hits;
  }

  const n = out.rawUrl ? normalize(out.rawUrl) : { ok: false, error: 'empty url' };
  if (!n.ok) {
    problems.push(`URL 解析失败: ${n.error}`);
  } else {
    // 原始路径、百分号编码形式、追踪参数值全部原样保留为证据
    out.normKey = n.normKey;
    out.rulesFp = rulesFingerprint();
    out.trackerParams = Object.fromEntries(splitQuery(new URL(out.rawUrl).search).trackers);
  }

  if (problems.length) {
    out.originClass = 'invalid';
    out.quarantineReason = problems.join('；');
    return out;
  }

  const u = new URL(out.rawUrl);
  if (!isAllowedOrigin(u)) {
    out.originClass = 'external';
    out.quarantineReason =
      `origin ${u.protocol}//${u.host} 不在本地站点白名单 ` +
      `（仅 ${config.fixture.host}:${config.fixture.port}），标记不可验证，绝不发起请求`;
    return out;
  }

  out.originClass = 'local';
  return out;
}

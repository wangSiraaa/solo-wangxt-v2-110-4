/**
 * 运营观察包（脱敏本地访问记录）的接入、覆盖计算与版本差异 —— 纯函数核心。
 *
 * 纪律：
 *  - 本模块绝不发起任何网络请求（不 import http / verifier）；
 *    观察记录不是验证器访问外网的许可：外网/非白名单 origin 只标记为
 *    不可验证（quarantined），留证、不请求。
 *  - 覆盖判定复用现有规范化规则（normalize.js），但原始 URL、原始路径、
 *    百分号编码形式与追踪参数值全部留证，汇总不得丢证据。
 *  - 幂等：批次按 batch_key + 内容摘要；事件按稳定 event_id。
 *  - 覆盖/差异计算在查询时按“当前规则”重算身份键；历史报告里的键保持
 *    导出时版本不变 —— 两者键不一致即“规则差异无法比较”。
 */
import { normalize, splitQuery } from './normalize.js';
import { config } from './config.js';
import { sha256hex, stableStringify } from './fingerprint.js';

/** 与 verifier 白名单同一标准：只有随项目启动的本地站点才是可验证 origin */
export function originAllowed(u) {
  return (
    u.protocol === 'http:' &&
    u.hostname === config.fixture.host &&
    u.port === String(config.fixture.port)
  );
}

function isoOrNull(ts) {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** 记录内容摘要：日期/次数先规范化，等价写法的包得到相同摘要（幂等判定用） */
export function recordDigest(rec) {
  const ws = isoOrNull(rec?.window_start);
  const we = isoOrNull(rec?.window_end);
  const hits = Number(rec?.hits);
  if (!ws || !we || !Number.isInteger(hits)) {
    return `sha256:${sha256hex(stableStringify(rec))}`;
  }
  return `sha256:${sha256hex(stableStringify([
    String(rec?.event_id ?? ''), String(rec?.url ?? ''), ws, we, hits,
  ]))}`;
}

/** 整包内容摘要：与记录顺序无关 */
export function batchDigest(digests) {
  return `sha256:${sha256hex([...digests].sort().join('\n'))}`;
}

/**
 * 校验并分类一条观察记录。永不抛错、永不失败整包：
 * 结构非法 / URL 格式错误 / 非白名单 origin 一律转为 quarantined 留证。
 * @param {object} rec 包内记录 {event_id,url,window_start,window_end,hits,content_digest?}
 * @param {{batchKey?: string, index?: number}} [ctx]
 */
export function classifyRecord(rec, ctx = {}) {
  const problems = [];
  const eventId = String(rec?.event_id ?? '').trim();
  if (!eventId) problems.push('缺少稳定事件标识 event_id');
  const url = typeof rec?.url === 'string' ? rec.url.trim() : '';
  if (!url) problems.push('缺少原始 URL');
  const ws = isoOrNull(rec?.window_start);
  const we = isoOrNull(rec?.window_end);
  if (!ws) problems.push('window_start 缺失或无法解析');
  if (!we) problems.push('window_end 缺失或无法解析');
  if (ws && we && we < ws) problems.push('window_end 早于 window_start');
  const hits = Number(rec?.hits);
  const hitsOk = Number.isInteger(hits) && hits >= 0;
  if (!hitsOk) problems.push('hits 缺失或不是非负整数');

  let u = null;
  if (url) { try { u = new URL(url); } catch { u = null; } }
  const n = url ? normalize(url) : { ok: false, error: 'empty url' };

  const event = {
    event_id: eventId || `invalid:${ctx.batchKey ?? 'batch'}:${ctx.index ?? 0}`,
    url_raw: url || String(rec?.url ?? '(missing)'),
    window_start: ws,
    window_end: we,
    hits: hitsOk ? hits : null,
    content_digest:
      typeof rec?.content_digest === 'string' && rec.content_digest
        ? rec.content_digest
        : recordDigest(rec),
    norm_key: n.ok ? n.normKey : null,
    pathname_raw: u ? u.pathname : null,   // 原始路径：%XX 原样，绝不 decode
    query_raw: u ? u.search : null,        // 原始查询串：追踪参数值原样
    tracker_params: u ? Object.fromEntries(splitQuery(u.search).trackers) : {},
  };

  if (problems.length) {
    return { ...event, status: 'quarantined',
      quarantine_reason: `记录格式错误：${problems.join('；')}（隔离留证，不参与覆盖，绝不请求）` };
  }
  if (!n.ok || !u) {
    return { ...event, status: 'quarantined',
      quarantine_reason: `URL 格式错误：${n.error ?? '无法解析'}（隔离留证，不参与覆盖，绝不请求）` };
  }
  if (!originAllowed(u)) {
    return { ...event, status: 'quarantined',
      quarantine_reason: `origin ${u.origin} 不在允许验证的本地站点白名单内，标记为不可验证（绝不发起请求）` };
  }
  return { ...event, status: 'observed', quarantine_reason: null };
}

/**
 * 校验整个观察包。只有包级结构问题（缺 batch_key / records 非空数组）才失败；
 * 记录级问题全部转为 quarantined。
 * @returns {{ok: boolean, errors: string[], batchKey?: string, sourceLabel?: string|null,
 *            events?: object[], digest?: string}}
 */
export function classifyPackage(pkg) {
  const errors = [];
  const batchKey = String(pkg?.batch_key ?? '').trim();
  if (!batchKey) errors.push('缺少 batch_key（稳定批次标识）');
  const records = pkg?.records;
  if (!Array.isArray(records) || records.length === 0) {
    errors.push('records 必须是非空数组');
  }
  if (errors.length) return { ok: false, errors };

  const events = records.map((rec, i) => classifyRecord(rec, { batchKey, index: i }));
  return {
    ok: true,
    errors: [],
    batchKey,
    sourceLabel: String(pkg?.source_label ?? '').trim() || null,
    events,
    digest: batchDigest(events.map((e) => e.content_digest)),
  };
}

/** 覆盖状态：covered 已覆盖 / blocked 验证未过或歧义 / unverified 有映射无裁决 / unmapped 无映射 */
export const COVERAGE_STATUS = ['covered', 'blocked', 'unverified', 'unmapped'];

/**
 * 用“当前”规范化规则 + 当前生效映射 + 当前验证裁决计算覆盖。
 * 事件的身份键在查询时按当前规则重算（规则升级后以当前规则为准）；
 * 原始 URL / 路径 / 追踪参数值作为证据逐项保留在 sample_urls / tracker_values。
 *
 * @param {object[]} events   status='observed' 的观察事件行
 * @param {object[]} mappings url_mappings 行
 * @param {Map<string,object>} verdicts source_norm → verification_verdicts 行
 * @param {object[]} [quarantined] 隔离事件行（原样展示，绝不参与覆盖）
 * @param {(raw:string)=>{ok:boolean,normKey?:string}} [normalizeFn] 默认当前规则
 */
export function computeCoverage(events, mappings, verdicts, quarantined = [], normalizeFn = normalize) {
  const mapByKey = new Map(mappings.map((m) => [m.source_norm, m]));
  const groups = new Map();

  for (const e of events) {
    const n = normalizeFn(e.url_raw);
    const key = n.ok ? n.normKey : e.norm_key;
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        norm_key: key, hits: 0, event_count: 0,
        first_seen: null, last_seen: null,
        samples: new Map(), trackers: new Map(),
      });
    }
    const g = groups.get(key);
    g.hits += e.hits ?? 0;
    g.event_count += 1;
    const ws = e.window_start ? new Date(e.window_start).toISOString() : null;
    const we = e.window_end ? new Date(e.window_end).toISOString() : null;
    if (ws && (!g.first_seen || ws < g.first_seen)) g.first_seen = ws;
    if (we && (!g.last_seen || we > g.last_seen)) g.last_seen = we;
    // 证据：同一归一键下的每种原始写法（大小写/%XX/追踪参数值）逐条保留
    g.samples.set(e.url_raw, (g.samples.get(e.url_raw) ?? 0) + (e.hits ?? 0));
    for (const [k, vals] of Object.entries(e.tracker_params ?? {})) {
      if (!g.trackers.has(k)) g.trackers.set(k, new Set());
      for (const v of vals ?? []) g.trackers.get(k).add(v);
    }
  }

  const items = [];
  for (const g of groups.values()) {
    const m = mapByKey.get(g.norm_key);
    let status; let verdict = null; const issues = [];
    if (!m) {
      status = 'unmapped';
      issues.push('运营观察到访问，但没有对应生效映射：迁移未覆盖该旧址');
    } else if (m.status === 'conflicted') {
      status = 'blocked';
      issues.push('映射存在归一化歧义，未裁决');
    } else {
      const v = verdicts.get(g.norm_key);
      verdict = v?.verdict ?? null;
      if (verdict === 'ok' || verdict === 'deleted_gone_ok') {
        status = 'covered';
      } else if (verdict) {
        status = 'blocked';
        issues.push(`验证裁决未通过：${verdict}`);
      } else {
        status = 'unverified';
        issues.push('有映射但还没有验证裁决（填表不等于迁移完成）');
      }
    }
    items.push({
      norm_key: g.norm_key,
      status,
      hits: g.hits,
      event_count: g.event_count,
      first_seen: g.first_seen,
      last_seen: g.last_seen,
      sample_urls: [...g.samples.entries()].map(([url_raw, hits]) => ({ url_raw, hits })),
      tracker_values: Object.fromEntries(
        [...g.trackers.entries()].map(([k, s]) => [k, [...s].sort()])),
      mapping: m
        ? { target_raw: m.target_raw, target_norm: m.target_norm,
            mapping_type: m.mapping_type, mapping_status: m.status }
        : null,
      verdict,
      issues,
    });
  }
  items.sort((a, b) => b.hits - a.hits || a.norm_key.localeCompare(b.norm_key));

  const statusOf = new Map(items.map((i) => [i.norm_key, i.status]));
  const summary = {
    keys: items.length,
    hits: items.reduce((s, i) => s + i.hits, 0),
    quarantined: quarantined.length,
    by_status: Object.fromEntries(COVERAGE_STATUS.map((s) => [s, { keys: 0, hits: 0 }])),
  };
  for (const i of items) {
    summary.by_status[i.status].keys += 1;
    summary.by_status[i.status].hits += i.hits;
  }

  // 时间线：按事件自身 window_start 归桶（UTC 日）—— 迟到记录进入正确时间段
  const buckets = new Map();
  for (const e of events) {
    if (!e.window_start) continue;
    const day = new Date(e.window_start).toISOString().slice(0, 10);
    if (!buckets.has(day)) {
      buckets.set(day, { bucket: day, hits: 0, events: 0,
        covered_hits: 0, blocked_hits: 0, unverified_hits: 0, unmapped_hits: 0 });
    }
    const b = buckets.get(day);
    const n = normalizeFn(e.url_raw);
    const st = statusOf.get(n.ok ? n.normKey : e.norm_key) ?? 'unmapped';
    b.hits += e.hits ?? 0;
    b.events += 1;
    b[`${st}_hits`] += e.hits ?? 0;
  }
  const timeline = [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));

  return {
    items,
    quarantined: quarantined.map((e) => ({
      event_id: e.event_id,
      url_raw: e.url_raw,
      reason: e.quarantine_reason,
      hits: e.hits,
      window_start: e.window_start,
      window_end: e.window_end,
      batch_key: e.batch_key ?? null,
    })),
    summary,
    timeline,
  };
}

const isCovered = (s) => s === 'covered';

function pairView(oldItem, curItem, change) {
  return {
    norm_key: curItem.norm_key,
    change,
    old_status: oldItem?.status ?? null,
    current_status: curItem.status,
    old_hits: oldItem?.hits ?? null,
    hits: curItem.hits,
    verdict: curItem.verdict ?? null,
    mapping: curItem.mapping ?? null,
    sample_urls: curItem.sample_urls ?? oldItem?.sample_urls ?? [],
  };
}

/**
 * 版本差异：旧报告（绑定旧版本的不可变快照） vs 当前覆盖。
 *
 * 分类（边界由持久化数据决定，刷新不丢失）：
 *  - incomparable：用当前规则重算旧项身份键，与快照键不同 → 规则差异无法比较；
 *    其新键被“认领”，不会再出现在新增列表里。
 *  - covered：当前已覆盖（change: newly_covered 新增覆盖 / still_covered / new 新观察到即覆盖）。
 *  - newly_uncovered：新增未覆盖（change: new 新观察到 / regressed 由覆盖倒退）。
 *  - still_uncovered：旧报告时未覆盖，当前仍未覆盖。
 *
 * @param {object[]} oldItems 旧报告 items 快照
 * @param {object[]} currentItems 当前覆盖 items
 * @param {(raw:string)=>{ok:boolean,normKey?:string}} [normalizeFn] 默认当前规则
 */
export function diffCoverage(oldItems, currentItems, normalizeFn = normalize) {
  const curByKey = new Map(currentItems.map((i) => [i.norm_key, i]));
  const claimedCurKeys = new Set();
  const incomparable = [];
  const covered = [];
  const newlyUncovered = [];
  const stillUncovered = [];

  for (const old of oldItems) {
    const sample = old.sample_urls?.[0];
    const sampleUrl = typeof sample === 'string' ? sample : sample?.url_raw;
    const n = sampleUrl ? normalizeFn(sampleUrl) : { ok: false };
    const curKey = n.ok ? n.normKey : old.norm_key;

    if (curKey !== old.norm_key) {
      incomparable.push({
        old_norm_key: old.norm_key,
        current_norm_key: curKey,
        reason: '规范化规则差异导致身份键变化，无法逐项比较',
        old_status: old.status,
        hits: old.hits,
        sample_urls: old.sample_urls ?? [],
      });
      claimedCurKeys.add(curKey);
      continue;
    }

    const cur = curByKey.get(old.norm_key);
    claimedCurKeys.add(old.norm_key);
    if (!cur) {
      incomparable.push({
        old_norm_key: old.norm_key,
        current_norm_key: null,
        reason: '当前版本下没有对应观察项，无法比较',
        old_status: old.status,
        hits: old.hits,
        sample_urls: old.sample_urls ?? [],
      });
      continue;
    }
    if (isCovered(old.status) && isCovered(cur.status)) {
      covered.push(pairView(old, cur, 'still_covered'));
    } else if (!isCovered(old.status) && isCovered(cur.status)) {
      covered.push(pairView(old, cur, 'newly_covered'));
    } else if (isCovered(old.status) && !isCovered(cur.status)) {
      newlyUncovered.push(pairView(old, cur, 'regressed'));
    } else {
      stillUncovered.push(pairView(old, cur, 'still_uncovered'));
    }
  }

  for (const cur of currentItems) {
    if (claimedCurKeys.has(cur.norm_key)) continue;
    // 旧报告导出后新观察到（含迟到归位）的项
    if (isCovered(cur.status)) covered.push(pairView(null, cur, 'new'));
    else newlyUncovered.push(pairView(null, cur, 'new'));
  }

  return {
    newly_uncovered: newlyUncovered,
    still_uncovered: stillUncovered,
    covered,
    incomparable,
    summary: {
      newly_uncovered: newlyUncovered.length,
      still_uncovered: stillUncovered.length,
      covered: covered.length,
      newly_covered: covered.filter((i) => i.change === 'newly_covered').length,
      incomparable: incomparable.length,
    },
  };
}

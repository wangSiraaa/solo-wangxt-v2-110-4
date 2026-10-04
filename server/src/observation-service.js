/**
 * 观察包接入与覆盖审阅的持久化层。
 * 所有判定逻辑在 observations.js（纯函数）；这里只负责事务、幂等落库与组装。
 * 本模块同样绝不发起网络请求 —— 覆盖结论只读已落库的验证裁决。
 */
import { pool } from './db.js';
import { classifyPackage, computeCoverage, diffCoverage } from './observations.js';
import { ensureCurrentVersion } from './mapping-versions.js';
import { VERDICT_LABEL } from './verdict-labels.js';

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

/**
 * 导入观察包（幂等）：
 *  - 同 batch_key + 同内容摘要 → no-op，返回 duplicated；
 *  - 同 batch_key 不同摘要 → 409，不静默覆盖；
 *  - 事件按稳定 event_id ON CONFLICT DO NOTHING —— 重复/迟到重传不翻倍。
 */
export async function importPackage(pkg) {
  const parsed = classifyPackage(pkg);
  if (!parsed.ok) throw httpError(400, parsed.errors.join('；'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { version } = await ensureCurrentVersion(client);

    const { rows: existing } = await client.query(
      'SELECT * FROM observation_batches WHERE batch_key=$1', [parsed.batchKey]);
    if (existing.length) {
      if (existing[0].batch_digest === parsed.digest) {
        await client.query('COMMIT');
        return {
          duplicated: true,
          batch_key: parsed.batchKey,
          batch_digest: parsed.digest,
          inserted: 0,
          skipped: parsed.events.length,
          quarantined: parsed.events.filter((e) => e.status === 'quarantined').length,
          mapping_version_id: existing[0].mapping_version_id,
          message: '相同批次已导入（批次摘要一致），幂等跳过，访问次数不变',
        };
      }
      throw httpError(409,
        `批次 ${parsed.batchKey} 已存在但内容摘要不同 ` +
        `（${existing[0].batch_digest} ≠ ${parsed.digest}），拒绝覆盖，请核对来源`);
    }

    const { rows: b } = await client.query(
      `INSERT INTO observation_batches
         (batch_key, source_label, batch_digest, record_count, mapping_version_id, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [parsed.batchKey, parsed.sourceLabel, parsed.digest,
       parsed.events.length, version.id, JSON.stringify(pkg)]);

    let inserted = 0; let skipped = 0;
    for (const ev of parsed.events) {
      const r = await client.query(
        `INSERT INTO observation_events
           (batch_id, event_id, url_raw, window_start, window_end, hits, content_digest,
            norm_key, pathname_raw, query_raw, tracker_params, status, quarantine_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING id`,
        [b[0].id, ev.event_id, ev.url_raw, ev.window_start, ev.window_end, ev.hits,
         ev.content_digest, ev.norm_key, ev.pathname_raw, ev.query_raw,
         JSON.stringify(ev.tracker_params), ev.status, ev.quarantine_reason]);
      if (r.rows.length) inserted += 1; else skipped += 1;
    }
    await client.query('COMMIT');
    return {
      duplicated: false,
      batch_key: parsed.batchKey,
      batch_digest: parsed.digest,
      inserted,
      skipped,
      quarantined: parsed.events.filter((e) => e.status === 'quarantined').length,
      mapping_version_id: version.id,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function listBatches() {
  const { rows } = await pool.query(
    `SELECT b.id, b.batch_key, b.source_label, b.batch_digest, b.record_count,
            b.mapping_version_id, b.received_at,
            count(e.id) AS stored_events,
            count(e.id) FILTER (WHERE e.status='quarantined') AS quarantined
       FROM observation_batches b
       LEFT JOIN observation_events e ON e.batch_id = b.id
      GROUP BY b.id ORDER BY b.id`);
  return rows;
}

export async function listEvents({ status = null, normKey = null, limit = 500 } = {}) {
  const cond = []; const params = [];
  if (status) { params.push(status); cond.push(`e.status=$${params.length}`); }
  if (normKey) { params.push(normKey); cond.push(`e.norm_key=$${params.length}`); }
  params.push(Math.min(Number(limit) || 500, 5000));
  const { rows } = await pool.query(
    `SELECT e.*, b.batch_key, b.mapping_version_id
       FROM observation_events e
       JOIN observation_batches b ON b.id = e.batch_id
      ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
      ORDER BY e.id LIMIT $${params.length}`, params);
  return rows;
}

/** 实时覆盖：按当前规范化规则 + 当前生效映射 + 当前验证裁决计算 */
export async function liveCoverage() {
  const { version } = await ensureCurrentVersion();
  const { rows: events } = await pool.query(
    `SELECT e.*, b.batch_key FROM observation_events e
       JOIN observation_batches b ON b.id = e.batch_id
      WHERE e.status='observed' ORDER BY e.id`);
  const { rows: quarantined } = await pool.query(
    `SELECT e.*, b.batch_key FROM observation_events e
       JOIN observation_batches b ON b.id = e.batch_id
      WHERE e.status='quarantined' ORDER BY e.id`);
  const { rows: mappings } = await pool.query('SELECT * FROM url_mappings');
  const { rows: verdictRows } = await pool.query('SELECT * FROM verification_verdicts');
  const verdicts = new Map(verdictRows.map((v) => [v.source_norm, v]));
  const cov = computeCoverage(events, mappings, verdicts, quarantined);
  return { ...cov, version, verdictLabel: VERDICT_LABEL };
}

/** 导出覆盖报告：快照即不可变，绑定当前映射版本；迟到记录不回写 */
export async function exportReport(title = null) {
  const cov = await liveCoverage();
  const { rows } = await pool.query(
    `INSERT INTO coverage_reports (title, mapping_version_id, summary, items, quarantined, timeline)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, title, mapping_version_id, created_at`,
    [title || `覆盖报告 ${new Date().toISOString()}`,
     cov.version.id, JSON.stringify(cov.summary),
     JSON.stringify(cov.items), JSON.stringify(cov.quarantined),
     JSON.stringify(cov.timeline)]);
  return { report: rows[0], summary: cov.summary };
}

export async function listReports() {
  const { rows } = await pool.query(
    `SELECT r.id, r.title, r.mapping_version_id, r.summary, r.created_at,
            v.rules_fingerprint, v.mapping_digest
       FROM coverage_reports r
       JOIN mapping_versions v ON v.id = r.mapping_version_id
      ORDER BY r.id`);
  return rows;
}

export async function getReport(id) {
  const { rows } = await pool.query(
    `SELECT r.*, v.rules_fingerprint, v.mapping_digest, v.rules_snapshot
       FROM coverage_reports r
       JOIN mapping_versions v ON v.id = r.mapping_version_id
      WHERE r.id=$1`, [id]);
  if (!rows.length) throw httpError(404, 'report not found');
  return rows[0];
}

/**
 * 版本差异：指定历史报告（绑定旧版本） vs 当前版本实时覆盖。
 * 边界完全由持久化数据（报告快照 + 事件留证）决定，重复查询结果一致。
 */
export async function diffWithCurrent(reportId) {
  const report = await getReport(reportId);
  const cur = await liveCoverage();
  const diff = diffCoverage(report.items, cur.items);
  return {
    base_report: {
      id: report.id,
      title: report.title,
      created_at: report.created_at,
      mapping_version_id: report.mapping_version_id,
      rules_fingerprint: report.rules_fingerprint,
    },
    current_version: {
      id: cur.version.id,
      rules_fingerprint: cur.version.rules_fingerprint,
      mapping_digest: cur.version.mapping_digest,
    },
    rules_changed: report.rules_fingerprint !== cur.version.rules_fingerprint,
    ...diff,
  };
}

export async function listVersions() {
  const { rows } = await pool.query(
    `SELECT v.*, (SELECT count(*) FROM coverage_reports r WHERE r.mapping_version_id = v.id) AS reports
       FROM mapping_versions v ORDER BY v.id`);
  return rows;
}

/** CSV 导出（报告快照内容，不重新计算） */
export function reportToCsv(report) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['norm_key', 'status', 'hits', 'event_count', 'first_seen', 'last_seen',
    'mapping_target', 'verdict', 'sample_urls'];
  const lines = [head.join(',')];
  for (const i of report.items) {
    lines.push([
      i.norm_key, i.status, i.hits, i.event_count, i.first_seen ?? '', i.last_seen ?? '',
      i.mapping?.target_raw ?? '', i.verdict ?? '',
      (i.sample_urls ?? []).map((s) => (typeof s === 'string' ? s : s.url_raw)).join(' | '),
    ].map(esc).join(','));
  }
  return `${lines.join('\n')}\n`;
}

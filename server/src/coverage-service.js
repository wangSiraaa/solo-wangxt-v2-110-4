/**
 * 覆盖审阅：当前覆盖计算、报告导出（不可变快照）、版本差异。
 *
 * 纪律：
 *  - 只读 url_mappings / verification_verdicts / observation_*，绝不发起请求；
 *  - 报告导出即快照：后续导入（含迟到记录）、映射变更、规则升级都不改写它；
 *  - 差异在导出时固化进 summary.diff（刷新不丢），也可对任意旧报告实时重算。
 */
import { pool } from './db.js';
import { latestMappingVersion } from './mapping-versions.js';
import {
  classifyEvent, summarizeCoverage, diffCoverageItems, COVERAGE_LABEL,
} from './coverage-core.js';

function timeFilter(from, to) {
  const params = [];
  let where = '';
  if (from) { params.push(new Date(from)); where += ` AND observed_start >= $${params.length}`; }
  if (to) { params.push(new Date(to)); where += ` AND observed_start <= $${params.length}`; }
  return { where, params };
}

/** 当前版本下的覆盖计算（实时，不落库） */
export async function computeCurrentCoverage(client, { from = null, to = null } = {}) {
  const version = await latestMappingVersion(client);
  const { where, params } = timeFilter(from, to);
  const { rows: events } = await client.query(
    `SELECT * FROM observation_events WHERE true ${where}
      ORDER BY observed_start NULLS LAST, id`, params);
  const { rows: mappings } = await client.query('SELECT * FROM url_mappings');
  const { rows: verdicts } = await client.query('SELECT * FROM verification_verdicts');

  const mappingsByNorm = new Map(mappings.map((m) => [m.source_norm, m]));
  const verdictsByNorm = new Map(verdicts.map((v) => [v.source_norm, v]));
  const ctx = {
    mappingsByNorm, verdictsByNorm,
    currentRulesFingerprint: version?.rules_fingerprint ?? null,
  };

  const items = events.map((e) => {
    const c = classifyEvent(e, ctx);
    return {
      event_id: e.event_id,
      raw_url: e.raw_url,                    // 原始 URL：路径/编码/追踪参数值原样
      norm_key: e.norm_key,
      rules_fingerprint: e.rules_fingerprint,
      origin_class: e.origin_class,
      quarantine_reason: e.quarantine_reason,
      tracker_params: e.tracker_params,      // 追踪参数值证据
      observed_start: e.observed_start,
      observed_end: e.observed_end,
      hits: e.hits,
      content_digest: e.content_digest,
      coverage: c.coverage,
      verdict: c.verdict,
      reason: c.reason,
      mapping: c.mapping,
    };
  });
  return { version, items, summary: summarizeCoverage(items), label: COVERAGE_LABEL };
}

export async function reportItems(client, reportId) {
  const { rows } = await client.query(
    'SELECT * FROM coverage_report_items WHERE report_id=$1 ORDER BY id', [reportId]);
  return rows;
}

/**
 * 导出覆盖报告：当前版本 + 当前计算的不可变快照。
 * 同时与最近一份既有报告计算差异并固化（newly_uncovered / newly_covered /
 * incomparable），此后无论再导入什么、映射怎么变，本报告内容不变。
 */
export async function exportReport({ from = null, to = null, note = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await computeCurrentCoverage(client, { from, to });
    if (!cur.version) {
      const err = new Error('尚无映射版本，请先录入映射');
      err.statusCode = 409;
      throw err;
    }

    const { rows: prevRows } = await client.query(
      'SELECT * FROM coverage_reports ORDER BY id DESC LIMIT 1');
    let diff = null;
    if (prevRows.length) {
      const prevItems = await reportItems(client, prevRows[0].id);
      const d = diffCoverageItems(prevItems, cur.items);
      diff = {
        base_report_id: prevRows[0].id,
        base_mapping_version_id: prevRows[0].mapping_version_id,
        newly_uncovered: d.newly_uncovered.map(brief),
        newly_covered: d.newly_covered.map(brief),
        incomparable: d.incomparable.map(brief),
      };
    }

    const summary = { ...cur.summary, diff };
    const { rows } = await client.query(
      `INSERT INTO coverage_reports (mapping_version_id, range_start, range_end, summary, note)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [cur.version.id, from ? new Date(from) : null, to ? new Date(to) : null,
       JSON.stringify(summary), note]);
    const report = rows[0];
    for (const it of cur.items) {
      await client.query(
        `INSERT INTO coverage_report_items
           (report_id, event_id, raw_url, norm_key, rules_fingerprint,
            coverage, verdict, hits, observed_start, observed_end, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [report.id, it.event_id, it.raw_url, it.norm_key, it.rules_fingerprint,
         it.coverage, it.verdict, it.hits, it.observed_start, it.observed_end,
         JSON.stringify({
           reason: it.reason,
           origin_class: it.origin_class,
           quarantine_reason: it.quarantine_reason,
           tracker_params: it.tracker_params,
           content_digest: it.content_digest,
           mapping: it.mapping,
         })]);
    }
    await client.query('COMMIT');
    return { report, itemCount: cur.items.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function brief(it) {
  return {
    event_id: it.event_id, raw_url: it.raw_url, coverage: it.coverage,
    hits: it.hits, norm_key: it.norm_key ?? null,
  };
}

/**
 * 旧报告 vs 当前版本的实时差异（不改写任何数据）。
 * 迟到记录会出现在当前一侧的差异清单里，但旧报告本身保持原样。
 */
export async function diffReportWithCurrent(reportId) {
  const { rows } = await pool.query(
    `SELECT r.*, v.version_no, v.rules_fingerprint
       FROM coverage_reports r JOIN mapping_versions v ON v.id = r.mapping_version_id
      WHERE r.id=$1`, [reportId]);
  if (!rows.length) return null;
  const report = rows[0];
  const oldItems = await reportItems(pool, reportId);
  const cur = await computeCurrentCoverage(pool, {
    from: report.range_start, to: report.range_end,
  });
  const d = diffCoverageItems(oldItems, cur.items);
  return {
    report,
    current_version: cur.version,
    diff: {
      newly_uncovered: d.newly_uncovered.map(brief),
      newly_covered: d.newly_covered.map(brief),
      incomparable: d.incomparable.map(brief),
    },
  };
}

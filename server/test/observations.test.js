/**
 * 观察包接入与覆盖审阅的集成测试（真实 PostgreSQL + 真实本地站点）。
 *
 * 覆盖验收标准：
 *  ① 导入含正常旧址、410 栏目、不同 utm 值的观察包 → 原始记录可追溯，
 *     覆盖结论按当前映射与验证裁决展示；
 *  ② 同一事件/同一包重传，访问次数不翻倍；
 *  ③ 迟到记录进入正确时间段，但不改写已导出的历史报告；
 *  ④ 外网/格式错误记录被隔离并明确原因，验证器没有对它们发请求；
 *  ⑤ 映射版本更新后旧报告仍可复盘，新报告列出新增未覆盖/已覆盖/
 *     因规则差异无法比较的项，且这些边界持久化（刷新不丢）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureDatabase, pool } from '../src/db.js';
import { startFixture } from '../src/fixture.js';
import { normalize } from '../src/normalize.js';
import { recomputeMappings } from '../src/mappings-service.js';
import { runVerification } from '../src/verify-runner.js';
import { importBatch } from '../src/observations-service.js';
import {
  computeCurrentCoverage, exportReport, reportItems, diffReportWithCurrent,
} from '../src/coverage-service.js';
import { ensureMappingVersion } from '../src/mapping-versions.js';
import { fixtureOrigin } from '../src/config.js';

const O = fixtureOrigin();
let fixture = null;
let dbOk = false;

async function insertMapping(source, target, type) {
  const s = normalize(source);
  const t = normalize(target);
  await pool.query(
    `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type)
     VALUES ($1,$2,$3,$4,$5)`,
    [source, s.normKey, target, t.normKey, type]);
  await recomputeMappings(pool);
}

before(async () => {
  try {
    await ensureDatabase();
  } catch {
    return; // 无数据库：全部用例跳过
  }
  dbOk = true;
  try {
    fixture = await startFixture();
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e; // 已有实例在跑则复用
  }
  await pool.query(
    `TRUNCATE coverage_report_items, coverage_reports, observation_events,
              observation_batches, mapping_versions, migration_plan_items, migration_plans,
              verification_verdicts, crawl_results, url_mappings, mapping_inputs
     RESTART IDENTITY`);
  // 基础映射：一个正常迁移 + 一个已删除栏目（410）
  await insertMapping(`${O}/news/123`, `${O}/articles/123`, 'manual');
  await insertMapping(`${O}/forum/announce/9`, `${O}/forum/announce/9`, 'deleted');
  await runVerification(); // 真实验证，产生裁决
});

after(async () => {
  if (fixture) await fixture.close();
  if (dbOk) await pool.end();
});

const BATCH_1 = {
  batchKey: 'week-38',
  note: '第 38 周观察包',
  records: [
    { event_id: 'e1', url: `${O}/news/123?utm_source=weibo`, observed_start: '2026-09-14T10:00:00Z', observed_end: '2026-09-14T11:00:00Z', hits: 100, content_digest: 'sha256:e1' },
    { event_id: 'e2', url: `${O}/news/123?utm_source=newsletter&utm_campaign=fall`, observed_start: '2026-09-14T12:00:00Z', observed_end: '2026-09-14T13:00:00Z', hits: 50, content_digest: 'sha256:e2' },
    { event_id: 'e3', url: `${O}/forum/announce/9`, observed_start: '2026-09-14T14:00:00Z', observed_end: '2026-09-14T15:00:00Z', hits: 7, content_digest: 'sha256:e3' },
    { event_id: 'e4', url: `${O}/legacy/old-page`, observed_start: '2026-09-14T16:00:00Z', observed_end: '2026-09-14T17:00:00Z', hits: 200, content_digest: 'sha256:e4' },
    { event_id: 'e6', url: `${O}/column/weekly/?utm_source=weibo`, observed_start: '2026-09-14T18:00:00Z', observed_end: '2026-09-14T19:00:00Z', hits: 80, content_digest: 'sha256:e6' },
  ],
};
const BATCH_1_HITS = 437; // 100+50+7+200+80

test('① 导入观察包：原始记录可追溯，覆盖按当前映射与验证裁决', async (t) => {
  if (!dbOk) return t.skip('数据库不可用');
  const r = await importBatch(BATCH_1);
  assert.equal(r.idempotent, false);
  assert.equal(r.accepted, 5);
  assert.equal(r.quarantined, 0);

  // 原始记录可追溯：raw_url 原样（含 utm 值），追踪参数值单独留证，归一键正确
  const { rows } = await pool.query(
    `SELECT * FROM observation_events WHERE event_id='e2'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw_url, `${O}/news/123?utm_source=newsletter&utm_campaign=fall`);
  assert.deepEqual(rows[0].tracker_params.utm_source, ['newsletter']);
  assert.deepEqual(rows[0].tracker_params.utm_campaign, ['fall']);
  assert.equal(rows[0].norm_key, normalize(`${O}/news/123`).normKey, '追踪参数不进归一键');
  assert.ok(rows[0].rules_fingerprint, '记录所用规则指纹已保存');

  // 覆盖结论：按当前映射 + 验证裁决
  const cov = await computeCurrentCoverage(pool, {});
  const byEvent = new Map(cov.items.map((i) => [i.event_id, i]));
  assert.equal(byEvent.get('e1').coverage, 'covered');
  assert.equal(byEvent.get('e1').verdict, 'ok');
  assert.equal(byEvent.get('e2').coverage, 'covered', '不同 utm 值归一到同一映射');
  assert.equal(byEvent.get('e3').coverage, 'gone_ok', '410 栏目消亡正确');
  assert.equal(byEvent.get('e4').coverage, 'uncovered');
  assert.equal(byEvent.get('e6').coverage, 'uncovered', '/column/weekly/ 尚未建映射');
  assert.equal(cov.summary.total_hits, BATCH_1_HITS);
});

test('② 幂等：同包重传与同事件重传都不把次数翻倍', async (t) => {
  if (!dbOk) return t.skip('数据库不可用');
  // 整包重传 → 命中批次摘要，直接幂等返回
  const again = await importBatch(BATCH_1);
  assert.equal(again.idempotent, true);
  let { rows } = await pool.query(
    'SELECT COALESCE(SUM(hits),0)::int AS total FROM observation_events');
  assert.equal(rows[0].total, BATCH_1_HITS, '整包重传不计数');

  // 同一事件出现在另一个批次（内容一致）→ duplicate；新事件正常入库
  const retry = await importBatch({
    batchKey: 'week-38-retry',
    records: [
      BATCH_1.records[0],
      { event_id: 'e5', url: `${O}/legacy/another`, observed_start: '2026-09-15T10:00:00Z', observed_end: '2026-09-15T11:00:00Z', hits: 20, content_digest: 'sha256:e5' },
    ],
  });
  assert.equal(retry.duplicates, 1);
  assert.equal(retry.accepted, 1);
  ({ rows } = await pool.query(
    'SELECT COALESCE(SUM(hits),0)::int AS total FROM observation_events'));
  assert.equal(rows[0].total, BATCH_1_HITS + 20);

  // 同一 event_id 内容不一致 → 冲突，保留首次记录
  const conflict = await importBatch({
    batchKey: 'week-38-conflict',
    records: [{ ...BATCH_1.records[0], hits: 999 }],
  });
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.accepted, 0);
  ({ rows } = await pool.query(
    `SELECT hits FROM observation_events WHERE event_id='e1'`));
  assert.equal(rows[0].hits, 100, '首次记录不被改写');

  // 同 batch_key 不同内容 → 409
  await assert.rejects(
    importBatch({ batchKey: 'week-38', records: [BATCH_1.records[1]] }),
    (e) => e.statusCode === 409);
});

test('③ 迟到记录进入正确时间段，但不改写已导出的历史报告', async (t) => {
  if (!dbOk) return t.skip('数据库不可用');
  const range = { from: '2026-09-14T00:00:00Z', to: '2026-09-14T23:59:59Z' };
  const exported = await exportReport({ ...range, note: '9/14 日报' });
  const reportId = exported.report.id;
  const before = await reportItems(pool, reportId);
  assert.equal(before.length, 5, 'e5 在 9/15，不在本时间段');

  // 迟到记录：观察时间在已导出范围内，导出后才到达
  await importBatch({
    batchKey: 'late-arrivals-1',
    records: [{ event_id: 'late-1', url: `${O}/news/123?utm_source=late`, observed_start: '2026-09-14T20:00:00Z', observed_end: '2026-09-14T21:00:00Z', hits: 33, content_digest: 'sha256:late1' }],
  });

  // 历史报告原封不动
  const afterItems = await reportItems(pool, reportId);
  assert.deepEqual(
    afterItems.map((i) => [i.event_id, i.coverage, i.hits]),
    before.map((i) => [i.event_id, i.coverage, i.hits]),
    '已导出报告不被迟到记录改写');

  // 但迟到记录进入了正确时间段的当前覆盖
  const cov = await computeCurrentCoverage(pool, range);
  const late = cov.items.find((i) => i.event_id === 'late-1');
  assert.ok(late, '迟到记录按 observed 时间进入 9/14 时间段');
  assert.equal(late.coverage, 'covered');

  // 旧报告 vs 当前：迟到记录体现在差异里，而非改写历史
  const d = await diffReportWithCurrent(reportId);
  assert.ok(d.diff.newly_covered.some((i) => i.event_id === 'late-1'));
});

test('④ 外网与格式错误记录被隔离，验证器绝不请求', async (t) => {
  if (!dbOk) return t.skip('数据库不可用');
  const { rows: crawlBefore } = await pool.query('SELECT count(*)::int AS c FROM crawl_results');

  const r = await importBatch({
    batchKey: 'dirty-1',
    records: [
      { event_id: 'ext-1', url: 'http://example.com/x?utm_source=a', observed_start: '2026-09-16T10:00:00Z', observed_end: '2026-09-16T11:00:00Z', hits: 10, content_digest: 'sha256:ext1' },
      { event_id: 'bad-1', url: '::not a url::', observed_start: '2026-09-16T11:00:00Z', observed_end: '2026-09-16T12:00:00Z', hits: 5, content_digest: 'sha256:bad1' },
      { url: `${O}/news/123`, observed_start: '2026-09-16T12:00:00Z', observed_end: '2026-09-16T13:00:00Z', hits: 1 }, // 缺 event_id
    ],
  });
  assert.equal(r.accepted, 0);
  assert.equal(r.quarantined, 3);
  assert.equal(r.quarantines.length, 3);

  const { rows } = await pool.query(
    `SELECT * FROM observation_events WHERE event_id IN ('ext-1','bad-1')`);
  const ext = rows.find((x) => x.event_id === 'ext-1');
  assert.equal(ext.origin_class, 'external');
  assert.match(ext.quarantine_reason, /白名单/);
  assert.match(ext.quarantine_reason, /绝不发起请求/);
  const bad = rows.find((x) => x.event_id === 'bad-1');
  assert.equal(bad.origin_class, 'invalid');
  assert.match(bad.quarantine_reason, /URL 解析失败/);

  // 缺 event_id 的记录以合成标识隔离，重传仍幂等
  const again = await importBatch({
    batchKey: 'dirty-1-retry',
    records: [{ url: `${O}/news/123`, observed_start: '2026-09-16T12:00:00Z', observed_end: '2026-09-16T13:00:00Z', hits: 1 }],
  });
  assert.equal(again.duplicates, 1);

  // 验证器没有对它们发任何请求：爬取证据与裁决中无相关记录
  const { rows: crawlAfter } = await pool.query('SELECT count(*)::int AS c FROM crawl_results');
  assert.equal(crawlAfter[0].c, crawlBefore[0].c, '导入不触发任何爬取');
  const { rows: evil } = await pool.query(
    `SELECT count(*)::int AS c FROM crawl_results
      WHERE url_raw LIKE '%example.com%' OR url_raw LIKE '%not a url%'`);
  assert.equal(evil[0].c, 0);
  const { rows: evilV } = await pool.query(
    `SELECT count(*)::int AS c FROM verification_verdicts WHERE source_raw LIKE '%example.com%'`);
  assert.equal(evilV[0].c, 0);

  // 覆盖结论：隔离记录只标记不可验证
  const cov = await computeCurrentCoverage(pool, {});
  assert.equal(cov.items.find((i) => i.event_id === 'ext-1').coverage, 'unverifiable');
  assert.equal(cov.items.find((i) => i.event_id === 'bad-1').coverage, 'unverifiable');
});

test('⑤ 版本更新：旧报告可复盘，新报告列差异，规则差异无法比较', async (t) => {
  if (!dbOk) return t.skip('数据库不可用');
  // 基线报告：e6（/column/weekly/）未覆盖
  const r1 = await exportReport({ note: '整改前基线' });
  const r1Items = await reportItems(pool, r1.report.id);
  assert.equal(r1Items.find((i) => i.event_id === 'e6').coverage, 'uncovered');
  const r1VersionId = r1.report.mapping_version_id;

  // 映射更新：补上 /column/weekly/，并真实验证
  await insertMapping(`${O}/column/weekly/`, `${O}/sections/weekly`, 'manual');
  await runVerification();

  // 产生了新映射版本，且旧报告仍绑定旧版本
  const { rows: versions } = await pool.query(
    'SELECT * FROM mapping_versions ORDER BY version_no');
  assert.ok(versions.length >= 2, '映射变更产生新版本');
  const latest = versions.at(-1);
  assert.notEqual(latest.id, r1VersionId);
  const { rows: r1Row } = await pool.query(
    'SELECT * FROM coverage_reports WHERE id=$1', [r1.report.id]);
  assert.equal(r1Row[0].mapping_version_id, r1VersionId, '旧报告绑定旧版本不变');
  const r1ItemsAgain = await reportItems(pool, r1.report.id);
  assert.equal(
    r1ItemsAgain.find((i) => i.event_id === 'e6').coverage, 'uncovered',
    '旧报告明细保持导出时结论（可复盘）');

  // 新报告：e6 转入已覆盖；diff 固化在 summary 里
  const r2 = await exportReport({ note: '补映射后' });
  const diff = r2.report.summary.diff;
  assert.ok(diff, '与上一报告的差异已固化');
  assert.ok(diff.newly_covered.some((i) => i.event_id === 'e6'), '新增已覆盖列出 e6');
  assert.equal(diff.newly_uncovered.length, 0);

  // 规则升级（模拟）：事件指纹与当前版本不一致 → 无法比较
  await ensureMappingVersion(pool, {
    rulesFingerprintOverride: 'rules-v2-simulated', note: '模拟规则升级',
  });
  const covAfterRuleChange = await computeCurrentCoverage(pool, {});
  const incomparable = covAfterRuleChange.items.filter((i) => i.coverage === 'incomparable');
  assert.ok(incomparable.length > 0, '规则差异的事件标记为无法比较');
  assert.ok(incomparable.every((i) => i.origin_class === 'local'), '只有本地记录参与规则比较');

  const r3 = await exportReport({ note: '规则升级后首报' });
  assert.ok(r3.report.summary.diff.incomparable.length > 0, '新报告列出无法比较项');

  // 刷新（重新从库里读）后这些边界不丢失
  const { rows: r3Row } = await pool.query(
    'SELECT summary FROM coverage_reports WHERE id=$1', [r3.report.id]);
  assert.ok(r3Row[0].summary.diff.incomparable.length > 0, 'diff 边界持久化');
  const r3Items = await reportItems(pool, r3.report.id);
  assert.ok(r3Items.some((i) => i.coverage === 'incomparable'), '报告明细同样持久化');
});

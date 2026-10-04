/**
 * 观察包接入与覆盖审阅测试。
 *
 * 纯函数部分（分类/留证/幂等摘要/覆盖/时间线/版本差异/绝不发请求）总是运行；
 * 数据库集成部分（验收①-⑤端到端）在本地 PostgreSQL 不可用时自动跳过。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {
  classifyRecord, classifyPackage, computeCoverage, diffCoverage,
  recordDigest, batchDigest,
} from '../src/observations.js';
import { normalize } from '../src/normalize.js';
import { config, fixtureOrigin } from '../src/config.js';
import { buildSamplePackage, buildLatePackage } from '../src/observation-sample.js';

const O = fixtureOrigin();

// ---------- 纯函数：分类与留证 ------------------------------------------------

test('观察记录留证：原始路径、百分号编码、追踪参数值全部保留', () => {
  const ev = classifyRecord({
    event_id: 'e1',
    url: `${O}/old-files%2fdraft?utm_source=Weibo&utm_source=app&page=2`,
    window_start: '2026-09-24T10:00:00Z',
    window_end: '2026-09-24T11:00:00Z',
    hits: 3,
  });
  assert.equal(ev.status, 'observed');
  assert.equal(ev.url_raw, `${O}/old-files%2fdraft?utm_source=Weibo&utm_source=app&page=2`,
    '原始 URL 一字不差留证');
  assert.equal(ev.pathname_raw, '/old-files%2fdraft', '原始路径保留小写 %2f，不 decode');
  assert.equal(ev.norm_key, `${O}/old-files%2Fdraft?page=2`,
    '归一键只统一十六进制大小写、剥离追踪参数、保留身份参数');
  assert.deepEqual(ev.tracker_params, { utm_source: ['Weibo', 'app'] },
    '追踪参数值（含大小写与多值）原样留证');
});

test('不同 utm 值的记录归一到同一键，但证据不合并丢失', () => {
  const a = classifyRecord({ event_id: 'a', url: `${O}/news/123?utm_source=weibo`,
    window_start: '2026-09-24T10:00:00Z', window_end: '2026-09-24T11:00:00Z', hits: 12 });
  const b = classifyRecord({ event_id: 'b', url: `${O}/news/123?utm_source=partner&utm_campaign=autumn`,
    window_start: '2026-09-24T11:00:00Z', window_end: '2026-09-24T12:00:00Z', hits: 5 });
  assert.equal(a.norm_key, b.norm_key);

  const cov = computeCoverage([a, b], [], new Map());
  assert.equal(cov.items.length, 1);
  const item = cov.items[0];
  assert.equal(item.hits, 17, '次数汇总');
  assert.equal(item.event_count, 2);
  assert.deepEqual(item.tracker_values, {
    utm_campaign: ['autumn'], utm_source: ['partner', 'weibo'],
  }, '追踪参数值集合留证');
  assert.deepEqual(item.sample_urls.map((s) => s.url_raw).sort(), [
    `${O}/news/123?utm_source=partner&utm_campaign=autumn`,
    `${O}/news/123?utm_source=weibo`,
  ], '每种原始写法都保留，不因汇总丢失');
});

test('外网 origin 与格式错误记录被隔离并明确原因', () => {
  const ext = classifyRecord({ event_id: 'x1', url: 'http://example.com/promo?utm_source=edm',
    window_start: '2026-09-27T12:00:00Z', window_end: '2026-09-27T13:00:00Z', hits: 6 });
  assert.equal(ext.status, 'quarantined');
  assert.match(ext.quarantine_reason, /白名单|不可验证/);
  assert.match(ext.quarantine_reason, /绝不.*请求/);

  const bad = classifyRecord({ event_id: 'x2', url: 'not-a-valid-url',
    window_start: '2026-09-27T13:00:00Z', window_end: '2026-09-27T14:00:00Z', hits: 1 });
  assert.equal(bad.status, 'quarantined');
  assert.match(bad.quarantine_reason, /格式错误/);

  const noId = classifyRecord({ url: `${O}/news/123`,
    window_start: '2026-09-27T13:00:00Z', window_end: '2026-09-27T14:00:00Z', hits: 1 },
    { batchKey: 'b1', index: 0 });
  assert.equal(noId.status, 'quarantined');
  assert.match(noId.quarantine_reason, /event_id/);
  assert.ok(noId.event_id.startsWith('invalid:b1:'), '结构非法记录也获得确定性的占位标识');
});

test('批次摘要幂等：等价写法同摘要，记录顺序无关；内容变化即不同', () => {
  const p1 = buildSamplePackage();
  const p2 = buildSamplePackage();
  p2.records.reverse();
  const c1 = classifyPackage(p1);
  const c2 = classifyPackage(p2);
  assert.ok(c1.ok && c2.ok);
  assert.equal(c1.digest, c2.digest, '同内容不同顺序 → 同批次摘要');

  const p3 = buildSamplePackage();
  p3.records[0].hits = 13;
  assert.notEqual(classifyPackage(p3).digest, c1.digest, '内容变化 → 摘要不同（触发 409 而非静默覆盖）');

  assert.equal(recordDigest({ event_id: 'e', url: 'http://a/b', window_start: '2026-09-24T10:00:00Z',
    window_end: '2026-09-24T11:00:00.000Z', hits: 2 }),
    recordDigest({ event_id: 'e', url: 'http://a/b', window_start: '2026-09-24T10:00:00Z',
      window_end: '2026-09-24T11:00:00Z', hits: 2 }),
    '等价时间写法得到相同记录摘要');
  assert.ok(batchDigest(['a', 'b']) === batchDigest(['b', 'a']));
});

test('覆盖状态：covered / blocked / unverified / unmapped，410 栏目按裁决算覆盖', () => {
  const ev = (id, url, hits = 1) => classifyRecord({ event_id: id, url,
    window_start: '2026-09-24T10:00:00Z', window_end: '2026-09-24T11:00:00Z', hits });
  const events = [
    ev('ok', `${O}/news/123?utm_source=weibo`, 4),
    ev('gone', `${O}/forum/announce/9`, 2),
    ev('bad', `${O}/News/123`, 1),
    ev('noverdict', `${O}/column/weekly/`, 3),
    ev('conf', `${O}/loop/a`, 1),
    ev('gap', `${O}/legacy/unknown-page`, 9),
  ];
  const mappings = [
    { source_norm: `${O}/news/123`, target_raw: `${O}/articles/123`, target_norm: `${O}/articles/123`, mapping_type: 'manual', status: 'active' },
    { source_norm: `${O}/forum/announce/9`, target_raw: `${O}/forum/announce/9`, target_norm: `${O}/forum/announce/9`, mapping_type: 'deleted', status: 'active' },
    { source_norm: `${O}/News/123`, target_raw: `${O}/articles/123`, target_norm: `${O}/articles/123`, mapping_type: 'manual', status: 'active' },
    { source_norm: `${O}/column/weekly/`, target_raw: `${O}/sections/weekly`, target_norm: `${O}/sections/weekly`, mapping_type: 'manual', status: 'active' },
    { source_norm: `${O}/loop/a`, target_raw: `${O}/loop/b`, target_norm: `${O}/loop/b`, mapping_type: 'manual', status: 'conflicted' },
  ];
  const verdicts = new Map([
    [`${O}/news/123`, { verdict: 'ok' }],
    [`${O}/forum/announce/9`, { verdict: 'deleted_gone_ok' }],
    [`${O}/News/123`, { verdict: 'final_status_bad' }],
  ]);
  const cov = computeCoverage(events, mappings, verdicts);
  const byKey = new Map(cov.items.map((i) => [i.norm_key, i]));
  assert.equal(byKey.get(`${O}/news/123`).status, 'covered');
  assert.equal(byKey.get(`${O}/forum/announce/9`).status, 'covered', '410 栏目裁决正确即覆盖');
  assert.equal(byKey.get(`${O}/News/123`).status, 'blocked', '验证未过 → 阻断');
  assert.equal(byKey.get(`${O}/column/weekly/`).status, 'unverified', '有映射无裁决 → 未验证');
  assert.equal(byKey.get(`${O}/loop/a`).status, 'blocked', '歧义 → 阻断');
  assert.equal(byKey.get(`${O}/legacy/unknown-page`).status, 'unmapped', '无映射 → 未覆盖');
  assert.equal(cov.summary.by_status.covered.hits, 6);
});

test('时间线：迟到记录按自身 window 归入正确时间段', () => {
  const ev = (id, hits, ws, we) => classifyRecord({ event_id: id,
    url: `${O}/news/123?utm_source=weibo`, window_start: ws, window_end: we, hits });
  const events = [
    ev('on-time', 12, '2026-09-24T10:00:00Z', '2026-09-24T11:00:00Z'),
    ev('late', 4, '2026-09-24T10:00:00Z', '2026-09-24T11:00:00Z'), // 迟到但窗口在 09-24
    ev('next', 6, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z'),
  ];
  const cov = computeCoverage(events, [], new Map());
  const b24 = cov.timeline.find((b) => b.bucket === '2026-09-24');
  const b01 = cov.timeline.find((b) => b.bucket === '2026-10-01');
  assert.equal(b24.hits, 16, '迟到记录进入 09-24 桶而不是导入当天');
  assert.equal(b24.events, 2);
  assert.equal(b01.hits, 6);
});

test('版本差异：新增未覆盖 / 已覆盖 / 规则差异无法比较，边界稳定', () => {
  const oldItems = [
    { norm_key: `${O}/news/123`, status: 'covered', hits: 17,
      sample_urls: [{ url_raw: `${O}/news/123?utm_source=weibo`, hits: 12 }] },
    { norm_key: `${O}/legacy/unknown-page`, status: 'unmapped', hits: 9,
      sample_urls: [{ url_raw: `${O}/legacy/unknown-page?utm_source=edm`, hits: 9 }] },
    { norm_key: `${O}/column/weekly/`, status: 'covered', hits: 4,
      sample_urls: [{ url_raw: `${O}/column/weekly/`, hits: 4 }] },
  ];
  const currentItems = [
    { norm_key: `${O}/news/123`, status: 'covered', hits: 21, verdict: 'ok',
      sample_urls: [{ url_raw: `${O}/news/123?utm_source=weibo`, hits: 16 }] },
    { norm_key: `${O}/legacy/unknown-page`, status: 'covered', hits: 15, verdict: 'ok',
      sample_urls: [{ url_raw: `${O}/legacy/unknown-page?utm_source=edm`, hits: 15 }] },
    // 规则升级（尾斜杠 ignore）后：/column/weekly/ 的当前键变为 /column/weekly
    { norm_key: `${O}/column/weekly`, status: 'unmapped', hits: 4,
      sample_urls: [{ url_raw: `${O}/column/weekly/`, hits: 4 }] },
    { norm_key: `${O}/legacy/another-gap`, status: 'unmapped', hits: 2,
      sample_urls: [{ url_raw: `${O}/legacy/another-gap?utm_source=edm`, hits: 2 }] },
  ];
  const ignoreSlash = (raw) => normalize(raw, { tailSlashMode: 'ignore' });
  const d = diffCoverage(oldItems, currentItems, ignoreSlash);

  assert.deepEqual(d.newly_uncovered.map((i) => i.norm_key), [`${O}/legacy/another-gap`],
    '旧报告之后新观察到的未覆盖项');
  const coveredKeys = d.covered.map((i) => [i.norm_key, i.change]);
  assert.ok(coveredKeys.some(([k, c]) => k === `${O}/news/123` && c === 'still_covered'));
  assert.ok(coveredKeys.some(([k, c]) => k === `${O}/legacy/unknown-page` && c === 'newly_covered'),
    '补映射后新增覆盖');
  assert.equal(d.incomparable.length, 1, '尾斜杠规则差异 → 无法比较');
  assert.equal(d.incomparable[0].old_norm_key, `${O}/column/weekly/`);
  assert.equal(d.incomparable[0].current_norm_key, `${O}/column/weekly`);
  assert.ok(!d.newly_uncovered.some((i) => i.norm_key === `${O}/column/weekly`),
    '无法比较项的新键被认领，不得计入新增未覆盖');
  assert.equal(d.still_uncovered.length, 0);

  // 边界由输入决定：同样输入重算结果一致（刷新不丢失）
  assert.deepEqual(diffCoverage(oldItems, currentItems, ignoreSlash), d);
});

test('观察接入与覆盖计算绝不发起任何网络请求', async () => {
  let count = 0;
  const origGet = http.get; const origGetS = https.get;
  const origReq = http.request; const origReqS = https.request;
  http.get = (...a) => { count += 1; return origGet(...a); };
  https.get = (...a) => { count += 1; return origGetS(...a); };
  http.request = (...a) => { count += 1; return origReq(...a); };
  https.request = (...a) => { count += 1; return origReqS(...a); };
  try {
    const parsed = classifyPackage(buildSamplePackage());
    assert.ok(parsed.ok);
    const observed = parsed.events.filter((e) => e.status === 'observed');
    const quarantined = parsed.events.filter((e) => e.status === 'quarantined');
    const cov = computeCoverage(observed, [], new Map(), quarantined);
    diffCoverage(cov.items, cov.items);
    assert.equal(count, 0, '外网/格式错误记录只标记，不请求');
    assert.equal(cov.quarantined.length, 2, '隔离记录单独列出，不参与覆盖');
    assert.ok(cov.items.every((i) => !i.norm_key.includes('example.com')),
      '外网地址不进入覆盖项');
  } finally {
    http.get = origGet; https.get = origGetS;
    http.request = origReq; https.request = origReqS;
  }
});

// ---------- 数据库集成：验收①-⑤（PG 不可用时跳过） -----------------------------

let dbOk = false;
try {
  const { ensureDatabase } = await import('../src/db.js');
  await ensureDatabase();
  dbOk = true;
} catch {
  dbOk = false;
}
const dbTest = dbOk ? test : test.skip;

let fixture; let pool; let svc; let runner; let mappingsService;
const V = {}; // 版本号记录

if (dbOk) {
  ({ pool } = await import('../src/db.js'));
  svc = await import('../src/observation-service.js');
  runner = await import('../src/verify-runner.js');
  mappingsService = await import('../src/mappings-service.js');
  const mv = await import('../src/mapping-versions.js');
  const { startFixture } = await import('../src/fixture.js');
  const { normalize: norm } = await import('../src/normalize.js');

  const INPUTS = [
    [`${O}/news/123`, `${O}/articles/123`, 'manual'],
    [`${O}/%E9%A2%91%E9%81%93/%E7%A7%91%E6%8A%80/42.html`, `${O}/articles/tech/42`, 'manual'],
    [`${O}/column/weekly/`, `${O}/sections/weekly`, 'manual'],
    [`${O}/old-files%2Fdraft`, `${O}/files%2Fdraft`, 'manual'],
    [`${O}/forum/announce/9`, `${O}/forum/announce/9`, 'deleted'],
  ];

  before(async () => {
    fixture = await startFixture();
    await pool.query(`TRUNCATE coverage_reports, observation_events, observation_batches,
      mapping_versions, migration_plan_items, migration_plans, verification_verdicts,
      crawl_results, url_mappings, mapping_inputs RESTART IDENTITY`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [s, t, ty] of INPUTS) {
        await client.query(
          `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type)
           VALUES ($1,$2,$3,$4,$5)`,
          [s, norm(s).normKey, t, norm(t).normKey, ty]);
      }
      await mappingsService.recomputeMappings(client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await runner.runVerification();
    V.v1 = (await mv.ensureCurrentVersion()).version.id;
  });

  after(async () => {
    if (fixture) await fixture.close();
    if (pool) await pool.end();
  });
}

dbTest('① 导入观察包：原始记录可追溯，覆盖按当前映射与裁决展示', async () => {
  const r = await svc.importPackage(buildSamplePackage());
  assert.equal(r.inserted, 9);
  assert.equal(r.quarantined, 2, '外网 + 格式错误各一');
  assert.equal(r.mapping_version_id, V.v1);

  const events = await svc.listEvents();
  assert.equal(events.length, 9);
  const e3 = events.find((e) => e.event_id === 'evt-2026w39-0003');
  assert.equal(e3.url_raw,
    `${O}/%E9%A2%91%E9%81%93/%E7%A7%91%E6%8A%80/42.html?utm_medium=app`,
    '编码中文路径原样可追溯');
  assert.equal(e3.pathname_raw, '/%E9%A2%91%E9%81%93/%E7%A7%91%E6%8A%80/42.html');
  const e6 = events.find((e) => e.event_id === 'evt-2026w39-0006');
  assert.equal(e6.pathname_raw, '/old-files%2Fdraft', '%2F 原样保留');
  assert.deepEqual(e6.tracker_params, { utm_source: ['app'] });

  const cov = await svc.liveCoverage();
  const byKey = new Map(cov.items.map((i) => [i.norm_key, i]));
  assert.equal(byKey.get(`${O}/news/123`).status, 'covered');
  assert.equal(byKey.get(`${O}/news/123`).hits, 17, '两条不同 utm 记录聚合');
  assert.deepEqual(byKey.get(`${O}/news/123`).tracker_values.utm_source, ['partner', 'weibo']);
  assert.equal(byKey.get(`${O}/forum/announce/9`).status, 'covered', '410 栏目 deleted_gone_ok → 覆盖');
  assert.equal(byKey.get(`${O}/legacy/unknown-page`).status, 'unmapped');
  assert.equal(cov.quarantined.length, 2);
  assert.match(cov.quarantined.find((q) => q.url_raw.includes('example.com')).reason, /白名单/);
  assert.match(cov.quarantined.find((q) => q.url_raw === 'not-a-valid-url').reason, /格式错误/);
});

dbTest('② 同一包重传 / 同一事件重传：次数不翻倍', async () => {
  const again = await svc.importPackage(buildSamplePackage());
  assert.equal(again.duplicated, true, '同批次同摘要 → 幂等 no-op');
  assert.equal(again.inserted, 0);

  const late = await svc.importPackage(buildLatePackage());
  assert.equal(late.inserted, 3, '迟到 1 条 + 追加观察 1 条 + 新缺口 1 条');
  assert.equal(late.skipped, 1, 'evt-2026w39-0001 重复事件被幂等跳过');

  const cov = await svc.liveCoverage();
  const news = cov.items.find((i) => i.norm_key === `${O}/news/123`);
  assert.equal(news.hits, 12 + 5 + 4, '12+5 首批 + 4 迟到；重复事件不重复计数');
});

dbTest('②b 同 batch_key 不同内容摘要 → 409 拒绝覆盖', async () => {
  const tampered = buildSamplePackage();
  tampered.records[0].hits = 999;
  await assert.rejects(() => svc.importPackage(tampered), (e) => {
    assert.equal(e.statusCode, 409);
    assert.match(e.message, /内容摘要不同/);
    return true;
  });
  const cov = await svc.liveCoverage();
  assert.equal(cov.items.find((i) => i.norm_key === `${O}/news/123`).hits, 21, '被拒包不污染数据');
});

dbTest('③ 迟到记录进入正确时间段，但不改写已导出的历史版本报告', async () => {
  // 当前（迟到已导入）再导出一个“迟到后”报告无意义 —— 这里验证的是：
  // 先用仅存的首批数据导出报告的场景由测试顺序保证不了，因此直接校验：
  // a) 实时时间线把迟到记录归入 09-24；b) 已导出报告（下面导出）之后不受新导入影响。
  const cov = await svc.liveCoverage();
  const b24 = cov.timeline.find((b) => b.bucket === '2026-09-24');
  assert.equal(b24.hits, 21, '迟到记录归入 09-24 时间段');

  const { report } = await svc.exportReport('验收③基线');
  const before = await svc.getReport(report.id);
  assert.equal(before.items.find((i) => i.norm_key === `${O}/news/123`).hits, 21);
  assert.equal(before.timeline.find((b) => b.bucket === '2026-09-24').hits, 21);

  // 再补传迟到记录（窗口仍在 09-24）与一个全新的未覆盖缺口
  await svc.importPackage({
    batch_key: 'ops-2026-W39-site-a-late2',
    records: [
      { event_id: 'evt-2026w39-0013', url: `${O}/news/123?utm_source=weibo`,
        window_start: '2026-09-24T10:00:00Z', window_end: '2026-09-24T11:00:00Z', hits: 7 },
      { event_id: 'evt-2026w39-0014', url: `${O}/legacy/second-gap?utm_source=edm`,
        window_start: '2026-10-02T10:00:00Z', window_end: '2026-10-02T11:00:00Z', hits: 1 },
    ],
  });
  const afterLive = await svc.liveCoverage();
  assert.equal(afterLive.items.find((i) => i.norm_key === `${O}/news/123`).hits, 28,
    '实时覆盖计入新迟到记录');
  assert.equal(afterLive.timeline.find((b) => b.bucket === '2026-09-24').hits, 28,
    '实时时间线 09-24 桶更新');

  const afterReport = await svc.getReport(report.id);
  assert.deepEqual(afterReport.items, before.items, '已导出报告不被迟到记录改写');
  assert.deepEqual(afterReport.timeline, before.timeline, '已导出报告的时间段快照不变');
  V.reportId = report.id;
});

dbTest('④ 隔离记录明确原因，且导入全程没有任何网络请求', async () => {
  let count = 0;
  const origGet = http.get; const origGetS = https.get;
  http.get = (...a) => { count += 1; return origGet(...a); };
  https.get = (...a) => { count += 1; return origGetS(...a); };
  try {
    const r = await svc.importPackage({
      batch_key: 'ops-net-guard',
      records: [
        { event_id: 'g1', url: 'http://example.com/x?utm_source=edm',
          window_start: '2026-10-02T00:00:00Z', window_end: '2026-10-02T01:00:00Z', hits: 3 },
        { event_id: 'g2', url: 'https://internal.other-port:9999/y',
          window_start: '2026-10-02T00:00:00Z', window_end: '2026-10-02T01:00:00Z', hits: 1 },
        { event_id: 'g3', url: ':::broken',
          window_start: '2026-10-02T00:00:00Z', window_end: '2026-10-02T01:00:00Z', hits: 1 },
      ],
    });
    assert.equal(r.quarantined, 3);
    assert.equal(count, 0, '导入不发起任何请求');
  } finally {
    http.get = origGet; https.get = origGetS;
  }
  const quar = await svc.listEvents({ status: 'quarantined' });
  const g = quar.filter((e) => e.batch_key === 'ops-net-guard');
  assert.equal(g.length, 3);
  assert.ok(g.every((e) => e.quarantine_reason), '每条隔离记录都有明确原因');
  const { rows: crawls } = await pool.query(
    `SELECT count(*)::int AS n FROM crawl_results WHERE url_raw LIKE '%example.com%'`);
  assert.equal(crawls[0].n, 0, '验证器没有为隔离地址留下任何爬取记录');
});

dbTest('⑤ 映射版本更新：旧报告可复盘，差异列出新增未覆盖/已覆盖，边界刷新不丢', async () => {
  // 版本升级 1：补录 /legacy/unknown-page 映射并验证通过
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = `${O}/legacy/unknown-page`; const t = `${O}/articles/legacy/unknown-page`;
    await client.query(
      `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type)
       VALUES ($1,$2,$3,$4,'manual')`,
      [s, normalize(s).normKey, t, normalize(t).normKey]);
    await mappingsService.recomputeMappings(client);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  await runner.runVerification();

  const diff1 = await svc.diffWithCurrent(V.reportId);
  assert.equal(diff1.base_report.mapping_version_id, V.v1, '旧报告仍绑定旧版本');
  assert.ok(diff1.current_version.id > V.v1, '映射变化产生新版本');
  assert.equal(diff1.rules_changed, false);
  const newlyCovered = diff1.covered.filter((i) => i.change === 'newly_covered');
  assert.ok(newlyCovered.some((i) => i.norm_key === `${O}/legacy/unknown-page`),
    '补映射后新增覆盖');
  assert.ok(diff1.newly_uncovered.some((i) => i.norm_key === `${O}/legacy/second-gap`),
    '报告导出后新观察到的未覆盖项');
  assert.ok(diff1.still_uncovered.some((i) => i.norm_key === `${O}/legacy/another-gap`),
    '报告时未覆盖、当前仍未覆盖');
  assert.equal(diff1.incomparable.length, 0, '规则未变时没有无法比较项');

  // 版本升级 2：规范化规则变化（尾斜杠 keep → ignore）
  const oldMode = config.rules.tailSlashMode;
  config.rules.tailSlashMode = 'ignore';
  try {
    const diff2 = await svc.diffWithCurrent(V.reportId);
    assert.equal(diff2.rules_changed, true);
    assert.equal(diff2.incomparable.length, 1, '只有尾斜杠键受规则差异影响');
    const inc = diff2.incomparable[0];
    assert.equal(inc.old_norm_key, `${O}/column/weekly/`);
    assert.equal(inc.current_norm_key, `${O}/column/weekly`);
    assert.ok(!diff2.newly_uncovered.some((i) => i.norm_key === `${O}/column/weekly`),
      '无法比较项的新键不计入新增未覆盖');

    // 刷新不丢边界：重复计算结果一致
    const diff2again = await svc.diffWithCurrent(V.reportId);
    assert.deepEqual(diff2again, diff2);
  } finally {
    config.rules.tailSlashMode = oldMode;
  }

  // 旧报告复盘：内容仍是导出时的版本快照
  const replay = await svc.getReport(V.reportId);
  assert.equal(replay.mapping_version_id, V.v1);
  assert.ok(replay.items.some((i) => i.norm_key === `${O}/column/weekly/`),
    '旧报告里尾斜杠键保持旧规则形态');
  assert.ok(replay.items.some((i) => i.norm_key === `${O}/legacy/unknown-page` && i.status === 'unmapped'),
    '旧报告里该旧址仍是未覆盖（历史不被改写）');
});

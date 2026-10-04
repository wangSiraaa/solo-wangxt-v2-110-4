/** REST API：映射录入、规范化试算、验证、迁移方案与发布闸门、观察包与覆盖审阅。 */
import { pool } from './db.js';
import { normalize, carryTrackers, splitQuery } from './normalize.js';
import { recomputeMappings } from './mappings-service.js';
import { runVerification, VERDICT_LABEL } from './verify-runner.js';
import { importBatch } from './observations-service.js';
import {
  computeCurrentCoverage, exportReport, reportItems, diffReportWithCurrent,
} from './coverage-service.js';
import { COVERAGE_LABEL } from './coverage-core.js';
import { config } from './config.js';

export default async function api(app) {
  app.get('/api/health', async () => ({ ok: true, fixture: `127.0.0.1:${config.fixture.port}` }));

  app.get('/api/rules', async () => config.rules);

  // 规范化试算（不写库）：展示大小写/编码/尾斜杠/查询参数如何处理
  app.post('/api/normalize', async (req) => {
    const { urls } = req.body ?? {};
    if (!Array.isArray(urls)) {
      return app.httpErrors?.badRequest?.('urls[] required') ?? { error: 'urls[] required' };
    }
    return urls.map((u) => {
      const r = normalize(String(u));
      if (!r.ok) return { input: u, ok: false, error: r.error };
      const { trackers } = splitQuery(new URL(u).search);
      return {
        input: u, ok: true,
        norm_key: r.normKey,
        pathname: r.pathname,
        identity_query: r.identityQuery,
        tracker_params: [...trackers.keys()],
      };
    });
  });

  // 全量材料：原始输入 + 生效映射 + 最新裁决
  app.get('/api/mappings', async () => {
    const { rows: inputs } = await pool.query(
      `SELECT i.*, v.verdict, v.issues, v.final_status, v.final_url_raw, v.hops,
              v.tracker_preserved, v.verified_at
         FROM mapping_inputs i
         LEFT JOIN verification_verdicts v ON v.source_norm = i.source_norm
        ORDER BY i.id`);
    const { rows: mappings } = await pool.query('SELECT * FROM url_mappings ORDER BY id');
    const { rows: ambiguities } = await pool.query('SELECT * FROM mapping_ambiguities ORDER BY source_norm');
    return { inputs, mappings, ambiguities, verdictLabel: VERDICT_LABEL };
  });

  // 录入一条原始映射：只进 mapping_inputs；随后重算 url_mappings 状态
  app.post('/api/mappings', async (req, reply) => {
    const { source_raw, target_raw, mapping_type = 'manual', note } = req.body ?? {};
    const s = normalize(String(source_raw ?? ''));
    const t = normalize(String(target_raw ?? ''));
    if (!s.ok) return reply.code(400).send({ error: `source: ${s.error}` });
    if (!t.ok) return reply.code(400).send({ error: `target: ${t.error}` });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [source_raw, s.normKey, target_raw, t.normKey, mapping_type, note ?? null]);
      await recomputeMappings(client);
      await client.query('COMMIT');
      return { ok: true, source_norm: s.normKey, target_norm: t.normKey };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  app.post('/api/verify', async (req) => {
    const onlyKey = req.body?.source_norm ?? null;
    return runVerification({ onlyKey });
  });

  app.get('/api/crawl/:key', async (req, reply) => {
    const key = decodeURIComponent(req.params.key);
    const { rows } = await pool.query(
      'SELECT * FROM crawl_results WHERE source_norm=$1 ORDER BY hop_index', [key]);
    if (!rows.length) return reply.code(404).send({ error: 'no crawl evidence; run verification first' });
    return rows;
  });

  // ---- 迁移方案 -------------------------------------------------------

  app.get('/api/plans', async () => {
    const { rows } = await pool.query(
      `SELECT p.*,
              count(pi.id) AS items,
              count(pi.id) FILTER (WHERE pi.item_status='verified') AS verified,
              count(pi.id) FILTER (WHERE pi.item_status='blocked')  AS blocked,
              count(pi.id) FILTER (WHERE pi.item_status='pending')  AS pending
         FROM migration_plans p
         LEFT JOIN migration_plan_items pi ON pi.plan_id=p.id
        GROUP BY p.id ORDER BY p.id`);
    return rows;
  });

  app.post('/api/plans', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO migration_plans (name) VALUES ($1)
         RETURNING *`, [name]);
      return rows[0];
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'plan name exists' });
      throw e;
    }
  });

  // 把全部 active 映射纳入方案，并按最新裁决设置条目状态
  app.post('/api/plans/:id/build', async (req, reply) => {
    const planId = Number(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: plan } = await client.query('SELECT * FROM migration_plans WHERE id=$1', [planId]);
      if (!plan.length) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'plan not found' }); }
      if (plan[0].status === 'published') {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: '已发布方案不可改' });
      }
      await client.query('DELETE FROM migration_plan_items WHERE plan_id=$1', [planId]);

      const { rows: ms } = await client.query(
        `SELECT m.*, v.verdict, v.issues, v.final_status, v.final_url_raw,
                v.final_url_norm, v.hops, v.tracker_preserved
           FROM url_mappings m
           LEFT JOIN verification_verdicts v ON v.source_norm=m.source_norm
          WHERE m.status='active' ORDER BY m.id`);
      for (const m of ms) {
        const good = m.verdict === 'ok' || m.verdict === 'deleted_gone_ok';
        // 计划中的最终跳转 URL：携带追踪参数的示例（取首次输入的参数）
        const { rows: ins } = await client.query(
          'SELECT source_raw FROM mapping_inputs WHERE source_norm=$1 ORDER BY id LIMIT 1',
          [m.source_norm]);
        const proposed = m.mapping_type === 'deleted'
          ? null
          : carryTrackers(ins[0].source_raw, m.target_raw);
        await client.query(
          `INSERT INTO migration_plan_items (plan_id, mapping_id, item_status, evidence)
           VALUES ($1,$2,$3,$4)`,
          [planId, m.id,
           good ? 'verified' : m.verdict ? 'blocked' : 'pending',
           JSON.stringify({
             verdict: m.verdict ?? null,
             issues: m.issues ?? [],
             final_status: m.final_status ?? null,
             final_url: m.final_url_raw ?? null,
             hops: m.hops ?? 0,
             tracker_preserved: m.tracker_preserved ?? null,
             proposed_redirect_url: proposed,
           })]);
      }
      await client.query('COMMIT');
      return { built: ms.length };
    } finally {
      client.release();
    }
  });

  app.get('/api/plans/:id', async (req, reply) => {
    const { rows: plans } = await pool.query('SELECT * FROM migration_plans WHERE id=$1', [req.params.id]);
    if (!plans.length) return reply.code(404).send({ error: 'not found' });
    const { rows: items } = await pool.query(
      `SELECT pi.*, m.source_raw, m.source_norm, m.target_raw, m.target_norm,
              m.mapping_type, pi.evidence
         FROM migration_plan_items pi
         JOIN url_mappings m ON m.id=pi.mapping_id
        WHERE pi.plan_id=$1 ORDER BY pi.id`, [req.params.id]);
    return { plan: plans[0], items };
  });

  /**
   * 发布闸门：
   *  - 不存在 blocked/pending 条目（每条都必须有成功验证的证据）；
   *  - 不存在未纳入方案的 active 映射；
   *  - 不存在 conflicted 映射；
   *  - 验证证据必须是最近一次（verified_at 晚于映射/输入更新）——这里以
   *    每条 evidence.verdict 为 ok/deleted_gone_ok 为准。
   * 任何一条不满足都拒绝发布并列出受影响链接。
   */
  app.post('/api/plans/:id/publish', async (req, reply) => {
    const planId = Number(req.params.id);
    const blockers = [];

    const { rows: plan } = await pool.query('SELECT * FROM migration_plans WHERE id=$1', [planId]);
    if (!plan.length) return reply.code(404).send({ error: 'not found' });
    if (plan[0].status === 'published') {
      return { alreadyPublished: true, plan: plan[0] };
    }

    const { rows: badItems } = await pool.query(
      `SELECT m.source_raw, pi.item_status, pi.evidence
         FROM migration_plan_items pi
         JOIN url_mappings m ON m.id=pi.mapping_id
        WHERE pi.plan_id=$1 AND pi.item_status <> 'verified'`, [planId]);
    for (const b of badItems) {
      blockers.push({
        source: b.source_raw,
        reason: b.item_status === 'pending'
          ? '只有映射表条目，没有验证证据（填表不等于迁移完成）'
          : `验证未通过：${(b.evidence?.issues ?? []).join('；') || b.evidence?.verdict}`,
      });
    }

    const { rows: missing } = await pool.query(
      `SELECT m.source_raw FROM url_mappings m
        WHERE m.status='active'
          AND NOT EXISTS (SELECT 1 FROM migration_plan_items pi
                           WHERE pi.mapping_id=m.id AND pi.plan_id=$1)`,
      [planId]);
    missing.forEach((m) => blockers.push({ source: m.source_raw, reason: '生效映射未纳入方案' }));

    const { rows: conflicts } = await pool.query('SELECT source_raw FROM url_mappings WHERE status=$1', ['conflicted']);
    conflicts.forEach((m) => blockers.push({ source: m.source_raw, reason: '归一化歧义未裁决' }));

    if (blockers.length) {
      return reply.code(409).send({ published: false, blockers });
    }

    const { rows } = await pool.query(
      `UPDATE migration_plans SET status='published', published_at=now()
        WHERE id=$1 RETURNING *`, [planId]);
    return { published: true, plan: rows[0] };
  });

  // ---- 观察包与覆盖审阅 -----------------------------------------------
  // 纪律：本组接口只解析/读库，绝不发起 HTTP 请求；
  // 外网与格式错误记录只标记隔离原因，验证器不会接触它们。

  // 导入观察包（幂等：批次摘要 + 事件标识）
  app.post('/api/observations/import', async (req) => {
    const { batch_key, note, records } = req.body ?? {};
    return importBatch({ batchKey: batch_key, note, records });
  });

  app.get('/api/observations/batches', async () => {
    const { rows } = await pool.query(
      `SELECT b.*, v.version_no AS mapping_version_no
         FROM observation_batches b
         LEFT JOIN mapping_versions v ON v.id = b.mapping_version_id
        ORDER BY b.id DESC`);
    return rows;
  });

  // 原始事件（证据可追溯）：?quarantined=true 只看隔离；?from=&to= 按观察时间段
  app.get('/api/observations/events', async (req) => {
    const params = [];
    let where = 'WHERE true';
    if (req.query.quarantined === 'true') where += ` AND e.origin_class <> 'local'`;
    if (req.query.quarantined === 'false') where += ` AND e.origin_class = 'local'`;
    if (req.query.from) { params.push(new Date(req.query.from)); where += ` AND e.observed_start >= $${params.length}`; }
    if (req.query.to) { params.push(new Date(req.query.to)); where += ` AND e.observed_start <= $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT e.*, b.batch_key
         FROM observation_events e
         JOIN observation_batches b ON b.id = e.batch_id
         ${where} ORDER BY e.observed_start NULLS LAST, e.id`, params);
    return rows;
  });

  // 当前覆盖（实时计算：当前映射版本 + 最新验证裁决）
  app.get('/api/coverage/current', async (req) => {
    const { from, to } = req.query ?? {};
    return computeCurrentCoverage(pool, { from, to });
  });

  // 导出覆盖报告（不可变快照，绑定当前映射版本；差异随报告固化）
  app.post('/api/coverage/reports', async (req) => {
    const { from, to, note } = req.body ?? {};
    return exportReport({ from, to, note });
  });

  app.get('/api/coverage/reports', async () => {
    const { rows } = await pool.query(
      `SELECT r.id, r.range_start, r.range_end, r.summary, r.note, r.created_at,
              v.version_no, v.rules_fingerprint
         FROM coverage_reports r
         JOIN mapping_versions v ON v.id = r.mapping_version_id
        ORDER BY r.id DESC`);
    return rows;
  });

  app.get('/api/coverage/reports/:id', async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT r.*, v.version_no, v.rules_fingerprint, v.snapshot
         FROM coverage_reports r
         JOIN mapping_versions v ON v.id = r.mapping_version_id
        WHERE r.id=$1`, [req.params.id]);
    if (!rows.length) return reply.code(404).send({ error: 'report not found' });
    const items = await reportItems(pool, req.params.id);
    return { report: rows[0], items, coverageLabel: COVERAGE_LABEL };
  });

  // 旧报告 vs 当前版本的实时差异（不改写任何数据）
  app.get('/api/coverage/reports/:id/diff', async (req, reply) => {
    const d = await diffReportWithCurrent(Number(req.params.id));
    if (!d) return reply.code(404).send({ error: 'report not found' });
    return d;
  });

  app.get('/api/mapping-versions', async () => {
    const { rows } = await pool.query(
      `SELECT id, version_no, rules_fingerprint, snapshot_hash, note, created_at,
              jsonb_array_length(snapshot) AS mappings
         FROM mapping_versions ORDER BY version_no DESC`);
    return rows;
  });
}

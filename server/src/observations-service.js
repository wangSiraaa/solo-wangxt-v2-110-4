/**
 * 观察包导入：幂等、隔离、可追溯。
 *
 * 幂等三级防线：
 *  1. 批次级：同一 (batch_key, digest) 重传 → 直接返回已有批次，不重复计数；
 *     同 batch_key 但摘要不同 → 409 拒绝（防止同名包内容被悄悄替换）；
 *  2. 事件级：event_id 全局唯一。跨批次重传同一事件（内容一致）→ 记 duplicate
 *     跳过；内容不一致 → 记 conflict，保留首次记录（证据不可改写）；
 *  3. 无合法 event_id 的坏记录：以内容指纹合成 auto: 标识，重传同样幂等。
 *
 * 本模块只解析与写库，绝不发起 HTTP 请求 —— 外网记录只标记、不验证。
 */
import { pool } from './db.js';
import {
  batchDigest, recordFingerprint, classifyRecord,
} from './observations-core.js';
import { ensureMappingVersion } from './mapping-versions.js';

/**
 * @param {{batchKey: string, note?: string, records: Array}} input
 * @returns {Promise<{idempotent: boolean, batch: object, accepted: number,
 *   duplicates: number, quarantined: number, conflicts: Array, quarantines: Array}>}
 */
export async function importBatch({ batchKey, note = null, records }) {
  if (typeof batchKey !== 'string' || batchKey.trim() === '') {
    const err = new Error('batch_key required（稳定批次标识）');
    err.statusCode = 400;
    throw err;
  }
  if (!Array.isArray(records) || records.length === 0) {
    const err = new Error('records[] required（至少一条观察记录）');
    err.statusCode = 400;
    throw err;
  }
  const key = batchKey.trim();
  const digest = batchDigest(records);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 批次级幂等
    const { rows: existing } = await client.query(
      'SELECT * FROM observation_batches WHERE batch_key=$1', [key]);
    if (existing.length) {
      if (existing[0].digest === digest) {
        await client.query('COMMIT');
        const b = existing[0];
        return {
          idempotent: true, batch: b,
          accepted: b.accepted_count, duplicates: b.duplicate_count,
          quarantined: b.quarantined_count, conflicts: [], quarantines: [],
        };
      }
      await client.query('ROLLBACK');
      const err = new Error(
        `批次 ${key} 已存在但摘要不一致（已存 ${existing[0].digest.slice(0, 12)}…，` +
        `本次 ${digest.slice(0, 12)}…）。同名不同内容的包被拒绝，请换用新批次标识。`);
      err.statusCode = 409;
      throw err;
    }

    // 导入时的当前映射版本（事件与批次都绑定，供审计）
    const { version } = await ensureMappingVersion(client, { note: '观察包导入时记录当前版本' });

    // 先建批次行（计数稍后回填），事件直接归属
    const { rows: batchRows } = await client.query(
      `INSERT INTO observation_batches
         (batch_key, digest, record_count, accepted_count, duplicate_count,
          quarantined_count, conflict_count, mapping_version_id, note)
       VALUES ($1,$2,$3,0,0,0,0,$4,$5) RETURNING *`,
      [key, digest, records.length, version.id, note]);
    const batchId = batchRows[0].id;

    let accepted = 0;
    let duplicates = 0;
    let quarantined = 0;
    const conflicts = [];
    const quarantines = [];

    for (const rec of records) {
      const c = classifyRecord(rec);
      const fp = recordFingerprint(rec);
      const eventId = c.eventId ?? `auto:${fp.slice(0, 24)}`;

      // 事件级幂等
      const { rows: dup } = await client.query(
        'SELECT record_fingerprint FROM observation_events WHERE event_id=$1', [eventId]);
      if (dup.length) {
        if (dup[0].record_fingerprint === fp) {
          duplicates += 1;
        } else {
          conflicts.push({
            event_id: eventId,
            reason: '事件标识已存在但内容不一致，保留首次记录（证据不可改写），本条未入库',
          });
        }
        continue;
      }

      await client.query(
        `INSERT INTO observation_events
           (event_id, batch_id, record_fingerprint, raw_url, norm_key, rules_fingerprint,
            origin_class, quarantine_reason, tracker_params,
            observed_start, observed_end, hits, content_digest, mapping_version_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          eventId, batchId, fp, c.rawUrl, c.normKey, c.rulesFp,
          c.originClass, c.quarantineReason, JSON.stringify(c.trackerParams),
          c.observedStart, c.observedEnd, c.hits, c.contentDigest, version.id,
        ]);
      if (c.originClass === 'local') {
        accepted += 1;
      } else {
        quarantined += 1;
        quarantines.push({ event_id: eventId, origin_class: c.originClass, reason: c.quarantineReason });
      }
    }

    const { rows: finalBatch } = await client.query(
      `UPDATE observation_batches
          SET accepted_count=$2, duplicate_count=$3, quarantined_count=$4, conflict_count=$5
        WHERE id=$1 RETURNING *`,
      [batchId, accepted, duplicates, quarantined, conflicts.length]);

    await client.query('COMMIT');
    return {
      idempotent: false, batch: finalBatch[0],
      accepted, duplicates, quarantined, conflicts, quarantines,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

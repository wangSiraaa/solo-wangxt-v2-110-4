/**
 * 映射/规则版本：覆盖报告必须绑定导出时的版本。
 *
 * 懒式版本化：每次需要“当前版本”时，计算（规范化规则指纹, 生效映射集摘要），
 * 已存在则复用、不存在则建档。映射或规则升级后，历史报告仍引用旧版本行，
 * 版本快照里保存当时的规则原文与映射集，供复盘与差异比较。
 */
import { config } from './config.js';
import { pool } from './db.js';
import { sha256hex, stableStringify } from './fingerprint.js';

export function rulesFingerprint(rules = config.rules) {
  return `sha256:${sha256hex(stableStringify(rules))}`;
}

export function mappingDigest(mappings) {
  const rows = mappings
    .map((m) => [m.source_norm, m.target_norm, m.mapping_type, m.status])
    .sort();
  return `sha256:${sha256hex(stableStringify(rows))}`;
}

/**
 * 取当前（规则, 映射集）对应的版本行；没有则创建。
 * @param {import('pg').Pool|import('pg').PoolClient} [client]
 * @returns {Promise<{version: object, created: boolean}>}
 */
export async function ensureCurrentVersion(client = pool) {
  const { rows: mappings } = await client.query(
    `SELECT source_raw, source_norm, target_raw, target_norm, mapping_type, status
       FROM url_mappings ORDER BY source_norm`);
  const rf = rulesFingerprint();
  const md = mappingDigest(mappings);
  const { rows: found } = await client.query(
    'SELECT * FROM mapping_versions WHERE rules_fingerprint=$1 AND mapping_digest=$2',
    [rf, md]);
  if (found.length) return { version: found[0], created: false };

  const { rows } = await client.query(
    `INSERT INTO mapping_versions (rules_fingerprint, mapping_digest, rules_snapshot, mapping_snapshot)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (rules_fingerprint, mapping_digest) DO NOTHING
     RETURNING *`,
    [rf, md, JSON.stringify(config.rules), JSON.stringify(mappings)]);
  if (rows.length) return { version: rows[0], created: true };

  // 并发建档：另一个连接已插入同一版本
  const again = await client.query(
    'SELECT * FROM mapping_versions WHERE rules_fingerprint=$1 AND mapping_digest=$2',
    [rf, md]);
  return { version: again.rows[0], created: false };
}

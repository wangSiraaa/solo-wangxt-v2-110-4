/**
 * 映射版本：映射集或规范化规则每次变化都产生一个不可变版本。
 * 历史覆盖报告绑定 version 行（含全量快照），旧版本永远可复盘；
 * 当前版本继续演进，差异另行计算。
 *
 * 版本识别 = 规则指纹 + 生效映射全量内容的摘要；内容没变就不产生新版本
 * （重复重算/重复 seed 同内容不会刷出版本号）。
 */
import { rulesFingerprint, snapshotContentHash } from './fingerprint.js';

async function currentSnapshot(client) {
  const { rows } = await client.query(
    `SELECT source_norm, source_raw, target_norm, target_raw, mapping_type, status
       FROM url_mappings ORDER BY source_norm`);
  return rows;
}

/**
 * 确保当前映射集有对应版本；内容变化时插入新版本。
 * @param {object} client 数据库连接（事务内调用传同一 client）
 * @param {{note?: string, rulesFingerprintOverride?: string}} [opts]
 *        rulesFingerprintOverride 仅用于测试/演练“规则升级”场景。
 */
export async function ensureMappingVersion(client, { note = null, rulesFingerprintOverride = null } = {}) {
  const rf = rulesFingerprintOverride ?? rulesFingerprint();
  const snapshot = await currentSnapshot(client);
  const hash = snapshotContentHash(rf, snapshot);
  const { rows: latest } = await client.query(
    'SELECT * FROM mapping_versions ORDER BY version_no DESC LIMIT 1');
  if (latest.length && latest[0].snapshot_hash === hash) {
    return { version: latest[0], created: false };
  }
  const versionNo = latest.length ? latest[0].version_no + 1 : 1;
  const { rows } = await client.query(
    `INSERT INTO mapping_versions (version_no, rules_fingerprint, snapshot_hash, snapshot, note)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [versionNo, rf, hash, JSON.stringify(snapshot), note]);
  return { version: rows[0], created: true };
}

export async function latestMappingVersion(client) {
  const { rows } = await client.query(
    'SELECT * FROM mapping_versions ORDER BY version_no DESC LIMIT 1');
  return rows[0] ?? null;
}

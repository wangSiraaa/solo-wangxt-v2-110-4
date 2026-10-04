/**
 * 观察包导入 CLI：
 *   node scripts/import-observations.js --sample         导入内置演示包
 *   node scripts/import-observations.js --sample-late    导入迟到补传包
 *   node scripts/import-observations.js path/to/pkg.json 导入指定观察包文件
 * 幂等：同一批次重传是 no-op；同一事件不会重复计数。
 */
import { readFile } from 'node:fs/promises';
import { ensureDatabase, pool } from '../server/src/db.js';
import { importPackage } from '../server/src/observation-service.js';
import { buildSamplePackage, buildLatePackage } from '../server/src/observation-sample.js';

const arg = process.argv[2] ?? '--sample';

try {
  await ensureDatabase();
  let pkg;
  if (arg === '--sample') pkg = buildSamplePackage();
  else if (arg === '--sample-late') pkg = buildLatePackage();
  else pkg = JSON.parse(await readFile(arg, 'utf8'));

  const r = await importPackage(pkg);
  console.log(JSON.stringify(r, null, 2));
  if (r.duplicated) console.log('→ 批次重传：幂等跳过，访问次数不变');
  else console.log(`→ 导入 ${r.inserted} 条（跳过重复 ${r.skipped}，隔离 ${r.quarantined}），绑定映射版本 v${r.mapping_version_id}`);
} catch (e) {
  console.error(`导入失败: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

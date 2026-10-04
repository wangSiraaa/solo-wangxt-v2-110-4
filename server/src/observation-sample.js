/**
 * 演示观察包：覆盖验收需要的全部场景 ——
 * 正常旧址、410 栏目、同键不同 utm 值、无映射旧址、外网地址、格式错误记录；
 * 另有“迟到补传包”：含与首批重复的事件（幂等）和窗口仍在早些时候的迟到记录。
 */
import { fixtureOrigin } from './config.js';

export function buildSamplePackage() {
  const O = fixtureOrigin();
  return {
    batch_key: 'ops-2026-W39-site-a',
    source_label: '运营脱敏导出 · 2026 第 39 周',
    records: [
      // 正常旧址：同一资源、不同 utm 值 —— 归一键相同，追踪参数值分别留证
      { event_id: 'evt-2026w39-0001', url: `${O}/news/123?utm_source=weibo`,
        window_start: '2026-09-24T10:00:00Z', window_end: '2026-09-24T11:00:00Z', hits: 12 },
      { event_id: 'evt-2026w39-0002', url: `${O}/news/123?utm_source=partner&utm_campaign=autumn`,
        window_start: '2026-09-24T11:00:00Z', window_end: '2026-09-24T12:00:00Z', hits: 5 },
      // 编码中文路径（百分号编码必须原样留证）
      { event_id: 'evt-2026w39-0003', url: `${O}/%E9%A2%91%E9%81%93/%E7%A7%91%E6%8A%80/42.html?utm_medium=app`,
        window_start: '2026-09-25T08:00:00Z', window_end: '2026-09-25T09:00:00Z', hits: 7 },
      // 410 栏目（已删除，期望 deleted_gone_ok）
      { event_id: 'evt-2026w39-0004', url: `${O}/forum/announce/9`,
        window_start: '2026-09-25T09:00:00Z', window_end: '2026-09-25T10:00:00Z', hits: 3 },
      // 尾斜杠是身份
      { event_id: 'evt-2026w39-0005', url: `${O}/column/weekly/`,
        window_start: '2026-09-26T10:00:00Z', window_end: '2026-09-26T11:00:00Z', hits: 4 },
      // %2F 编码斜杠
      { event_id: 'evt-2026w39-0006', url: `${O}/old-files%2Fdraft?utm_source=app`,
        window_start: '2026-09-26T12:00:00Z', window_end: '2026-09-26T13:00:00Z', hits: 2 },
      // 无映射旧址：运营观察到但迁移未覆盖（fixture 已配好跳转，补映射即可覆盖）
      { event_id: 'evt-2026w39-0007', url: `${O}/legacy/unknown-page?utm_source=edm`,
        window_start: '2026-09-27T10:00:00Z', window_end: '2026-09-27T11:00:00Z', hits: 9 },
      // 外网地址：隔离，标记不可验证，绝不请求
      { event_id: 'evt-2026w39-0008', url: 'http://example.com/promo?utm_source=edm',
        window_start: '2026-09-27T12:00:00Z', window_end: '2026-09-27T13:00:00Z', hits: 6 },
      // 格式错误：隔离并说明原因
      { event_id: 'evt-2026w39-0009', url: 'not-a-valid-url',
        window_start: '2026-09-27T13:00:00Z', window_end: '2026-09-27T14:00:00Z', hits: 1 },
    ],
  };
}

export function buildLatePackage() {
  const O = fixtureOrigin();
  return {
    batch_key: 'ops-2026-W39-site-a-late',
    source_label: '运营脱敏导出 · 迟到补传',
    records: [
      // 与首批完全重复的事件：按 event_id 幂等跳过，次数不翻倍
      { event_id: 'evt-2026w39-0001', url: `${O}/news/123?utm_source=weibo`,
        window_start: '2026-09-24T10:00:00Z', window_end: '2026-09-24T11:00:00Z', hits: 12 },
      // 迟到记录：窗口仍在 09-24，必须归入 09-24 时间段，而不是导入当天
      { event_id: 'evt-2026w39-0010', url: `${O}/news/123?utm_source=weibo`,
        window_start: '2026-09-24T10:00:00Z', window_end: '2026-09-24T11:00:00Z', hits: 4 },
      // 新窗口的追加观察
      { event_id: 'evt-2026w39-0011', url: `${O}/legacy/unknown-page?utm_source=edm`,
        window_start: '2026-10-01T10:00:00Z', window_end: '2026-10-01T11:00:00Z', hits: 6 },
      // 全新的未覆盖旧址：版本差异中体现为“新增未覆盖”
      { event_id: 'evt-2026w39-0012', url: `${O}/legacy/another-gap?utm_source=edm`,
        window_start: '2026-10-01T11:00:00Z', window_end: '2026-10-01T12:00:00Z', hits: 2 },
    ],
  };
}

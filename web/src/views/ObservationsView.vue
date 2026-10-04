<template>
  <div class="panel">
    <h2>导入观察包（本地脱敏记录，幂等接入）</h2>
    <p class="muted small">
      每条记录需含稳定事件标识 <code>event_id</code>、原始 <code>url</code>、观察时间范围、
      次数 <code>hits</code>、内容摘要。原始 URL 原样留证（路径、%XX 编码、追踪参数值）。
      同一批次或同一事件重传<b>不会重复计数</b>；外网与格式错误记录只标记隔离原因，
      <b>验证器绝不会对它们发起请求</b>。
    </p>
    <textarea v-model="importText" rows="7" placeholder='{"batch_key":"ops-2026-w40","records":[{"event_id":"...","url":"...","observed_start":"...","observed_end":"...","hits":12,"content_digest":"..."}]}'></textarea>
    <div style="margin:8px 0; display:flex; gap:8px">
      <button class="btn" :disabled="importing" @click="doImport">{{ importing ? '导入中…' : '导入' }}</button>
      <button class="btn secondary" @click="fillExample">填入示例</button>
    </div>
    <div v-if="importError" class="callout bad small">{{ importError }}</div>
    <div v-if="importResult" class="callout ok small">
      <b>{{ importResult.idempotent ? '幂等命中：该批次已导入过，未重复计数。' : '导入完成。' }}</b>
      接受 {{ importResult.accepted }} 条 · 重复 {{ importResult.duplicates }} 条 ·
      隔离 {{ importResult.quarantined }} 条
      <ul v-if="importResult.quarantines?.length" class="issues">
        <li v-for="(q, i) in importResult.quarantines" :key="i">
          [{{ q.origin_class }}] {{ q.event_id }}：{{ q.reason }}
        </li>
      </ul>
      <ul v-if="importResult.conflicts?.length" class="issues">
        <li v-for="(c, i) in importResult.conflicts" :key="i">冲突 {{ c.event_id }}：{{ c.reason }}</li>
      </ul>
    </div>
  </div>

  <div class="panel">
    <h2>当前覆盖 —— 按当前映射版本与验证裁决</h2>
    <div class="row" style="align-items:flex-end">
      <label class="field"><span>时间段从（observed_start ≥）</span><input v-model="range.from" placeholder="2026-09-21T00:00:00Z" /></label>
      <label class="field"><span>到（observed_start ≤）</span><input v-model="range.to" placeholder="2026-09-28T00:00:00Z" /></label>
      <div style="flex:1; display:flex; gap:8px">
        <button class="btn secondary" @click="loadCoverage">查询</button>
        <button class="btn" :disabled="!coverage" @click="doExport">导出为报告快照</button>
      </div>
    </div>
    <div v-if="coverage" class="kpi" style="margin-top:4px">
      <div class="card"><div class="num" style="color:var(--ok)">{{ countOf('covered') + countOf('gone_ok') }}</div><div class="lbl">已覆盖（含消亡正确）</div></div>
      <div class="card"><div class="num" style="color:var(--bad)">{{ countOf('uncovered') }}</div><div class="lbl">未覆盖（无映射）</div></div>
      <div class="card"><div class="num" style="color:var(--warn)">{{ attentionCount }}</div><div class="lbl">需注意（未验证/失败/歧义）</div></div>
      <div class="card"><div class="num">{{ countOf('unverifiable') }}</div><div class="lbl">不可验证（已隔离）</div></div>
      <div class="card" v-if="countOf('incomparable')"><div class="num">{{ countOf('incomparable') }}</div><div class="lbl">规则差异无法比较</div></div>
    </div>
    <p v-if="coverage?.version" class="muted small" style="margin-top:6px">
      当前映射版本 v{{ coverage.version.version_no }} · 规则指纹 {{ coverage.version.rules_fingerprint }} ·
      共 {{ coverage.summary.total_events }} 条记录 / {{ coverage.summary.total_hits }} 次访问
    </p>
    <table v-if="coverage">
      <thead>
        <tr><th>覆盖结论</th><th>事件</th><th>原始 URL（含追踪参数值）</th><th>观察时间段</th><th>次数</th><th>裁决 / 原因</th></tr>
      </thead>
      <tbody>
        <tr v-for="it in coverage.items" :key="it.event_id">
          <td><span class="badge" :class="coverageClass(it.coverage)">{{ coverageLabel[it.coverage] || it.coverage }}</span></td>
          <td class="mono small">{{ it.event_id }}</td>
          <td class="mono">{{ it.raw_url }}</td>
          <td class="small">{{ fmtRange(it) }}</td>
          <td>{{ it.hits }}</td>
          <td class="small">
            <span v-if="it.verdict" class="badge neutral">{{ it.verdict }}</span>
            <span v-if="it.reason" class="muted"> {{ it.reason }}</span>
            <div v-if="it.mapping" class="muted">→ {{ it.mapping.target_raw }}（{{ it.mapping.mapping_type }}）</div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="panel">
    <h2>覆盖报告（导出即快照，绑定映射版本，迟到记录不改写）</h2>
    <table>
      <thead><tr><th>ID</th><th>映射版本</th><th>时间段</th><th>记录/访问</th><th>未覆盖</th><th>导出时间</th><th>备注</th><th></th></tr></thead>
      <tbody>
        <tr v-for="r in reports" :key="r.id">
          <td>#{{ r.id }}</td>
          <td>v{{ r.version_no }}</td>
          <td class="small">{{ r.range_start ? fmt(r.range_start) + ' ~ ' + fmt(r.range_end) : '全部' }}</td>
          <td>{{ r.summary.total_events }} / {{ r.summary.total_hits }}</td>
          <td :style="(r.summary.by_coverage?.uncovered?.events ?? 0) ? 'color:var(--bad)' : ''">
            {{ r.summary.by_coverage?.uncovered?.events ?? 0 }}
          </td>
          <td class="small">{{ fmt(r.created_at) }}</td>
          <td class="small muted">{{ r.note }}</td>
          <td style="white-space:nowrap">
            <a href="#" @click.prevent="openReport(r.id)">明细</a> ·
            <a href="#" @click.prevent="openDiff(r.id)">与当前版本比较</a>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="reportDetail" style="margin-top:12px">
      <h3>报告 #{{ reportDetail.report.id }} 明细（绑定映射版本 v{{ reportDetail.report.version_no }}，规则指纹 {{ reportDetail.report.rules_fingerprint }}）</h3>
      <div v-if="reportDetail.report.summary?.diff" class="callout small">
        <b>与上一报告的差异（导出时固化）：</b>
        新增已覆盖 {{ reportDetail.report.summary.diff.newly_covered.length }} 项 ·
        新增未覆盖 {{ reportDetail.report.summary.diff.newly_uncovered.length }} 项 ·
        规则差异无法比较 {{ reportDetail.report.summary.diff.incomparable.length }} 项
      </div>
      <table>
        <thead><tr><th>覆盖结论</th><th>事件</th><th>原始 URL</th><th>次数</th><th>裁决</th></tr></thead>
        <tbody>
          <tr v-for="it in reportDetail.items" :key="it.event_id">
            <td><span class="badge" :class="coverageClass(it.coverage)">{{ coverageLabel[it.coverage] || it.coverage }}</span></td>
            <td class="mono small">{{ it.event_id }}</td>
            <td class="mono">{{ it.raw_url }}</td>
            <td>{{ it.hits }}</td>
            <td class="small">{{ it.verdict || it.detail?.reason || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="reportDiff" style="margin-top:12px">
      <h3>报告 #{{ reportDiff.report.id }}（版本 v{{ reportDiff.report.version_no }}） vs 当前版本 v{{ reportDiff.current_version?.version_no }}</h3>
      <div class="row">
        <div class="callout bad small" style="flex:1">
          <b>新增未覆盖（{{ reportDiff.diff.newly_uncovered.length }}）</b>
          <ul><li v-for="i in reportDiff.diff.newly_uncovered" :key="i.event_id" class="mono">{{ i.raw_url }}（{{ i.hits }} 次）</li></ul>
        </div>
        <div class="callout ok small" style="flex:1">
          <b>已覆盖（{{ reportDiff.diff.newly_covered.length }}）</b>
          <ul><li v-for="i in reportDiff.diff.newly_covered" :key="i.event_id" class="mono">{{ i.raw_url }}（{{ i.hits }} 次）</li></ul>
        </div>
        <div class="callout small" style="flex:1">
          <b>规则差异无法比较（{{ reportDiff.diff.incomparable.length }}）</b>
          <ul><li v-for="i in reportDiff.diff.incomparable" :key="i.event_id" class="mono">{{ i.raw_url }}</li></ul>
        </div>
      </div>
    </div>
  </div>

  <div class="panel">
    <h2>观察批次与原始记录（证据可追溯）</h2>
    <table>
      <thead><tr><th>批次</th><th>记录</th><th>接受</th><th>重复</th><th>隔离</th><th>冲突</th><th>导入时映射版本</th><th>接收时间</th></tr></thead>
      <tbody>
        <tr v-for="b in batches" :key="b.id">
          <td class="mono small">{{ b.batch_key }}</td>
          <td>{{ b.record_count }}</td><td>{{ b.accepted_count }}</td>
          <td>{{ b.duplicate_count }}</td>
          <td :style="Number(b.quarantined_count) ? 'color:var(--warn)' : ''">{{ b.quarantined_count }}</td>
          <td :style="Number(b.conflict_count) ? 'color:var(--bad)' : ''">{{ b.conflict_count }}</td>
          <td>v{{ b.mapping_version_no ?? '—' }}</td>
          <td class="small">{{ fmt(b.received_at) }}</td>
        </tr>
      </tbody>
    </table>
    <div style="margin:10px 0">
      <button class="btn secondary" @click="showQuarantined = !showQuarantined; loadEvents()">
        {{ showQuarantined ? '查看全部记录' : '只看隔离记录' }}
      </button>
    </div>
    <table>
      <thead><tr><th>状态</th><th>事件</th><th>原始 URL</th><th>追踪参数值</th><th>时间段</th><th>次数</th><th>批次</th><th>隔离原因</th></tr></thead>
      <tbody>
        <tr v-for="e in events" :key="e.event_id">
          <td>
            <span v-if="e.origin_class === 'local'" class="badge ok">本地</span>
            <span v-else class="badge warn">{{ e.origin_class === 'external' ? '外网·隔离' : '格式错误·隔离' }}</span>
          </td>
          <td class="mono small">{{ e.event_id }}</td>
          <td class="mono">{{ e.raw_url }}</td>
          <td class="mono small">{{ trackerText(e.tracker_params) }}</td>
          <td class="small">{{ fmtRange(e) }}</td>
          <td>{{ e.hits }}</td>
          <td class="mono small">{{ e.batch_key }}</td>
          <td class="small muted">{{ e.quarantine_reason || '—' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';

const importText = ref('');
const importing = ref(false);
const importResult = ref(null);
const importError = ref('');
const coverage = ref(null);
const coverageLabel = ref({});
const reports = ref([]);
const reportDetail = ref(null);
const reportDiff = ref(null);
const batches = ref([]);
const events = ref([]);
const showQuarantined = ref(false);
const range = ref({ from: '', to: '' });

const COVERAGE_CLASS = {
  covered: 'ok', gone_ok: 'ok',
  uncovered: 'bad', covered_failing: 'bad', gone_failing: 'bad',
  covered_unverified: 'warn', gone_unverified: 'warn', conflicted: 'warn',
  unverifiable: 'neutral', incomparable: 'neutral',
};
function coverageClass(c) { return COVERAGE_CLASS[c] ?? 'neutral'; }
function countOf(name) { return coverage.value?.summary?.by_coverage?.[name]?.events ?? 0; }
const attentionCount = computed(() =>
  countOf('covered_unverified') + countOf('covered_failing') +
  countOf('gone_unverified') + countOf('gone_failing') + countOf('conflicted'));

async function loadCoverage() {
  const params = {};
  if (range.value.from) params.from = range.value.from;
  if (range.value.to) params.to = range.value.to;
  coverage.value = await api.coverageCurrent(params);
  coverageLabel.value = coverage.value.label ?? {};
}
async function loadReports() { reports.value = await api.coverageReports(); }
async function loadBatches() { batches.value = await api.observationBatches(); }
async function loadEvents() {
  events.value = await api.observationEvents(showQuarantined.value ? { quarantined: 'true' } : {});
}
async function loadAll() {
  await Promise.all([loadCoverage(), loadReports(), loadBatches(), loadEvents()]);
}

async function doImport() {
  importing.value = true;
  importResult.value = null;
  importError.value = '';
  try {
    const payload = JSON.parse(importText.value);
    importResult.value = await api.importObservations(payload);
    await loadAll();
  } catch (e) {
    importError.value = e.message;
  } finally {
    importing.value = false;
  }
}
async function doExport() {
  const payload = {};
  if (range.value.from) payload.from = range.value.from;
  if (range.value.to) payload.to = range.value.to;
  await api.exportCoverageReport(payload);
  await loadReports();
}
async function openReport(id) {
  reportDiff.value = null;
  reportDetail.value = await api.coverageReport(id);
  coverageLabel.value = reportDetail.value.coverageLabel ?? coverageLabel.value;
}
async function openDiff(id) {
  reportDetail.value = null;
  reportDiff.value = await api.coverageReportDiff(id);
}
function fillExample() {
  importText.value = JSON.stringify({
    batch_key: 'ops-2026-w40',
    note: '第 40 周观察包',
    records: [
      { event_id: 'w40-001', url: 'http://127.0.0.1:4568/news/123?utm_source=weibo', observed_start: '2026-09-28T08:00:00Z', observed_end: '2026-09-28T09:00:00Z', hits: 64, content_digest: 'sha256:w40-001' },
      { event_id: 'w40-002', url: 'http://127.0.0.1:4568/forum/announce/9', observed_start: '2026-09-28T09:00:00Z', observed_end: '2026-09-28T10:00:00Z', hits: 5, content_digest: 'sha256:w40-002' },
      { event_id: 'w40-003', url: 'http://example.com/should-not-fetch', observed_start: '2026-09-28T10:00:00Z', observed_end: '2026-09-28T11:00:00Z', hits: 9, content_digest: 'sha256:w40-003' },
    ],
  }, null, 2);
}
function fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-CN') : '—'; }
function fmtRange(e) {
  if (!e.observed_start) return '—';
  return `${fmt(e.observed_start)} ~ ${fmt(e.observed_end)}`;
}
function trackerText(tp) {
  const entries = Object.entries(tp ?? {});
  if (!entries.length) return '—';
  return entries.map(([k, v]) => `${k}=${(v ?? []).join(',')}`).join('&');
}
onMounted(loadAll);
</script>

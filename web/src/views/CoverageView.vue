<template>
  <div class="panel">
    <h2>导入观察包（脱敏本地访问记录）</h2>
    <p class="muted small">
      每批记录保存稳定事件标识、原始 URL、时间范围、次数、内容摘要与导入时的映射版本。
      重复/迟到记录按事件标识与批次摘要幂等；外网或格式错误记录只隔离标记为不可验证，
      <b>绝不会对它们发起请求</b>。
    </p>
    <textarea v-model="pkgText" rows="6" placeholder='{"batch_key":"...","records":[{"event_id":"...","url":"...","window_start":"...","window_end":"...","hits":1}]}'></textarea>
    <div class="row" style="margin-top:8px; align-items:center">
      <div style="flex:2">
        <button class="btn" :disabled="importing" @click="doImport">{{ importing ? '导入中…' : '导入' }}</button>
        <button class="btn secondary" style="margin-left:8px" @click="fillSample(false)">填入演示包</button>
        <button class="btn secondary" style="margin-left:8px" @click="fillSample(true)">填入迟到补传包</button>
      </div>
      <div style="flex:3" class="small muted">
        已导入 {{ batches.length }} 批：
        <span v-for="b in batches" :key="b.id" class="badge neutral" style="margin-right:4px">
          {{ b.batch_key }}（{{ b.stored_events }}/{{ b.record_count }} 条<span v-if="Number(b.quarantined)">，隔离 {{ b.quarantined }}</span> · 版本 v{{ b.mapping_version_id }}）
        </span>
      </div>
    </div>
    <div v-if="importResult" class="callout ok small">
      {{ importResult.duplicated ? '批次重传：幂等跳过，访问次数不变。' : '导入完成。' }}
      新增 {{ importResult.inserted }} 条，跳过重复 {{ importResult.skipped }} 条，
      隔离 {{ importResult.quarantined }} 条；绑定映射版本 v{{ importResult.mapping_version_id }}。
    </div>
    <div v-if="importError" class="callout bad small">{{ importError }}</div>
  </div>

  <div v-if="cov && (uncovered.keys > 0 || cov.summary.quarantined > 0)" class="panel">
    <div class="callout bad">
      <b>风险提示：</b>
      运营观察到 <b>{{ uncovered.keys }}</b> 个旧址尚未被当前迁移覆盖（共 {{ uncovered.hits }} 次访问）；
      另有 {{ cov.summary.quarantined }} 条记录被隔离（外网/格式错误，不可验证，未发起任何请求）。
      覆盖结论按当前映射与验证裁决计算（版本 v{{ cov.version.id }}）。
    </div>
  </div>

  <div class="panel" v-if="cov">
    <h2>当前覆盖（实时计算 · 映射版本 v{{ cov.version.id }}）</h2>
    <div class="kpi">
      <div class="card"><div class="num" style="color:var(--ok)">{{ cov.summary.by_status.covered.keys }}</div><div class="lbl">已覆盖（{{ cov.summary.by_status.covered.hits }} 次）</div></div>
      <div class="card"><div class="num" style="color:var(--bad)">{{ cov.summary.by_status.blocked.keys }}</div><div class="lbl">验证阻断（{{ cov.summary.by_status.blocked.hits }} 次）</div></div>
      <div class="card"><div class="num" style="color:var(--warn)">{{ cov.summary.by_status.unverified.keys }}</div><div class="lbl">有映射未验证（{{ cov.summary.by_status.unverified.hits }} 次）</div></div>
      <div class="card"><div class="num" style="color:var(--warn)">{{ cov.summary.by_status.unmapped.keys }}</div><div class="lbl">无映射（{{ cov.summary.by_status.unmapped.hits }} 次）</div></div>
      <div class="card"><div class="num">{{ cov.summary.quarantined }}</div><div class="lbl">隔离记录（不请求）</div></div>
    </div>

    <h3>时间段分布（迟到记录按自身观察窗口归位）</h3>
    <table>
      <thead><tr><th>日期</th><th>访问次数</th><th>事件数</th><th>已覆盖</th><th>阻断</th><th>未验证</th><th>无映射</th></tr></thead>
      <tbody>
        <tr v-for="b in cov.timeline" :key="b.bucket">
          <td class="mono">{{ b.bucket }}</td><td>{{ b.hits }}</td><td>{{ b.events }}</td>
          <td>{{ b.covered_hits }}</td><td>{{ b.blocked_hits }}</td>
          <td>{{ b.unverified_hits }}</td><td>{{ b.unmapped_hits }}</td>
        </tr>
        <tr v-if="!cov.timeline.length"><td colspan="7" class="muted">尚无观察记录</td></tr>
      </tbody>
    </table>

    <h3>逐键覆盖与证据（原始写法不随汇总丢失）</h3>
    <table>
      <thead><tr><th>状态</th><th>归一键</th><th>次数</th><th>时间范围</th><th>映射目标 / 裁决</th><th>原始 URL 证据（含追踪参数值）</th></tr></thead>
      <tbody>
        <tr v-for="i in cov.items" :key="i.norm_key">
          <td><span class="badge" :class="statusClass(i.status)">{{ statusText(i.status) }}</span></td>
          <td class="mono">{{ i.norm_key }}</td>
          <td>{{ i.hits }}</td>
          <td class="small muted">{{ fmtRange(i.first_seen, i.last_seen) }}</td>
          <td class="small">
            <div v-if="i.mapping" class="mono">{{ i.mapping.target_raw }}<span v-if="i.mapping.mapping_type === 'deleted'">（已删除）</span></div>
            <div v-if="i.verdict"><VerdictBadge :verdict="i.verdict" :label="cov.verdictLabel" /></div>
            <ul v-if="i.issues?.length" class="issues"><li v-for="(x, k) in i.issues" :key="k">{{ x }}</li></ul>
          </td>
          <td class="small">
            <details>
              <summary>{{ i.sample_urls.length }} 种原始写法 · {{ i.event_count }} 个事件</summary>
              <ul style="margin:4px 0; padding-left:16px">
                <li v-for="s in i.sample_urls" :key="s.url_raw" class="mono">{{ s.url_raw }}（{{ s.hits }} 次）</li>
              </ul>
              <div v-if="Object.keys(i.tracker_values).length" class="muted">
                追踪参数值：<span v-for="(vals, k) in i.tracker_values" :key="k" class="mono">{{ k }}=[{{ vals.join(', ') }}] </span>
              </div>
            </details>
          </td>
        </tr>
      </tbody>
    </table>

    <template v-if="cov.quarantined.length">
      <h3>隔离记录（不可验证，绝不请求）</h3>
      <table>
        <thead><tr><th>事件</th><th>原始 URL</th><th>批次</th><th>次数</th><th>隔离原因</th></tr></thead>
        <tbody>
          <tr v-for="q in cov.quarantined" :key="q.event_id">
            <td class="mono">{{ q.event_id }}</td>
            <td class="mono">{{ q.url_raw }}</td>
            <td class="mono small">{{ q.batch_key }}</td>
            <td>{{ q.hits ?? '—' }}</td>
            <td class="small" style="color:var(--warn)">{{ q.reason }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>

  <div class="panel">
    <h2>覆盖报告（导出即快照，绑定映射版本，迟到记录不回写）</h2>
    <div class="row" style="align-items:flex-end">
      <label class="field" style="flex:3">
        <span>报告标题</span>
        <input v-model="reportTitle" placeholder="例：2026-W40 覆盖基线" />
      </label>
      <div style="flex:1">
        <button class="btn" @click="doExport">导出当前覆盖报告</button>
      </div>
    </div>
    <table style="margin-top:10px">
      <thead><tr><th>ID</th><th>标题</th><th>绑定版本</th><th>导出时间</th><th>覆盖/阻断/未验证/无映射</th><th></th></tr></thead>
      <tbody>
        <tr v-for="r in reports" :key="r.id">
          <td>{{ r.id }}</td>
          <td>{{ r.title }}</td>
          <td><span class="badge neutral">v{{ r.mapping_version_id }}</span></td>
          <td class="small">{{ fmt(r.created_at) }}</td>
          <td class="small">
            {{ r.summary.by_status.covered.keys }} / {{ r.summary.by_status.blocked.keys }} /
            {{ r.summary.by_status.unverified.keys }} / {{ r.summary.by_status.unmapped.keys }}
          </td>
          <td style="white-space:nowrap">
            <a href="#" @click.prevent="viewReport(r.id)">复盘</a> ·
            <a href="#" @click.prevent="viewDiff(r.id)">对比当前版本</a> ·
            <a :href="`/api/coverage/reports/${r.id}/export?format=csv`">CSV</a>
          </td>
        </tr>
        <tr v-if="!reports.length"><td colspan="6" class="muted">尚无报告</td></tr>
      </tbody>
    </table>
  </div>

  <div class="panel" v-if="reportDetail">
    <h2>报告 #{{ reportDetail.id }}：{{ reportDetail.title }}（绑定版本 v{{ reportDetail.mapping_version_id }} · {{ fmt(reportDetail.created_at) }}）</h2>
    <p class="muted small">历史快照：即使之后映射/规则升级或有迟到记录，本表内容不变。</p>
    <table>
      <thead><tr><th>状态</th><th>归一键</th><th>次数</th><th>裁决</th><th>原始 URL 证据</th></tr></thead>
      <tbody>
        <tr v-for="i in reportDetail.items" :key="i.norm_key">
          <td><span class="badge" :class="statusClass(i.status)">{{ statusText(i.status) }}</span></td>
          <td class="mono">{{ i.norm_key }}</td>
          <td>{{ i.hits }}</td>
          <td class="small">{{ i.verdict || '—' }}</td>
          <td class="mono small">{{ (i.sample_urls || []).map((s) => s.url_raw || s).join('；') }}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="panel" v-if="diff">
    <h2>版本差异：报告 #{{ diff.base_report.id }}（v{{ diff.base_report.mapping_version_id }}） → 当前版本 v{{ diff.current_version.id }}</h2>
    <p class="muted small">
      规则{{ diff.rules_changed ? '已变化（无法比较项单独列出）' : '未变化' }}；
      新增未覆盖 {{ diff.summary.newly_uncovered }} · 仍未覆盖 {{ diff.summary.still_uncovered }} ·
      已覆盖 {{ diff.summary.covered }}（其中新增覆盖 {{ diff.summary.newly_covered }}） ·
      无法比较 {{ diff.summary.incomparable }}。
    </p>
    <h3>新增未覆盖</h3>
    <table>
      <thead><tr><th>归一键</th><th>变化</th><th>旧状态→当前状态</th><th>次数</th></tr></thead>
      <tbody>
        <tr v-for="i in diff.newly_uncovered" :key="i.norm_key">
          <td class="mono">{{ i.norm_key }}</td>
          <td><span class="badge bad">{{ changeText(i.change) }}</span></td>
          <td class="small">{{ i.old_status || '（新观察到）' }} → {{ i.current_status }}</td>
          <td>{{ i.hits }}</td>
        </tr>
        <tr v-if="!diff.newly_uncovered.length"><td colspan="4" class="muted">无</td></tr>
      </tbody>
    </table>
    <h3>已覆盖</h3>
    <table>
      <thead><tr><th>归一键</th><th>变化</th><th>旧状态→当前状态</th><th>次数</th></tr></thead>
      <tbody>
        <tr v-for="i in diff.covered" :key="i.norm_key">
          <td class="mono">{{ i.norm_key }}</td>
          <td><span class="badge ok">{{ changeText(i.change) }}</span></td>
          <td class="small">{{ i.old_status || '（新观察到）' }} → {{ i.current_status }}</td>
          <td>{{ i.hits }}</td>
        </tr>
        <tr v-if="!diff.covered.length"><td colspan="4" class="muted">无</td></tr>
      </tbody>
    </table>
    <h3>因规则差异无法比较</h3>
    <table>
      <thead><tr><th>旧键（报告版本）</th><th>当前键（现行规则）</th><th>原因</th><th>次数</th></tr></thead>
      <tbody>
        <tr v-for="(i, k) in diff.incomparable" :key="k">
          <td class="mono">{{ i.old_norm_key }}</td>
          <td class="mono">{{ i.current_norm_key || '—' }}</td>
          <td class="small">{{ i.reason }}</td>
          <td>{{ i.hits }}</td>
        </tr>
        <tr v-if="!diff.incomparable.length"><td colspan="4" class="muted">无</td></tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import VerdictBadge from '../components/VerdictBadge.vue';

const props = defineProps({ refreshKey: Number });

const pkgText = ref('');
const importing = ref(false);
const importResult = ref(null);
const importError = ref('');
const batches = ref([]);
const cov = ref(null);
const reports = ref([]);
const reportTitle = ref('');
const reportDetail = ref(null);
const diff = ref(null);

const uncovered = computed(() => {
  if (!cov.value) return { keys: 0, hits: 0 };
  const s = cov.value.summary;
  return { keys: s.keys - s.by_status.covered.keys, hits: s.hits - s.by_status.covered.hits };
});

async function load() {
  const [b, c, r] = await Promise.all([api.obsBatches(), api.coverage(), api.coverageReports()]);
  batches.value = b.batches;
  cov.value = c;
  reports.value = r.reports;
}
async function fillSample(late) {
  pkgText.value = JSON.stringify(await api.obsSample(late), null, 2);
}
async function doImport() {
  importing.value = true;
  importResult.value = null; importError.value = '';
  try {
    let pkg;
    try { pkg = JSON.parse(pkgText.value); } catch { throw new Error('JSON 解析失败，请检查观察包格式'); }
    importResult.value = await api.importObservations(pkg);
    await load();
  } catch (e) {
    importError.value = e.message;
  } finally {
    importing.value = false;
  }
}
async function doExport() {
  await api.exportCoverage(reportTitle.value.trim() || null);
  reportTitle.value = '';
  await load();
}
async function viewReport(id) {
  reportDetail.value = await api.coverageReport(id);
  diff.value = null;
}
async function viewDiff(id) {
  diff.value = await api.coverageDiff(id);
  reportDetail.value = null;
}
function statusClass(s) {
  return { covered: 'ok', blocked: 'bad', unverified: 'neutral', unmapped: 'warn' }[s] || 'neutral';
}
function statusText(s) {
  return { covered: '已覆盖', blocked: '阻断', unverified: '未验证', unmapped: '无映射' }[s] || s;
}
function changeText(c) {
  return { newly_covered: '新增覆盖', still_covered: '持续覆盖', new: '新观察到',
    regressed: '覆盖倒退', still_uncovered: '仍未覆盖' }[c] || c;
}
function fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-CN') : '—'; }
function fmtRange(a, b) {
  if (!a && !b) return '—';
  return `${a ? a.slice(0, 10) : '?'} ~ ${b ? b.slice(0, 10) : '?'}`;
}
watch(() => props.refreshKey, load);
onMounted(load);
</script>

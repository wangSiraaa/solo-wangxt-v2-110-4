const j = async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || body.error || `HTTP ${r.status}`);
  return body;
};

export const api = {
  rules: () => fetch('/api/rules').then(j),
  mappings: () => fetch('/api/mappings').then(j),
  addMapping: (payload) =>
    fetch('/api/mappings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(j),
  normalize: (urls) =>
    fetch('/api/normalize', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls }),
    }).then(j),
  verify: (sourceNorm = null) =>
    fetch('/api/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sourceNorm ? { source_norm: sourceNorm } : {}),
    }).then(j),
  crawl: (key) =>
    fetch('/api/crawl/' + encodeURIComponent(key)).then(j),
  plans: () => fetch('/api/plans').then(j),
  plan: (id) => fetch(`/api/plans/${id}`).then(j),
  createPlan: (name) =>
    fetch('/api/plans', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(j),
  buildPlan: (id) =>
    fetch(`/api/plans/${id}/build`, { method: 'POST' }).then(j),
  publishPlan: (id) =>
    fetch(`/api/plans/${id}/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then(j),
  // ---- 观察包与覆盖审阅 ----
  importObservations: (payload) =>
    fetch('/api/observations/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(j),
  observationBatches: () => fetch('/api/observations/batches').then(j),
  observationEvents: (params = {}) =>
    fetch('/api/observations/events?' + new URLSearchParams(params)).then(j),
  coverageCurrent: (params = {}) =>
    fetch('/api/coverage/current?' + new URLSearchParams(params)).then(j),
  exportCoverageReport: (payload) =>
    fetch('/api/coverage/reports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(j),
  coverageReports: () => fetch('/api/coverage/reports').then(j),
  coverageReport: (id) => fetch(`/api/coverage/reports/${id}`).then(j),
  coverageReportDiff: (id) => fetch(`/api/coverage/reports/${id}/diff`).then(j),
  mappingVersions: () => fetch('/api/mapping-versions').then(j),
};

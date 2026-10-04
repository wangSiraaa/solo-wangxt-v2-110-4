const j = async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
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
  // ---- 观察包接入与覆盖审阅 ----
  obsSample: (late = false) =>
    fetch(`/api/observations/sample${late ? '?late=1' : ''}`).then(j),
  importObservations: (pkg) =>
    fetch('/api/observations/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pkg),
    }).then(j),
  obsBatches: () => fetch('/api/observations/batches').then(j),
  obsEvents: (status = null) =>
    fetch(`/api/observations/events${status ? `?status=${status}` : ''}`).then(j),
  coverage: () => fetch('/api/coverage').then(j),
  coverageSummary: () => fetch('/api/coverage/summary').then(j),
  exportCoverage: (title) =>
    fetch('/api/coverage/reports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then(j),
  coverageReports: () => fetch('/api/coverage/reports').then(j),
  coverageReport: (id) => fetch(`/api/coverage/reports/${id}`).then(j),
  coverageDiff: (id) => fetch(`/api/coverage/reports/${id}/diff`).then(j),
  versions: () => fetch('/api/versions').then(j),
};

// The asset workflow as Prometheus metrics (ROADMAP phase 10; RealityEngine_CI#723),
// for RealityEngine_CI's asset-workflow dashboard. Aggregates only: no frame,
// asset, document or person is a label, so /metrics names nobody and needs no
// sign-in. An asset's own path through the workflow is in the event lines
// (Loki), not here.
//
// Gauges are read from the frames at scrape time; the event counters start
// from the event log, so a restart does not reset them.

const FRAME_STATUSES = ['open', 'closed', 'abandoned'];
const CONTINUATION_STATUSES = ['captured', 'parked', 'resumed', 'superseded', 'abandoned', 'closed'];
const HEAD_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'STALE', 'CLOSED', 'ABANDONED'];

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labels = (o) => `{${Object.entries(o).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}`;
const zero = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

export function workflowMetrics({ d, log, nowMs = () => Date.now() }) {
  const events = {};
  for (const e of log.read()) events[e.type] = (events[e.type] || 0) + 1;

  return {
    // Each committed event, as it is appended.
    observe(event) { events[event.type] = (events[event.type] || 0) + 1; },

    text() {
      const frames = Object.values(d().frames || {});
      const byFrame = zero(FRAME_STATUSES);
      const byCont = zero(CONTINUATION_STATUSES);
      const byHead = zero(HEAD_STATUSES);
      // Parked continuations waiting on a person or the engine, by who may
      // resume them and the template they will run.
      const waiting = {};
      const now = nowMs();
      for (const f of frames) {
        byFrame[f.status] = (byFrame[f.status] || 0) + 1;
        for (const c of f.continuations || []) {
          byCont[c.status] = (byCont[c.status] || 0) + 1;
          if (f.status === 'open' && c.status === 'parked') {
            const key = `${c.resumableBy?.role || 'engine'}|${c.next?.templateId || ''}`;
            const age = Math.max(0, (now - Date.parse(c.capturedAt)) / 1000);
            const w = (waiting[key] ||= { n: 0, oldest: 0 });
            w.n += 1;
            w.oldest = Math.max(w.oldest, age);
          }
        }
      }
      for (const h of Object.values(d().heads || {})) byHead[h.status] = (byHead[h.status] || 0) + 1;
      const reviews = {};
      for (const [k, w] of Object.entries(waiting)) {
        const role = k.split('|')[0];
        if (role !== 'engine') reviews[role] = (reviews[role] || 0) + w.n;
      }

      const out = [];
      const metric = (name, type, help, rows) => {
        out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
        for (const [l, v] of rows) out.push(`${name}${l ? labels(l) : ''} ${v}`);
      };
      metric('lifecycle_frames', 'gauge', 'assetID frames by status.',
        Object.entries(byFrame).map(([status, n]) => [{ status }, n]));
      metric('lifecycle_continuations', 'gauge', 'Continuations by status, across every frame.',
        Object.entries(byCont).map(([status, n]) => [{ status }, n]));
      metric('lifecycle_heads', 'gauge', 'Case heads by status.',
        Object.entries(byHead).map(([status, n]) => [{ status }, n]));
      metric('lifecycle_parked', 'gauge', 'Parked continuations of open frames, by who may resume them and the template they run next.',
        Object.entries(waiting).map(([k, w]) => { const [role, template] = k.split('|'); return [{ role, template }, w.n]; }));
      metric('lifecycle_parked_oldest_seconds', 'gauge', 'Age of the oldest parked continuation of an open frame, by resumer role and next template.',
        Object.entries(waiting).map(([k, w]) => { const [role, template] = k.split('|'); return [{ role, template }, w.oldest.toFixed(3)]; }));
      metric('lifecycle_reviews_pending', 'gauge', 'Parked continuations waiting on a person, by role.',
        ['reviewer', 'author'].map((role) => [{ role }, reviews[role] || 0]));
      metric('lifecycle_events_total', 'counter', 'Events committed to the event log, by type (resumes, supersessions, abandons, closes among them).',
        Object.entries(events).sort().map(([type, n]) => [{ type }, n]));
      return `${out.join('\n')}\n`;
    }
  };
}

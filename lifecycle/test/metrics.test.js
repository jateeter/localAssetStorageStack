// The asset workflow's metrics and event lines (ROADMAP phase 10;
// RealityEngine_CI#723).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { eventLog } from '../src/integrity.js';
import { workflowMetrics } from '../src/metrics.js';

const value = (text, name, l = '') => {
  const line = text.split('\n').find((x) => x.startsWith(`${name}${l} `));
  return line === undefined ? undefined : Number(line.split(' ').pop());
};

test('gauges come from the frames, counters from the log, and the counters survive a restart', () => {
  const log = eventLog();
  log.append({ type: 'frame.built', frameId: 'f1' });
  log.append({ type: 'continuation.resumed', frameId: 'f1' });
  const t0 = Date.parse('2026-11-10T12:00:00Z');
  const state = {
    frames: {
      f1: { status: 'open', continuations: [
        { status: 'resumed', resumableBy: { role: 'engine' }, next: { templateId: 'machine-a' }, capturedAt: '2026-11-10T11:00:00Z' },
        { status: 'parked', resumableBy: { role: 'reviewer' }, next: { templateId: 'machine-b' }, capturedAt: '2026-11-10T11:59:00Z' }] },
      f2: { status: 'open', continuations: [
        { status: 'parked', resumableBy: { role: 'reviewer' }, next: { templateId: 'machine-b' }, capturedAt: '2026-11-10T11:50:00Z' }] },
      f3: { status: 'closed', continuations: [
        { status: 'parked', resumableBy: { role: 'reviewer' }, next: { templateId: 'machine-b' }, capturedAt: '2026-11-10T10:00:00Z' }] }
    },
    heads: { h1: { status: 'IN_REVIEW' }, h2: { status: 'IN_REVIEW' }, h3: { status: 'CLOSED' } }
  };
  const m = workflowMetrics({ d: () => state, log, nowMs: () => t0 });
  m.observe({ type: 'continuation.resumed' });
  const text = m.text();
  assert.equal(value(text, 'lifecycle_frames', '{status="open"}'), 2);
  assert.equal(value(text, 'lifecycle_frames', '{status="abandoned"}'), 0, 'every status is present, zero-filled');
  assert.equal(value(text, 'lifecycle_continuations', '{status="parked"}'), 3);
  assert.equal(value(text, 'lifecycle_heads', '{status="IN_REVIEW"}'), 2);
  // A closed frame's parked continuation waits on nobody.
  assert.equal(value(text, 'lifecycle_parked', '{role="reviewer",template="machine-b"}'), 2);
  assert.equal(value(text, 'lifecycle_parked_oldest_seconds', '{role="reviewer",template="machine-b"}'), 600);
  assert.equal(value(text, 'lifecycle_reviews_pending', '{role="reviewer"}'), 2);
  assert.equal(value(text, 'lifecycle_reviews_pending', '{role="author"}'), 0);
  assert.equal(value(text, 'lifecycle_events_total', '{type="continuation.resumed"}'), 2);
  // No frame, asset or person is a label.
  assert.doesNotMatch(text, /f1|h1|https:/);
  // A restart reads the counters back from the log.
  assert.equal(value(workflowMetrics({ d: () => state, log }).text(), 'lifecycle_events_total', '{type="frame.built"}'), 1);
});

test('GET /metrics needs no sign-in, and every committed event reaches eventOut', async () => {
  const lines = [];
  const tokens = { admin: 'adm-token-0123456789-0123456789-01', registrar: 'reg-token-0123456789-0123456789-01', engine: 'eng-token-0123456789-0123456789-01' };
  const server = createApp({ tokens, eventOut: (l) => lines.push(l) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const put = await fetch(`${base}/roles`, { method: 'PUT', headers: { authorization: `Bearer ${tokens.admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ webId: 'https://assets-css.localhost:13443/x/profile/card#me', roles: ['reviewer'] }) });
    assert.equal(put.status, 200);
    assert.deepEqual(lines.map((l) => l.type), ['roles.set']);
    assert.ok(lines[0].hash && lines[0].seq === 1, 'the line as the log holds it');
    const r = await fetch(`${base}/metrics`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    assert.equal(value(await r.text(), 'lifecycle_events_total', '{type="roles.set"}'), 1);
  } finally {
    server.close();
  }
});

// The lifecycle service as a PE Source (ROADMAP phase 6): a frame's lanes are
// the reserved cells 2–7 of the clone running its step, allocated when the
// clone is made and freed when it is recycled, carrying the frame's
// observations to that engine's PE.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { capabilityIssuer, solidOidcVerifier } from '../src/identity.js';
import { eventLog } from '../src/integrity.js';
import { LANES } from '../src/lanes.js';
import { fakeIssuer } from './support/issuer.js';
import { fakePod } from './support/pod.js';

const CSS = 'https://assets-css.localhost:13443/';
const tokens = { registrar: 'reg-token-0123456789-0123456789-01', engine: 'eng-token-0123456789-0123456789-01' };
const issuer = fakeIssuer(CSS);
const alice = issuer.person(`${CSS}alice/profile/card#me`);
const bob = issuer.person(`${CSS}bob/profile/card#me`);
const pod = fakePod();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-'));
const keyFile = path.join(dir, 'key.pem');
const certFile = path.join(dir, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:secp384r1', '-nodes', '-sha384',
  '-days', '1', '-subj', '/CN=lifecycle', '-addext', 'subjectAltName=DNS:lifecycle', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });

// A stand-in engine link: it records every PE call, and declares cells 2–7
// reserved except on machine-busy, where only 0–1 are.
const calls = [];
let failPush = false;
const link = {
  configured: true,
  carries: async () => 'carries',
  reservedCells: async (_e, t) => (t === 'machine-busy' ? [] : [2, 3, 4, 5, 6, 7]),
  declare: async (engineId, source) => { calls.push(['declare', engineId, source]); return { source }; },
  push: async (engineId, sensorId, values) => { if (failPush) throw new Error('PE unreachable'); calls.push(['push', engineId, sensorId, values]); },
  remove: async (engineId, sourceId) => { calls.push(['remove', engineId, sourceId]); }
};
let server, base, n = 0;
const lastPush = (sensorId) => calls.filter((c) => c[0] === 'push' && c[2] === sensorId).at(-1)?.[3];

test.before(async () => {
  const rolesFile = path.join(dir, 'roles.json');
  fs.writeFileSync(rolesFile, JSON.stringify({ roles: { [alice.webId]: ['author'], [bob.webId]: ['reviewer'] } }));
  server = createApp({
    tokens, podOrigin: CSS.slice(0, -1), rolesFile, capabilities: capabilityIssuer(), pod: pod.client, link,
    log: eventLog({ file: path.join(dir, 'events.jsonl') }),
    verifyPerson: solidOidcVerifier({ issuers: [CSS], fetchJson: issuer.fetchJson }),
    tls: { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `https://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

const request = (method, url, headers, body) => new Promise((resolve, reject) => {
  const req = https.request(url, { method, headers, servername: 'lifecycle', ca: fs.readFileSync(certFile) }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});
const call = (method, p, who, body) => {
  const headers = { 'content-type': 'application/json' };
  if (typeof who === 'string') headers.authorization = `Bearer ${tokens[who]}`;
  else if (who?.webId) Object.assign(headers, who.headers(method, base + p.split('?')[0]));
  return request(method, base + p, headers, body && JSON.stringify(body));
};
async function frameOn(templateId = 'machine-ifrs-sec01', extra = {}) {
  n += 1;
  const url = `${CSS}alice/assets/lanes-${n}.html`;
  pod.put(url, `doc ${n}`);
  const a = (await call('POST', '/assets', 'registrar', { podUrl: url, caseId: `c${n}`, revision: 'r1' })).body;
  const f = (await call('POST', '/frames', 'engine', { documents: [{ assetId: a.id }], preparer: alice.webId,
    case: { delimiter: 'ifrs-approval-case' }, first: { next: { engineId: 'cpp-1', templateId } }, ...extra })).body;
  return { a, f };
}
// The clone's 201, as the prologue reports it, at block `block`.
const cloneOf = (f, templateId, block, envelopeId = `env-${n}`, engineId = 'cpp-1') => ({
  cloneId: `${templateId}.${engineId}.${envelopeId}`, engineId, envelopeId, assetId: f.frameId, generation: 0,
  input: { offset: 20480 + 64 * block, length: 8 }
});

test('the lanes are the clone’s cells 2–7, declared on its PE as an inactive sensor and pushed', async () => {
  assert.deepEqual(LANES.map((l) => l.cell), [2, 3, 4, 5, 6, 7]);
  const { f } = await frameOn();
  assert.equal((await call('POST', `/frames/${f.frameId}/clones`, 'engine', cloneOf(f, 'machine-ifrs-sec01', 0))).status, 409, 'clone after resuming');
  await call('POST', `/frames/${f.frameId}/continuations/k0/resume`, 'engine', { generation: 1 });
  const r = await call('POST', `/frames/${f.frameId}/clones`, 'engine', cloneOf(f, 'machine-ifrs-sec01', 0));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.region, { offset: 20482, length: 6 });
  assert.equal(r.body.reserved, 'reserved');
  const declared = calls.find((c) => c[0] === 'declare' && c[2].id === r.body.sourceId)[2];
  assert.equal(r.body.sourceId, 'lifecycle-cpp-1-block-0', 'the source is the block’s');
  assert.deepEqual(declared, { id: 'lifecycle-cpp-1-block-0', type: 'sensor', name: 'lifecycle lanes cpp-1 block 0', sensorId: 'lifecycle.cpp-1.block-0',
    region: { offset: 20482, length: 6 }, lastValue: [], lastUpdated: null, ttlMs: 86400000, origin: 'lifecycle', active: false });
  // In the workflow, a step running.
  assert.deepEqual(lastPush(r.body.sensorId), [1, 0, 0, 0, 1, 0]);
});

test('an allocation is checked: the step’s template and engine, the band, reserved cells, no overlap', async () => {
  const { f } = await frameOn();
  await call('POST', `/frames/${f.frameId}/continuations/k0/resume`, 'engine', { generation: 1 });
  const ok = cloneOf(f, 'machine-ifrs-sec01', 5);
  const bad = async (body, status, why) => assert.equal((await call('POST', `/frames/${f.frameId}/clones`, 'engine', body)).status, status, why);
  await bad({ ...ok, engineId: 'lsp-1', cloneId: 'machine-ifrs-sec01.lsp-1.' + ok.envelopeId }, 409, 'another engine');
  await bad({ ...ok, cloneId: 'machine-other.cpp-1.' + ok.envelopeId }, 409, 'another template');
  await bad({ ...ok, assetId: 'frame-else' }, 409, 'another assetID');
  await bad({ ...ok, input: { offset: 20480 + 320, length: 4 } }, 409, 'no cells 2–7');
  await bad({ ...ok, input: { offset: 40, length: 8 } }, 400, 'outside the clone band');
  assert.equal((await call('POST', `/frames/${f.frameId}/clones`, 'registrar', ok)).status, 403);
  assert.equal((await call('POST', `/frames/${f.frameId}/clones`, 'engine', ok)).status, 201);
  // Overlapping cells on the same engine: another frame cannot take them.
  const { f: g } = await frameOn();
  await call('POST', `/frames/${g.frameId}/continuations/k0/resume`, 'engine', { generation: 1 });
  const clash = await call('POST', `/frames/${g.frameId}/clones`, 'engine', cloneOf(g, 'machine-ifrs-sec01', 5, 'env-clash'));
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /\[20802:20807\] are held by/);
  // A template that does not leave cells 2–7 free.
  const { f: h } = await frameOn('machine-busy');
  await call('POST', `/frames/${h.frameId}/continuations/k0/resume`, 'engine', { generation: 1 });
  const busy = await call('POST', `/frames/${h.frameId}/clones`, 'engine', cloneOf(h, 'machine-busy', 9));
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /does not declare input cells 2, 3, 4, 5, 6, 7 reserved/);
});

test('the frame’s observations reach its lanes as they happen', async () => {
  const { a, f } = await frameOn();
  await call('POST', `/frames/${f.frameId}/continuations/k0/resume`, 'engine', { generation: 1 });
  const lanes = (await call('POST', `/frames/${f.frameId}/clones`, 'engine', cloneOf(f, 'machine-ifrs-sec01', 12))).body;
  const at = () => lastPush(lanes.sensorId);
  // The step finishes and parks for review: no step running.
  await call('POST', `/frames/${f.frameId}/continuations`, 'engine', { next: { engineId: 'cpp-1', templateId: 'machine-ifrs-sec01' }, resumableBy: { role: 'reviewer' }, park: true });
  assert.deepEqual(at(), [1, 0, 0, 0, 0, 0]);
  // The reviewer approves: approved, and the approve step is running.
  await call('POST', `/frames/${f.frameId}/continuations/k1/resume`, bob, { generation: 2, decision: 'approve' });
  assert.deepEqual(at(), [1, 0, 1, 0, 1, 0]);
  // The document is re-pinned: pinned, and the head goes stale.
  pod.put(a.podUrl, 'edited');
  await call('POST', `/assets/${a.id}/revisions`, 'registrar', { revision: 'r2' });
  assert.deepEqual(at(), [1, 1, 1, 0, 1, 1]);
});

test('lanes are freed on recycle (with the clone’s generation), and with the frame on close', async () => {
  const { f } = await frameOn();
  await call('POST', `/frames/${f.frameId}/continuations/k0/resume`, 'engine', { generation: 1 });
  const lanes = (await call('POST', `/frames/${f.frameId}/clones`, 'engine', cloneOf(f, 'machine-ifrs-sec01', 20))).body;
  const del = (q) => call('DELETE', `/frames/${f.frameId}/clones/${encodeURIComponent(lanes.cloneId)}${q}`, 'engine');
  assert.equal((await del('')).status, 400);
  assert.equal((await del('?generation=3')).status, 409);
  const freed = await del('?generation=0');
  assert.equal(freed.status, 200);
  assert.equal(freed.body.status, 'released');
  // Freed lanes are written to zero and the block's source kept: a PE keeps a
  // removed source's last values, which would reach the next clone.
  assert.deepEqual(lastPush(lanes.sensorId), [0, 0, 0, 0, 0, 0]);
  assert.ok(!calls.some((c) => c[0] === 'remove'), 'no source is removed');
  assert.equal((await del('?generation=0')).status, 404, 'freed once');
  // The block's cells are free again for another clone.
  await call('POST', `/frames/${f.frameId}/continuations`, 'engine', { next: { engineId: 'cpp-1', templateId: 'machine-ifrs-sec01' } });
  await call('POST', `/frames/${f.frameId}/continuations/k1/resume`, 'engine', { generation: 2 });
  const again = await call('POST', `/frames/${f.frameId}/clones`, 'engine', cloneOf(f, 'machine-ifrs-sec01', 20, 'env-again'));
  assert.equal(again.status, 201);
  assert.equal(again.body.sourceId, lanes.sourceId, 'the same block, the same source');
  assert.equal(calls.filter((c) => c[0] === 'declare' && c[2].id === lanes.sourceId).length, 1, 'declared once');
  // Close: the frame's live lanes go with it.
  await call('POST', `/frames/${f.frameId}/close`, 'engine', {});
  const live = (await call('GET', '/lanes', 'engine')).body.live.filter((x) => x.frameId === f.frameId);
  assert.equal(live.length, 0);
  assert.deepEqual(lastPush(again.body.sensorId), [0, 0, 0, 0, 0, 0], 'closing zeroes the lanes');
  const h = (await call('GET', `/frames/${f.frameId}/history`, 'engine')).body.map((e) => e.type);
  assert.deepEqual(h.filter((t) => t.startsWith('lanes.')), ['lanes.allocated', 'lanes.released', 'lanes.allocated', 'lanes.released']);
});

test('a PE that cannot be reached is recorded, never silent, and never fails the change', async () => {
  const { f } = await frameOn();
  await call('POST', `/frames/${f.frameId}/continuations/k0/resume`, 'engine', { generation: 1 });
  const lanes = (await call('POST', `/frames/${f.frameId}/clones`, 'engine', cloneOf(f, 'machine-ifrs-sec01', 30))).body;
  failPush = true;
  const captured = await call('POST', `/frames/${f.frameId}/continuations`, 'engine', { next: { engineId: 'cpp-1', templateId: 'machine-ifrs-sec01' } });
  failPush = false;
  assert.equal(captured.status, 201);
  const held = (await call('GET', '/lanes', 'engine')).body.live.find((x) => x.cloneId === lanes.cloneId);
  assert.equal(held.error, 'PE unreachable');
  const h = (await call('GET', `/frames/${f.frameId}/history`, 'engine')).body;
  assert.ok(h.some((e) => e.type === 'lanes.push-failed' && e.error === 'PE unreachable'));
});

test('without an instance registry the allocation is recorded unwired, and nothing is sent', async () => {
  const app = createApp({ tokens, podOrigin: CSS.slice(0, -1), capabilities: capabilityIssuer(), pod: pod.client, log: eventLog(),
    tls: { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) } });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const other = `https://127.0.0.1:${app.address().port}`;
  const go = (method, p, body) => request(method, other + p, { 'content-type': 'application/json', authorization: `Bearer ${tokens[p === '/assets' ? 'registrar' : 'engine']}` }, body && JSON.stringify(body));
  try {
    n += 1;
    const url = `${CSS}alice/assets/unwired-${n}.html`;
    pod.put(url, 'x');
    const a = (await go('POST', '/assets', { podUrl: url, caseId: 'u', revision: 'r1' })).body;
    const f = (await go('POST', '/frames', { documents: [{ assetId: a.id }], preparer: alice.webId, case: { delimiter: 'd' },
      first: { next: { engineId: 'cpp-1', templateId: 'machine-ifrs-sec01' } } })).body;
    const k0 = (await go('POST', `/frames/${f.frameId}/continuations/k0/resume`, { generation: 1 })).body;
    assert.equal(k0.engineCheck, 'unchecked');
    const before = calls.length;
    const lanes = await go('POST', `/frames/${f.frameId}/clones`, cloneOf(f, 'machine-ifrs-sec01', 40));
    assert.equal(lanes.status, 201);
    assert.equal(lanes.body.wired, false);
    assert.equal(lanes.body.reserved, 'unchecked');
    assert.deepEqual(lanes.body.values, [1, 0, 0, 0, 1, 0], 'the values it would carry are still recorded');
    assert.equal(calls.length, before);
  } finally { await new Promise((r) => app.close(r)); }
});

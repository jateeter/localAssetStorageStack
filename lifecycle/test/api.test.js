import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

const tokens = { registrar: 'reg-token-0123456789', engine: 'eng-token-0123456789', agent: 'agt-token-0123456789', reviewer: 'rev-token-0123456789' };
let server, base;
const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-registry-'));
const registryFile = path.join(registryDir, 'registry.json');
test.before(async () => {
  fs.writeFileSync(registryFile, JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    services: { css: { internalUrl: 'http://css:3000/', externalUrl: 'http://127.0.0.1:49152/' } }
  }));
  server = createApp({ tokens, podOrigin: 'http://css:3000', registryFile });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(registryDir, { recursive: true, force: true });
});

const call = async (method, path, role, body) => {
  const headers = { 'content-type': 'application/json' };
  if (role) headers.authorization = 'Bearer ' + tokens[role];
  const r = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
import crypto from 'node:crypto';
const manifest = { triggers: [] };
const manifestHash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');

async function setup() {
  const a = (await call('POST', '/assets', 'registrar', { podUrl: 'http://css:3000/alice/doc.html', caseId: 'c1', revision: 'r1', content: 'hello' })).body;
  const m = (await call('POST', `/assets/${a.id}/machines`, 'registrar', {})).body;
  await call('POST', `/machines/${m.id}/verify`, 'registrar', { manifest, manifestHash });
  return { a, m };
}

test('health and registry are open, protected resources need auth', async () => {
  assert.equal((await call('GET', '/health')).status, 200);
  assert.equal((await call('GET', '/assets')).status, 401);
});

test('registry publishes internal and dynamically assigned host URLs', async () => {
  const r = await call('GET', '/registry');
  assert.equal(r.status, 200);
  assert.equal(r.body.services.css.internalUrl, 'http://css:3000/');
  assert.equal(r.body.services.css.externalUrl, 'http://127.0.0.1:49152/');
  r.body.services.css.externalUrl = 'http://127.0.0.1:49153/';
  fs.writeFileSync(registryFile, JSON.stringify(r.body));
  assert.equal((await call('GET', '/registry')).body.services.css.externalUrl, 'http://127.0.0.1:49153/');
});

test('unavailable registry returns service unavailable', async () => {
  fs.writeFileSync(registryFile, '{');
  assert.equal((await call('GET', '/registry')).status, 503);
  fs.writeFileSync(registryFile, JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    services: { css: { internalUrl: 'http://css:3000/', externalUrl: 'http://127.0.0.1:49152/' } }
  }));
});

test('role separation and pod origin enforcement', async () => {
  assert.equal((await call('POST', '/assets', 'agent', {})).status, 403);
  const r = await call('POST', '/assets', 'registrar', { podUrl: 'http://evil.example/x', caseId: 'c', revision: '1', content: 'x' });
  assert.equal(r.status, 400);
});

test('register pins revision hash; hash mismatch rejected', async () => {
  const { a } = await setup();
  assert.match(a.current.hash, /^[0-9a-f]{64}$/);
  const bad = await call('POST', '/assets', 'registrar', { podUrl: 'http://css:3000/a', caseId: 'c', revision: '1', content: 'x', hash: 'a'.repeat(64) });
  assert.equal(bad.status, 400);
});

test('full flow: binding, proposal, receipt verification', async () => {
  const { a, m } = await setup();
  const b = await call('POST', `/machines/${m.id}/bindings`, 'engine', { isreSnapshot: { v: [1] }, osreOutput: { o: 1 }, revision: a.current.revision, hash: a.current.hash, generation: 1, action: 'extract' });
  assert.equal(b.status, 201);
  assert.deepEqual(b.body.contextGrant.scopes, ['pod:read']);
  const p = await call('POST', `/bindings/${b.body.id}/proposals`, 'agent', { result: { ok: true } });
  assert.equal(p.status, 201);
  assert.equal((await call('GET', `/machines/${m.id}`, 'agent')).body.state, 'prepare');
  assert.equal((await call('POST', `/receipts/${p.body.receipt.id}/verify`, 'agent', {})).body.valid, true);
  assert.equal((await call('POST', `/bindings/${b.body.id}/proposals`, 'agent', { result: 1 })).status, 409);
});

test('delayed output cannot dispatch against newer revision', async () => {
  const { a, m } = await setup();
  const b = (await call('POST', `/machines/${m.id}/bindings`, 'engine', { isreSnapshot: 1, osreOutput: 1, revision: 'r1', hash: a.current.hash, generation: 1, action: 'extract' })).body;
  await call('POST', `/assets/${a.id}/revisions`, 'registrar', { revision: 'r2', content: 'changed' });
  assert.equal((await call('POST', `/bindings/${b.id}/proposals`, 'agent', { result: 1 })).status, 409);
  const late = await call('POST', `/machines/${m.id}/bindings`, 'engine', { isreSnapshot: 1, osreOutput: 1, revision: 'r1', hash: a.current.hash, generation: 1, action: 'extract' });
  assert.equal(late.status, 409);
});

test('disallowed transitions and revoked workers rejected', async () => {
  const { a, m } = await setup();
  const bad = await call('POST', `/machines/${m.id}/bindings`, 'engine', { isreSnapshot: 1, osreOutput: 1, revision: 'r1', hash: a.current.hash, generation: 1, action: 'publish' });
  assert.equal(bad.status, 409);
  await call('POST', `/machines/${m.id}/revoke`, 'registrar', {});
  const r = await call('POST', `/machines/${m.id}/bindings`, 'engine', { isreSnapshot: 1, osreOutput: 1, revision: 'r1', hash: a.current.hash, generation: 1, action: 'extract' });
  assert.equal(r.status, 409);
});

test('annotations and dispositions are revision-specific; one per reviewer', async () => {
  const { a } = await setup();
  assert.equal((await call('POST', `/assets/${a.id}/annotations`, 'reviewer', { revision: 'old', body: 'x' })).status, 409);
  const f = await call('POST', `/assets/${a.id}/annotations`, 'reviewer', { revision: 'r1', body: 'typo', author: 'bob' });
  assert.equal(f.status, 201);
  const dsp = { revision: 'r1', reviewer: 'bob', decision: 'accept', findingIds: [f.body.id] };
  assert.equal((await call('POST', `/assets/${a.id}/dispositions`, 'reviewer', dsp)).status, 201);
  assert.equal((await call('POST', `/assets/${a.id}/dispositions`, 'reviewer', dsp)).status, 409);
});

// The assetID frame and its continuations (ROADMAP phase 4): the IFRS approval
// chain end to end, and a test for every continuation rule the roadmap names:
// a replayed resume, a stale upstream, approve by the preparer, an abandon
// without the capability, an engine instance without the template, and a head
// closed on termination.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { capabilityIssuer, solidOidcVerifier } from '../src/identity.js';
import { eventLog, receiptSigner, verifyReceipt } from '../src/integrity.js';
import { fakeIssuer } from './support/issuer.js';
import { fakePod } from './support/pod.js';

const CSS = 'https://assets-css.localhost:13443/';
const tokens = { admin: 'adm-token-0123456789-0123456789-01', registrar: 'reg-token-0123456789-0123456789-01', engine: 'eng-token-0123456789-0123456789-01' };
const issuer = fakeIssuer(CSS);
const alice = issuer.person(`${CSS}alice/profile/card#me`); // the preparer (author, and a reviewer too)
const bob = issuer.person(`${CSS}bob/profile/card#me`); // a reviewer
const dave = issuer.person(`${CSS}dave/profile/card#me`); // an author only
const pod = fakePod();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-'));
// The service under test serves TLS 1.3, as it does in the stack.
const keyFile = path.join(dir, 'key.pem');
const certFile = path.join(dir, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:secp384r1', '-nodes', '-sha384',
  '-days', '1', '-subj', '/CN=lifecycle', '-addext', 'subjectAltName=DNS:lifecycle', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
let server, base, receipts;
let n = 0;

test.before(async () => {
  const rolesFile = path.join(dir, 'roles.json');
  fs.writeFileSync(rolesFile, JSON.stringify({ roles: { [alice.webId]: ['author', 'reviewer'], [bob.webId]: ['reviewer'], [dave.webId]: ['author'] } }));
  receipts = receiptSigner();
  server = createApp({
    tokens, podOrigin: CSS.slice(0, -1), rolesFile, capabilities: capabilityIssuer(), pod: pod.client, receipts,
    log: eventLog({ file: path.join(dir, 'events.jsonl') }),
    verifyPerson: solidOidcVerifier({ issuers: [CSS], fetchJson: issuer.fetchJson }),
    engineCheck: async (engineId, templateId) => (templateId === 'machine-gone' || engineId === 'cpp-9' ? 'missing' : 'carries'),
    tls: { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `https://127.0.0.1:${server.address().port}`;
});

// A request over TLS, verified against the test certificate.
const request = (method, url, headers, body) => new Promise((resolve, reject) => {
  const req = https.request(url, { method, headers, servername: 'lifecycle', ca: fs.readFileSync(certFile) }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const bytes = Buffer.concat(chunks);
      resolve({ status: res.statusCode, body: (res.headers['content-type'] || '').includes('json') ? JSON.parse(bytes.toString()) : bytes });
    });
  });
  req.on('error', reject);
  if (body !== undefined && body !== null) req.write(body);
  req.end();
});
test.after(async () => { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (method, p, who, body, extra = {}) => {
  const headers = { 'content-type': 'application/json', ...(extra.headers || {}) };
  if (typeof who === 'string') headers.authorization = `Bearer ${tokens[who]}`;
  else if (who?.capability) headers.authorization = `Bearer ${who.capability}`;
  else if (who?.webId) Object.assign(headers, who.headers(method, base + p.split('?')[0]));
  return request(method, base + p, headers, extra.raw ?? (body && JSON.stringify(body)));
};
const doc = async (text = 'draft') => {
  n += 1;
  const url = `${CSS}alice/assets/ifrs-${n}.html`;
  pod.put(url, text);
  return (await call('POST', '/assets', 'registrar', { podUrl: url, caseId: `case-${n}`, revision: 'r1' })).body;
};
const kase = () => ({ delimiter: 'ifrs-approval-case', entity: `E${n}`, period: '2026-Q4', assetType: 'COMPLIANCE-REVIEW' });
const engineNext = (templateId, engineId = 'cpp-1') => ({ engineId, templateId });
async function build(extra = {}) {
  const a = await doc();
  const r = await call('POST', '/frames', 'engine', {
    documents: [{ assetId: a.id, tag: 'primary' }], preparer: alice.webId, case: kase(), action: 'prepare', arguments: { scope: 'IAS 1' },
    first: { next: engineNext('machine-draft') }, ...extra
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { a, f: r.body };
}
const resume = (f, kid, who, body) => call('POST', `/frames/${f.frameId}/continuations/${kid}/resume`, who, body);
const capture = (f, body) => call('POST', `/frames/${f.frameId}/continuations`, 'engine', body);
const get = async (f) => (await call('GET', `/frames/${f.frameId}`, 'engine')).body;

test('the IFRS approval chain: prepare → review (parked) → approve → record → head closed', async () => {
  const { f } = await build();
  assert.equal(f.continuations[0].continuationId, 'k0');
  assert.equal(f.headStatus, 'DRAFT');
  assert.ok(f.pointer.url.endsWith(`/${f.frameId}.json`) && !f.pointer.error, 'the pod holds a pointer to the frame');

  // Prepare: the engine side resumes k0 and dispatches the agent with its capability.
  const k0 = await resume(f, 'k0', 'engine', { generation: 1 });
  assert.equal(k0.body.outcome, 'resume');
  assert.deepEqual(k0.body.next, engineNext('machine-draft'));
  assert.equal(k0.body.engineCheck, 'carries');
  const agent = { capability: k0.body.capability };
  assert.equal((await call('PUT', `/frames/${f.frameId}/return`, agent, { return: { draft: 'v1' } })).status, 200);
  // Request review: captured, resumed, then parked for a reviewer other than the preparer.
  const k1 = (await capture(f, { next: engineNext('machine-request-review') })).body.continuation;
  assert.equal(k1.generation, 2);
  assert.equal((await resume(f, 'k1', 'engine', { generation: 2 })).body.outcome, 'resume');
  const k2 = await capture(f, { next: engineNext('machine-approve'), resumableBy: { role: 'reviewer' }, park: true });
  assert.equal(k2.body.continuation.status, 'parked');
  assert.equal(k2.body.continuation.resumableBy.excludeIdentity, alice.webId, 'the preparer is excluded by default');
  assert.equal((await get(f)).headStatus, 'IN_REVIEW');
  // The human step: bob approves the exact pinned revision.
  const review = await resume(f, 'k2', bob, { generation: 3, decision: 'approve' });
  assert.equal(review.body.outcome, 'resume');
  assert.equal(review.body.capability, undefined, 'a person resumes; no agent capability is handed out');
  assert.equal((await get(f)).headStatus, 'APPROVED');
  // Approve and record steps, then termination closes the head.
  await capture(f, { next: engineNext('machine-publish') });
  assert.equal((await resume(f, 'k3', 'engine', { generation: 4 })).body.outcome, 'resume');
  const closed = await call('POST', `/frames/${f.frameId}/close`, 'engine', {});
  assert.equal(closed.status, 200);
  assert.equal(closed.body.frame.status, 'closed');
  const heads = (await call('GET', '/heads', 'engine')).body;
  assert.equal(heads[f.headKey].status, 'CLOSED');
  // The frame log is the evidence: every action, in order, each with a receipt that verifies.
  const h = (await call('GET', `/frames/${f.frameId}/history`, 'engine')).body;
  assert.deepEqual(h.map((e) => e.type), ['frame.built', 'continuation.resumed', 'frame.return', 'continuation.captured', 'continuation.resumed',
    'continuation.parked', 'disposition.recorded', 'continuation.resumed', 'continuation.captured', 'continuation.resumed', 'frame.closed']);
  const keys = (await request('GET', `${base}/keys`, {})).body;
  for (const e of h.filter((x) => x.receiptId)) {
    const r = (await call('GET', `/receipts/${e.receiptId}`, 'engine')).body;
    assert.ok(verifyReceipt(r, keys), `${e.type} receipt verifies`);
  }
  // A closed head takes a new frame.
  assert.equal((await call('POST', '/frames', 'engine', { documents: [{ assetId: f.documents[0].assetId }], preparer: alice.webId,
    case: f.case, first: { next: engineNext('machine-draft') } })).status, 201);
});

test('one-shot: a replayed resume and a wrong generation are refused', async () => {
  const { f } = await build();
  assert.equal((await resume(f, 'k0', 'engine', { generation: 2 })).status, 409);
  assert.equal((await resume(f, 'k0', 'engine', { generation: 1 })).status, 200);
  const replay = await resume(f, 'k0', 'engine', { generation: 1 });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error, 'continuation already resumed');
});

test('approve by the preparer is refused; so is a reviewer role a person does not hold, and any agent', async () => {
  const { f } = await build();
  const k0 = await resume(f, 'k0', 'engine', { generation: 1 });
  await capture(f, { next: engineNext('machine-approve'), resumableBy: { role: 'reviewer' }, park: true });
  const byPreparer = await resume(f, 'k1', alice, { generation: 2, decision: 'approve' });
  assert.equal(byPreparer.status, 403);
  assert.equal(byPreparer.body.error, 'the approver must not be the preparer');
  assert.equal((await resume(f, 'k1', dave, { generation: 2, decision: 'approve' })).status, 403, 'an author is not a reviewer');
  assert.equal((await resume(f, 'k1', { capability: k0.body.capability }, { generation: 2, decision: 'approve' })).status, 403, 'an agent never resumes');
  assert.equal((await resume(f, 'k1', 'engine', { generation: 2 })).status, 403, 'the engine side cannot stand in for a reviewer');
  assert.equal((await resume(f, 'k1', bob, { generation: 2 })).status, 400, 'a review is a decision');
  // Rework sends the frame back to k0, with the parked continuation superseded.
  const rework = await resume(f, 'k1', bob, { generation: 2, decision: 'rework' });
  assert.equal(rework.body.outcome, 'escape');
  assert.equal(rework.body.reason, 'rework');
  assert.deepEqual(rework.body.continuation.next, engineNext('machine-draft'));
  assert.equal((await get(f)).headStatus, 'DRAFT');
});

test('a stale upstream supersedes what is pending and re-enters at k0', async () => {
  const upstream = await doc('upstream v1');
  const { f } = await build({ upstreamRefs: [upstream.id] });
  pod.put(upstream.podUrl, 'upstream v2');
  await call('POST', `/assets/${upstream.id}/revisions`, 'registrar', { revision: 'r2' });
  const after = await get(f);
  assert.equal(after.headStatus, 'STALE');
  assert.equal(after.continuations[0].status, 'superseded');
  assert.match(after.continuations[0].supersededReason, /upstream .* re-pinned at r2/);
  assert.equal(after.current, 'k1');
  assert.equal((await resume(f, 'k0', 'engine', { generation: 1 })).body.error, 'continuation superseded');
  assert.equal((await resume(f, 'k1', 'engine', { generation: 2 })).body.outcome, 'resume', 'the escape continuation resumes');
});

test('a document changed since its pin takes the escape path at resume, never the approve path', async () => {
  const { a, f } = await build();
  await resume(f, 'k0', 'engine', { generation: 1 });
  await capture(f, { next: engineNext('machine-approve'), resumableBy: { role: 'reviewer' }, park: true });
  pod.put(a.podUrl, 'edited after the pin');
  const r = await resume(f, 'k1', bob, { generation: 2, decision: 'approve' });
  assert.equal(r.body.outcome, 'escape');
  assert.equal(r.body.reason, 'pod changed since pin');
  assert.equal((await get(f)).headStatus, 'STALE');
  assert.equal(Object.values((await call('GET', `/assets/${a.id}/annotations`, 'engine')).body).length, 0);
});

test('an engine instance without the template takes the escape path and says why', async () => {
  const { f } = await build({ first: { next: engineNext('machine-gone') } });
  const r = await resume(f, 'k0', 'engine', { generation: 1 });
  assert.equal(r.body.outcome, 'escape');
  assert.equal(r.body.reason, 'engine cpp-1 does not carry machine-gone');
});

test('a continuation names a template, never a clone', async () => {
  const a = await doc();
  const r = await call('POST', '/frames', 'engine', { documents: [{ assetId: a.id }], preparer: alice.webId, case: kase(),
    first: { next: engineNext('machine-draft.cpp-1.env-7') } });
  assert.equal(r.status, 400);
});

test('abandoning needs the case’s abandon capability, and writes who, why and the generation', async () => {
  const { f } = await build();
  const k0 = await resume(f, 'k0', 'engine', { generation: 1 });
  for (const who of [{ capability: k0.body.capability }, 'engine', bob]) {
    assert.equal((await call('POST', `/frames/${f.frameId}/abandon`, who, { reason: 'x' })).status, 403);
  }
  assert.equal((await call('POST', `/frames/${f.frameId}/abandon`, alice, {})).status, 400, 'a reason is required');
  const r = await call('POST', `/frames/${f.frameId}/abandon`, alice, { reason: 'entity withdrawn' });
  assert.equal(r.status, 200);
  const receipt = (await call('GET', `/receipts/${r.body.receipt}`, 'engine')).body;
  assert.equal(receipt.by, alice.webId);
  assert.equal(receipt.reason, 'entity withdrawn');
  assert.equal(receipt.generation, 1);
  assert.equal(r.body.frame.headStatus, 'ABANDONED');
  assert.equal((await capture(f, { next: engineNext('machine-x') })).status, 409, 'an abandoned frame takes nothing more');
});

test('termination closes the head, and only after a step ran; an open head refuses a second frame', async () => {
  const { a, f } = await build();
  assert.equal((await call('POST', '/frames', 'engine', { documents: [{ assetId: a.id }], preparer: alice.webId, case: f.case,
    first: { next: engineNext('machine-draft') } })).status, 409, 'one open frame per head');
  assert.equal((await call('POST', `/frames/${f.frameId}/close`, 'engine', {})).status, 409, 'nothing ran yet');
  await resume(f, 'k0', 'engine', { generation: 1 });
  assert.equal((await call('POST', `/frames/${f.frameId}/close`, 'registrar', {})).status, 403);
  assert.equal((await call('POST', `/frames/${f.frameId}/close`, 'engine', {})).status, 200);
  assert.equal((await call('GET', '/heads', 'engine')).body[f.headKey].status, 'CLOSED');
});

test('the /pod proxy: an agent reaches its own frame’s documents only, and writes only with pod:write', async () => {
  const shared = await doc('shared');
  const { a, f } = await build();
  // A second frame whose upstream is the first frame's document.
  const other = await call('POST', '/frames', 'engine', { documents: [{ assetId: shared.id }], preparer: alice.webId,
    case: { delimiter: 'ifrs-approval-case' }, upstreamRefs: [a.id], first: { next: engineNext('machine-draft') } });
  const k0 = await resume(f, 'k0', 'engine', { generation: 1 });
  const agent = { capability: k0.body.capability };
  const read = await call('GET', `/pod?url=${encodeURIComponent(a.podUrl)}`, agent);
  assert.equal(read.status, 200);
  assert.equal(read.body.toString(), 'draft');
  assert.equal((await call('GET', `/pod?url=${encodeURIComponent(shared.podUrl)}`, agent)).status, 403, 'not a document of this frame');
  assert.equal((await call('GET', `/pod?url=${encodeURIComponent(a.podUrl)}`, 'engine')).status, 403, 'the proxy serves agents');
  assert.equal((await call('PUT', `/pod?url=${encodeURIComponent(a.podUrl)}`, agent, null, { raw: 'v2', headers: { 'content-type': 'text/html' } })).status, 403, 'no pod:write');
  // A step granted pod:write.
  await capture(f, { next: engineNext('machine-publish'), scopes: ['frame:read', 'pod:read', 'pod:write'] });
  const k1 = await resume(f, 'k1', 'engine', { generation: 2 });
  const writer = { capability: k1.body.capability };
  assert.equal((await call('GET', `/pod?url=${encodeURIComponent(a.podUrl)}`, agent)).status, 403, 'the earlier step’s capability is spent');
  const w = await call('PUT', `/pod?url=${encodeURIComponent(a.podUrl)}`, writer, null, { raw: 'published', headers: { 'content-type': 'text/html' } });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(w.body.revision, 'r1+k1');
  const mine = await get(f);
  assert.equal(mine.documents[0].revision, 'r1+k1', 'the frame re-pins its own write');
  assert.equal(mine.headStatus, 'DRAFT', 'and is not made stale by it');
  const theirs = (await call('GET', `/frames/${other.body.frameId}`, 'engine')).body;
  assert.equal(theirs.headStatus, 'STALE', 'a frame whose upstream it is goes stale');
  assert.equal((await call('POST', `/frames/${f.frameId}/close`, 'engine', {})).status, 200);
  assert.equal((await call('GET', `/pod?url=${encodeURIComponent(a.podUrl)}`, writer)).status, 409, 'a closed frame serves nothing');
});

test('rule 7 against the instance registry: carries, missing, gone or unreachable', async () => {
  const { registryEngineCheck } = await import('../src/engines.js');
  assert.equal(await registryEngineCheck({ registryUrl: '' })('cpp-1', 't'), 'unchecked');
  const responses = {
    'https://reg/re-registry.json': { instances: [{ id: 'cpp-1', status: 'running', re_url: 'https://cpp:6301' }, { id: 'lsp-1', status: 'stopped', re_url: 'https://lsp:6601' }] },
    'https://cpp:6301/api/machines/cloneable': { machines: [{ id: 'machine-draft', cloneable: true }, { id: 'machine-bus', cloneable: false }] }
  };
  const get = async (url) => { if (!responses[url]) throw new Error('unreachable'); return responses[url]; };
  const check = registryEngineCheck({ registryUrl: 'https://reg/re-registry.json', get });
  assert.equal(await check('cpp-1', 'machine-draft'), 'carries');
  assert.equal(await check('cpp-1', 'machine-bus'), 'missing', 'listed but not cloneable');
  assert.equal(await check('cpp-1', 'machine-other'), 'missing');
  assert.equal(await check('lsp-1', 'machine-draft'), 'missing', 'not running');
  assert.equal(await check('scala-1', 'machine-draft'), 'missing', 'gone');
  const down = registryEngineCheck({ registryUrl: 'https://down/re-registry.json', get });
  assert.equal(await down('cpp-1', 'machine-draft'), 'missing', 'an unreachable registry is never a pass');
});

test('the engine side lists open frames, and takes a person-resumed step’s capability once', async () => {
  const { f } = await build();
  const open = (await call('GET', '/frames?status=open', 'engine')).body.frames;
  const mine = open.find((x) => x.frameId === f.frameId);
  assert.equal(mine.current.continuationId, 'k0');
  assert.equal(mine.current.status, 'captured');
  assert.ok(open.every((x) => x.status === 'open'));
  // An engine resume carries its capability; asking again is refused.
  await resume(f, 'k0', 'engine', { generation: 1 });
  assert.equal((await call('POST', `/frames/${f.frameId}/continuations/k0/capability`, 'engine', {})).status, 409);
  await capture(f, { next: engineNext('machine-approve'), resumableBy: { role: 'reviewer' }, park: true });
  assert.equal((await call('POST', `/frames/${f.frameId}/continuations/k1/capability`, 'engine', {})).status, 409, 'not yet resumed');
  await resume(f, 'k1', bob, { generation: 2, decision: 'approve' });
  assert.equal((await call('POST', `/frames/${f.frameId}/continuations/k1/capability`, 'registrar', {})).status, 403);
  const cap = await call('POST', `/frames/${f.frameId}/continuations/k1/capability`, 'engine', {});
  assert.equal(cap.status, 200);
  assert.equal((await call('GET', `/frames/${f.frameId}`, { capability: cap.body.capability })).status, 200, 'the agent reads its frame');
  assert.equal((await call('POST', `/frames/${f.frameId}/continuations/k1/capability`, 'engine', {})).status, 409, 'once');
  assert.equal((await call('GET', '/frames', { capability: cap.body.capability })).status, 403, 'agents do not list frames');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { capabilityIssuer, serviceTokens, solidOidcVerifier } from '../src/identity.js';
import { dpopProof } from '../src/jose.js';
import { fakeIssuer } from './support/issuer.js';

const CSS = 'https://assets-css.localhost:13443/';
const tokens = { admin: 'adm-token-0123456789-0123456789-01', registrar: 'reg-token-0123456789-0123456789-01', engine: 'eng-token-0123456789-0123456789-01' };
const issuer = fakeIssuer(CSS);
const alice = issuer.person(`${CSS}alice/profile/card#me`); // author
const bob = issuer.person(`${CSS}bob/profile/card#me`); // reviewer
const carol = issuer.person(`${CSS}carol/profile/card#me`); // no roles
let server, base, capabilities;
const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-registry-'));
const registryFile = path.join(registryDir, 'registry.json');
const rolesFile = path.join(registryDir, 'roles.json');
test.before(async () => {
  fs.writeFileSync(registryFile, JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    services: { 'assets-css': { internalUrl: 'https://assets-css.localhost:13443/', externalUrl: 'https://assets-css.localhost:13443/' } }
  }));
  fs.writeFileSync(rolesFile, JSON.stringify({ roles: { [alice.webId]: ['author'], [bob.webId]: ['reviewer'] } }));
  capabilities = capabilityIssuer();
  server = createApp({ tokens, podOrigin: 'https://assets-css.localhost:13443', registryFile, rolesFile, capabilities,
    verifyPerson: solidOidcVerifier({ issuers: [CSS], fetchJson: issuer.fetchJson }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(registryDir, { recursive: true, force: true });
});

// `who` is a service role name, a person from the issuer, a capability token
// ({ capability }) or raw headers ({ headers }).
const call = async (method, p, who, body) => {
  const headers = { 'content-type': 'application/json' };
  if (typeof who === 'string') headers.authorization = 'Bearer ' + tokens[who];
  else if (who?.capability) headers.authorization = 'Bearer ' + who.capability;
  else if (who?.headers && who.webId) Object.assign(headers, who.headers(method, base + p));
  else if (who?.headers) Object.assign(headers, who.headers);
  const r = await fetch(base + p, { method, headers, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const manifest = { triggers: [] };
const manifestHash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');

async function setup() {
  const a = (await call('POST', '/assets', 'registrar', { podUrl: 'https://assets-css.localhost:13443/alice/doc.html', caseId: 'c1', revision: 'r1', content: 'hello' })).body;
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
  assert.equal(r.body.services['assets-css'].internalUrl, 'https://assets-css.localhost:13443/');
  assert.equal(r.body.services['assets-css'].externalUrl, 'https://assets-css.localhost:13443/');
  r.body.services['assets-css'].externalUrl = 'https://assets-css.localhost:13444/';
  fs.writeFileSync(registryFile, JSON.stringify(r.body));
  assert.equal((await call('GET', '/registry')).body.services['assets-css'].externalUrl, 'https://assets-css.localhost:13444/');
});

test('unavailable registry returns service unavailable', async () => {
  fs.writeFileSync(registryFile, '{');
  assert.equal((await call('GET', '/registry')).status, 503);
  fs.writeFileSync(registryFile, JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    services: { 'assets-css': { internalUrl: 'https://assets-css.localhost:13443/', externalUrl: 'https://assets-css.localhost:13443/' } }
  }));
});

test('role separation and pod origin enforcement', async () => {
  assert.equal((await call('POST', '/assets', 'engine', {})).status, 403);
  const r = await call('POST', '/assets', 'registrar', { podUrl: 'https://evil.example/x', caseId: 'c', revision: '1', content: 'x' });
  assert.equal(r.status, 400);
});

test('register pins revision hash; hash mismatch rejected', async () => {
  const { a } = await setup();
  assert.match(a.current.hash, /^[0-9a-f]{64}$/);
  const bad = await call('POST', '/assets', 'registrar', { podUrl: 'https://assets-css.localhost:13443/a', caseId: 'c', revision: '1', content: 'x', hash: 'a'.repeat(64) });
  assert.equal(bad.status, 400);
});

test('full flow: binding, proposal, receipt verification', async () => {
  const { a, m } = await setup();
  const b = await call('POST', `/machines/${m.id}/bindings`, 'engine', { isreSnapshot: { v: [1] }, osreOutput: { o: 1 }, revision: a.current.revision, hash: a.current.hash, generation: 1, action: 'extract' });
  assert.equal(b.status, 201);
  assert.deepEqual(b.body.contextGrant.scopes, ['pod:read']);
  const agent = { capability: b.body.capability };
  assert.equal((await call('GET', `/bindings/${b.body.id}`, 'engine')).body.capability, undefined, 'the capability is never served again');
  const p = await call('POST', `/bindings/${b.body.id}/proposals`, agent, { result: { ok: true } });
  assert.equal(p.status, 201);
  assert.equal((await call('GET', `/machines/${m.id}`, agent)).body.state, 'prepare');
  assert.equal((await call('POST', `/receipts/${p.body.receipt.id}/verify`, agent, {})).body.valid, true);
  assert.equal((await call('POST', `/bindings/${b.body.id}/proposals`, agent, { result: 1 })).status, 409);
});

test('delayed output cannot dispatch against newer revision', async () => {
  const { a, m } = await setup();
  const b = (await call('POST', `/machines/${m.id}/bindings`, 'engine', { isreSnapshot: 1, osreOutput: 1, revision: 'r1', hash: a.current.hash, generation: 1, action: 'extract' })).body;
  await call('POST', `/assets/${a.id}/revisions`, 'registrar', { revision: 'r2', content: 'changed' });
  assert.equal((await call('POST', `/bindings/${b.id}/proposals`, { capability: b.capability }, { result: 1 })).status, 409);
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

test('annotations and dispositions are revision-specific; one per reviewer, keyed by WebID', async () => {
  const { a } = await setup();
  assert.equal((await call('POST', `/assets/${a.id}/annotations`, bob, { revision: 'old', body: 'x' })).status, 409);
  const f = await call('POST', `/assets/${a.id}/annotations`, bob, { revision: 'r1', body: 'typo' });
  assert.equal(f.status, 201);
  assert.equal(f.body.author, bob.webId);
  const dsp = { revision: 'r1', decision: 'accept', findingIds: [f.body.id] };
  const first = await call('POST', `/assets/${a.id}/dispositions`, bob, dsp);
  assert.equal(first.status, 201);
  assert.equal(first.body.reviewer, bob.webId);
  assert.equal((await call('POST', `/assets/${a.id}/dispositions`, bob, dsp)).status, 409);
});

// --- identity (ROADMAP phase 2) ------------------------------------------------

test('a forged reviewer or author field is refused', async () => {
  const { a } = await setup();
  const forged = await call('POST', `/assets/${a.id}/dispositions`, bob, { revision: 'r1', decision: 'approve', reviewer: `${CSS}mallory/profile/card#me` });
  assert.equal(forged.status, 403);
  assert.match(forged.body.error, /taken from the sign-in token/);
  assert.equal((await call('POST', `/assets/${a.id}/annotations`, bob, { revision: 'r1', body: 'x', author: 'someone' })).status, 403);
  // Naming yourself is allowed.
  assert.equal((await call('POST', `/assets/${a.id}/dispositions`, bob, { revision: 'r1', decision: 'approve', reviewer: bob.webId })).status, 201);
});

test('roles attach to WebIDs: an author or a WebID without roles cannot review', async () => {
  const { a } = await setup();
  assert.equal((await call('POST', `/assets/${a.id}/dispositions`, alice, { revision: 'r1', decision: 'approve' })).status, 403);
  assert.equal((await call('POST', `/assets/${a.id}/dispositions`, carol, { revision: 'r1', decision: 'approve' })).status, 403);
  assert.deepEqual((await call('GET', '/whoami', alice)).body, { kind: 'person', webId: alice.webId, roles: ['author'] });
});

test('admin manages roles and implies no other role', async () => {
  assert.equal((await call('POST', '/assets', 'admin', { podUrl: `${CSS}a/d`, caseId: 'c', revision: '1', content: 'x' })).status, 403);
  assert.equal((await call('PUT', '/roles', 'registrar', { webId: carol.webId, roles: ['reviewer'] })).status, 403);
  assert.equal((await call('PUT', '/roles', 'admin', { webId: carol.webId, roles: ['owner'] })).status, 400);
  assert.equal((await call('PUT', '/roles', 'admin', { webId: 'not-a-webid', roles: [] })).status, 400);
  const set = await call('PUT', '/roles', 'admin', { webId: carol.webId, roles: ['reviewer'] });
  assert.deepEqual(set.body, { webId: carol.webId, roles: ['reviewer'] });
  assert.deepEqual((await call('GET', '/whoami', carol)).body.roles, ['reviewer']);
  assert.deepEqual((await call('GET', '/roles', 'admin')).body[bob.webId], ['reviewer']);
  await call('PUT', '/roles', 'admin', { webId: carol.webId, roles: [] });
  assert.deepEqual((await call('GET', '/whoami', carol)).body.roles, []);
});

test('Solid-OIDC: the token must be DPoP-bound, fresh, from assets-css, for this request', async () => {
  const url = (p) => base + p;
  const proof = (person, method, p, token = person.token) => dpopProof(person.key, method, url(p), token);
  const expect401 = async (headers, why) => {
    const r = await call('GET', '/whoami', { headers });
    assert.equal(r.status, 401, why);
  };
  await expect401({ authorization: `DPoP ${bob.token}` }, 'no proof');
  await expect401({ authorization: `DPoP ${bob.token}`, dpop: proof(bob, 'POST', '/whoami') }, 'proof for another method');
  await expect401({ authorization: `DPoP ${bob.token}`, dpop: proof(bob, 'GET', '/assets') }, 'proof for another URL');
  await expect401({ authorization: `DPoP ${bob.token}`, dpop: proof(alice, 'GET', '/whoami', bob.token) }, 'another key');
  await expect401({ authorization: `DPoP ${bob.token}`, dpop: proof(bob, 'GET', '/whoami', alice.token) }, 'proof bound to another token');
  await expect401({ authorization: `Bearer ${bob.token}` }, 'a DPoP token used as a bearer token');
  const once = proof(bob, 'GET', '/whoami');
  assert.equal((await call('GET', '/whoami', { headers: { authorization: `DPoP ${bob.token}`, dpop: once } })).status, 200);
  await expect401({ authorization: `DPoP ${bob.token}`, dpop: once }, 'replayed proof');

  const expired = issuer.person(bob.webId, { exp: Math.floor(Date.now() / 1000) - 3600 });
  await expect401(expired.headers('GET', url('/whoami')), 'expired');
  const elsewhere = issuer.person('https://evil.example/me#i');
  await expect401(elsewhere.headers('GET', url('/whoami')), 'WebID not on the issuer');
  const otherIssuer = issuer.person(bob.webId, { iss: 'https://evil.example/' });
  await expect401(otherIssuer.headers('GET', url('/whoami')), 'untrusted issuer');
  const noAud = issuer.person(bob.webId, { aud: 'dokieli' });
  await expect401(noAud.headers('GET', url('/whoami')), 'audience is not solid');
  const unbound = issuer.person(bob.webId, { cnf: undefined });
  await expect401(unbound.headers('GET', url('/whoami')), 'not DPoP-bound');
  const forgedKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const t = Math.floor(Date.now() / 1000);
  const forgedToken = issuer.mint({ iss: CSS, aud: ['solid'], webid: bob.webId, cnf: { jkt: bob.key.jkt }, iat: t, exp: t + 600 }, forgedKey);
  await expect401({ authorization: `DPoP ${forgedToken}`, dpop: proof(bob, 'GET', '/whoami', forgedToken) }, 'signed by another key');
});

test('capability tokens: one binding, the agent principal, unforgeable', async () => {
  const { a, m } = await setup();
  const mk = async () => (await call('POST', `/machines/${m.id}/bindings`, 'engine', { isreSnapshot: 1, osreOutput: 1, revision: 'r1', hash: a.current.hash, generation: 1, action: 'extract' })).body;
  const b1 = await mk();
  const other = capabilityIssuer();
  assert.equal((await call('GET', '/whoami', { capability: b1.capability })).body.principal, 'lifecycle-agent');
  assert.equal((await call('POST', `/bindings/${b1.id}/proposals`, 'engine', { result: 1 })).status, 403, 'a service is not an agent');
  assert.equal((await call('POST', `/bindings/${b1.id}/proposals`, bob, { result: 1 })).status, 403, 'a person is not an agent');
  assert.equal((await call('POST', `/bindings/${b1.id}/proposals`, { capability: other.issue({ bindingId: b1.id, scopes: [] }) }, { result: 1 })).status, 401, 'another issuer');
  const [h, , sig] = b1.capability.split('.');
  const widened = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b1.capability.split('.')[1], 'base64url')), scope: 'pod:read pod:write' })).toString('base64url');
  assert.equal((await call('POST', `/bindings/${b1.id}/proposals`, { capability: `${h}.${widened}.${sig}` }, { result: 1 })).status, 401, 'tampered');
  assert.equal((await call('POST', `/assets/${a.id}/dispositions`, { capability: b1.capability }, { revision: 'r1', decision: 'approve' })).status, 403, 'an agent cannot review');
  // A capability for this binding does not reach another one.
  const b2 = await mk();
  assert.equal((await call('POST', `/bindings/${b2.id}/proposals`, { capability: b1.capability }, { result: 1 })).status, 403);
  const expiredIssuer = capabilityIssuer({ ttl: -1 });
  const expiredApp = expiredIssuer.check.bind(expiredIssuer);
  assert.throws(() => expiredApp(expiredIssuer.issue({ bindingId: b1.id, scopes: [] })), /expired/);
});

test('service tokens are at least 32 bytes and carry service roles only', () => {
  assert.throws(() => serviceTokens({ registrar: 'short-token-0123456789' }), /32 bytes/);
  assert.throws(() => serviceTokens({ reviewer: 'x'.repeat(40) }), /not a service role/);
  assert.equal(serviceTokens(tokens)(tokens.engine), 'engine');
  assert.equal(serviceTokens(tokens)('nope'), null);
});

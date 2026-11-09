// The lifecycle service on TLS under RealityEngine_CI's transport profile
// (RealityEngine_CI#668, localAssetStorageStack#15): TLS 1.3 only, the
// profile's suites, and plaintext pod URLs refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createApp, TLS_PROFILE } from '../src/app.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-tls-'));
const key = path.join(dir, 'key.pem');
const cert = path.join(dir, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:secp384r1', '-nodes', '-sha384',
  '-days', '1', '-subj', '/CN=lifecycle', '-addext', 'subjectAltName=DNS:lifecycle', '-keyout', key, '-out', cert], { stdio: 'ignore' });

const tokens = { registrar: 'reg-token-0123456789-0123456789-01' };
let server, port;
test.before(async () => {
  server = createApp({ tokens, tls: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (opts) => new Promise((resolve, reject) => {
  const req = https.get({ host: '127.0.0.1', port, path: '/health', servername: 'lifecycle', ca: fs.readFileSync(cert), ...opts }, (res) => {
    const protocol = res.socket.getProtocol();
    const cipher = res.socket.getCipher().standardName;
    res.resume();
    res.on('end', () => resolve({ status: res.statusCode, protocol, cipher }));
  });
  req.on('error', reject);
});

test('serves TLS 1.3 with a profile cipher suite, verified against its CA', async () => {
  const r = await get({});
  assert.equal(r.status, 200);
  assert.equal(r.protocol, 'TLSv1.3');
  assert.ok(TLS_PROFILE.ciphers.split(':').includes(r.cipher), `unexpected suite ${r.cipher}`);
});

test('refuses a TLS 1.2 client', async () => {
  await assert.rejects(get({ maxVersion: 'TLSv1.2', minVersion: 'TLSv1.2' }));
});

test('refuses a client offering only a suite outside the profile', async () => {
  await assert.rejects(get({ ciphers: 'TLS_AES_128_GCM_SHA256' }));
});

test('a pod URL without https is refused', async () => {
  // The same pod URL with its scheme downgraded must be rejected.
  const plain = new URL('https://assets-css.localhost:13443/a');
  plain.protocol = 'http:';
  const status = await new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port, path: '/assets', method: 'POST', servername: 'lifecycle', ca: fs.readFileSync(cert),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.registrar}` }
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(JSON.stringify({ podUrl: plain.href, caseId: 'c', revision: '1', content: 'x' }));
  });
  assert.equal(status, 400);
});

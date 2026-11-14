// What the stack's checks (scripts/smoke.js, scripts/chain-regression.js) need
// to talk to a running universe (ROADMAP phase 11). RealityEngine_CI's
// regression harness runs them with:
//   LIFECYCLE_URL          the lifecycle API (default: runtime/registry.json's)
//   MANAGER_URL            Manager's backend (chain regression only)
//   RE_REGISTRY_URL        the RealityEngine instance registry
//   RE_HARNESS_TLS_CA, RE_HARNESS_TLS_CERT, RE_HARNESS_TLS_KEY
//                          the lane CA and the harness's client certificate
//                          (engines and the instance registry are mTLS)
// and node --dns-result-order=ipv4first, NODE_EXTRA_CA_CERTS=<lane CA>.
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dpopKey, dpopProof } from '../../lifecycle/src/jose.js';
import { readAccounts, secretsHome, serviceTokens } from './secrets-home.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CSS = 'https://assets-css.localhost:13443/';

export function config() {
  // The secrets home every checkout shares (scripts/lib/secrets-home.js).
  const home = secretsHome();
  const env = serviceTokens(home);
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'registry.json'), 'utf8'));
  const read = (v) => (process.env[v] ? fs.readFileSync(process.env[v]) : undefined);
  return {
    tokens: { registrar: env.REGISTRAR_TOKEN, engine: env.ENGINE_TOKEN, admin: env.ADMIN_TOKEN },
    lifecycleUrl: process.env.LIFECYCLE_URL || registry.services.lifecycle.externalUrl,
    managerUrl: process.env.MANAGER_URL || '',
    registryUrl: process.env.RE_REGISTRY_URL || '',
    accounts: readAccounts(home),
    harness: { ca: read('RE_HARNESS_TLS_CA'), cert: read('RE_HARNESS_TLS_CERT'), key: read('RE_HARNESS_TLS_KEY') }
  };
}

// A JSON request over TLS with explicit trust and, for mTLS peers, the
// harness certificate.
export function request(method, url, { body, headers = {}, tls = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const r = https.request(url, { method, minVersion: 'TLSv1.3', ...tls,
      headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// A person signed in to assets-css: client credentials, then a DPoP-bound token.
export async function person(cfg, pod) {
  const a = cfg.accounts[pod];
  if (!a) throw new Error(`no account ${pod} (ASSETS_PEOPLE)`);
  const json = async (r) => r.json();
  const idx = await json(await fetch(`${CSS}.account/`));
  const login = await json(await fetch(idx.controls.password.login, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: a.email, password: a.password }) }));
  const auth = { authorization: `CSS-Account-Token ${login.authorization}` };
  const controls = (await json(await fetch(`${CSS}.account/`, { headers: auth }))).controls;
  const webId = `${CSS}${pod}/profile/card#me`;
  const cc = await json(await fetch(controls.account.clientCredentials, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name: `checks-${pod}-${Date.now()}`, webId }) }));
  const key = dpopKey();
  const cfgOidc = await json(await fetch(`${CSS}.well-known/openid-configuration`));
  const tok = await json(await fetch(cfgOidc.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded',
    authorization: `Basic ${Buffer.from(`${encodeURIComponent(cc.id)}:${encodeURIComponent(cc.secret)}`).toString('base64')}`, dpop: dpopProof(key, 'POST', cfgOidc.token_endpoint) },
    body: 'grant_type=client_credentials&scope=webid' }));
  if (!tok.access_token) throw new Error(`${pod}: no access token`);
  return {
    webId,
    headers: (method, url) => ({ authorization: `DPoP ${tok.access_token}`, dpop: dpopProof(key, method, url.split('?')[0], tok.access_token) }),
    // DPoP-bound fetch for the person's own pod.
    pod: (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers || {}), authorization: `DPoP ${tok.access_token}`, dpop: dpopProof(key, init.method || 'GET', url, tok.access_token) } })
  };
}

// The lifecycle API as a service (by role) or a person.
export function lifecycle(cfg) {
  return (method, p, who, body) => {
    const url = new URL(p, cfg.lifecycleUrl).href;
    const headers = typeof who === 'string' ? { authorization: `Bearer ${cfg.tokens[who]}` } : who.headers(method, url);
    return request(method, url, { body, headers });
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(what, fn, seconds = 120) {
  for (let i = 0; i < seconds * 2; i += 1) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out after ${seconds}s: ${what}`);
}

// A check list that becomes a JSON report.
export function checks(name) {
  const results = [];
  return {
    check(label, ok, detail = '') {
      results.push({ label, ok: !!ok, detail: String(detail ?? '') });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
      return !!ok;
    },
    report(file, extra = {}) {
      const failed = results.filter((r) => !r.ok).length;
      const out = { check: name, status: failed ? 'failed' : 'passed', passed: results.length - failed, failed, results, ...extra };
      if (file) fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
      return failed;
    }
  };
}

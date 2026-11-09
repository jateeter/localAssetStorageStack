import fs from 'node:fs';
import { createApp, Store } from './app.js';
import { MIN_SERVICE_TOKEN, capabilityIssuer, serviceIdentity, solidOidcVerifier } from './identity.js';

const fail = (message) => { console.error(message); process.exit(1); };

// Service tokens are for services only (ROADMAP phase 2): admin manages roles,
// registrar registers assets, engine creates bindings. People sign in with
// Solid-OIDC; agents carry capability tokens.
const tokens = {
  admin: process.env.ADMIN_TOKEN,
  registrar: process.env.REGISTRAR_TOKEN,
  engine: process.env.ENGINE_TOKEN
};
if (!Object.values(tokens).some(Boolean) || Object.values(tokens).some((t) => t && Buffer.byteLength(t) < MIN_SERVICE_TOKEN)) {
  fail(`Configure ADMIN_TOKEN, REGISTRAR_TOKEN and ENGINE_TOKEN (at least ${MIN_SERVICE_TOKEN} bytes each)`);
}
for (const retired of ['AGENT_TOKEN', 'REVIEWER_TOKEN']) {
  if (process.env[retired]) console.warn(`${retired} is ignored: reviewers sign in with Solid-OIDC and agents carry capability tokens`);
}
// Every link is TLS 1.3 (RealityEngine_CI#668). The service never serves
// plaintext: without its certificate it refuses to start.
const keyFile = process.env.TLS_KEY_FILE;
const certFile = process.env.TLS_CERT_FILE;
if (!keyFile || !certFile) fail('Set TLS_KEY_FILE and TLS_CERT_FILE (issued by RealityEngine_CI scripts/lib/re_pki.py)');

const cssOrigin = process.env.CSS_ORIGIN || '';
if (!cssOrigin) fail('Set CSS_ORIGIN (assets-css), the only issuer people sign in with');
const dataDir = process.env.DATA_DIR || '/data';

// The service's own account on assets-css: seeded by CSS at start, its password
// a compose secret (scripts/up.js).
const accountFile = process.env.SERVICE_ACCOUNT_FILE || '/run/secrets/lifecycle-account';
if (!fs.existsSync(accountFile)) fail(`The service account file ${accountFile} is missing (scripts/up.js writes it)`);
const identity = serviceIdentity({
  cssBase: cssOrigin,
  account: JSON.parse(fs.readFileSync(accountFile, 'utf8')),
  credentialsFile: `${dataDir}/css-client-credentials.json`
});
let identityState = { status: 'provisioning' };

const server = createApp({
  tokens,
  store: new Store(process.env.DATA_FILE || `${dataDir}/state.json`),
  podOrigin: cssOrigin,
  registryFile: process.env.REGISTRY_FILE || '',
  secret: process.env.RECEIPT_SECRET || undefined,
  tls: { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) },
  verifyPerson: solidOidcVerifier({ issuers: [`${cssOrigin}/`] }),
  rolesFile: process.env.ROLES_FILE || '',
  capabilities: capabilityIssuer({ keyFile: `${dataDir}/capability-key.pem` }),
  identityStatus: () => identityState
});
server.listen(Number(process.env.PORT || 8443), '0.0.0.0');

// Provision the service identity, retrying while assets-css comes up. /health
// reports it; phase 3's pod reads need it.
for (let attempt = 1; ; attempt += 1) {
  try {
    await identity.provision();
    identityState = { status: 'ready', webId: identity.webId };
    console.log(`lifecycle: service identity ${identity.webId}`);
    break;
  } catch (e) {
    identityState = { status: 'error', error: e.message };
    if (attempt === 1 || attempt % 10 === 0) console.error(`lifecycle: service identity: ${e.message}`);
    await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * attempt)));
  }
}

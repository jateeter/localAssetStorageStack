import fs from 'node:fs';
import { createApp, Store } from './app.js';
import { MIN_SERVICE_TOKEN, capabilityIssuer, serviceIdentity, solidOidcVerifier } from './identity.js';
import { IntegrityError, eventLog, podClient, receiptSigner } from './integrity.js';
import { engineLink } from './engines.js';
import { inboxClient } from './inbox.js';

const fail = (message) => { console.error(message); process.exit(1); };

// Service tokens are for services only (ROADMAP phase 2): admin manages roles,
// registrar registers assets, engine runs frames' steps. People sign in with
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
if (process.env.RECEIPT_SECRET) console.warn('RECEIPT_SECRET is ignored: receipts are Ed25519, with the public key at /keys');
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
  tls: { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) },
  verifyPerson: solidOidcVerifier({ issuers: [`${cssOrigin}/`] }),
  rolesFile: process.env.ROLES_FILE || '',
  capabilities: capabilityIssuer({ keyFile: `${dataDir}/capability-key.pem` }),
  identityStatus: () => identityState,
  // Pod reads and writes go through the service's own DPoP identity; until it
  // is provisioned, they answer 503 rather than fail opaquely.
  // Each asset's inbox and its notification channel, as the service (ROADMAP
  // phase 5); like pod reads, it waits for the service identity.
  inbox: inboxClient({
    fetchImpl: (url, init) => {
      if (identityState.status !== 'ready') throw new IntegrityError(503, 'the service identity is not ready');
      return identity.fetch(url, init);
    }
  }),
  pod: podClient({
    fetchImpl: (url, init) => {
      if (identityState.status !== 'ready') throw new IntegrityError(503, 'the service identity is not ready');
      return identity.fetch(url, init);
    }
  }),
  receipts: receiptSigner({ keyFile: `${dataDir}/receipt-key.pem` }),
  log: eventLog({ file: `${dataDir}/events.jsonl` }),
  // Each event line on stdout too, for Loki (ROADMAP phase 10): RealityEngine_CI's
  // Promtail reads this container's log. LIFECYCLE_EVENT_LINES=off keeps them out.
  eventOut: process.env.LIFECYCLE_EVENT_LINES === 'off' ? null
    : (line) => process.stdout.write(`${JSON.stringify({ kind: 'lifecycle.event', ...line })}\n`),
  // The engines, through the RealityEngine instance registry when one is
  // configured (ROADMAP phase 11 supplies it): continuation rule 7 and frame
  // lanes (phase 6). Unconfigured, rule 7 answers 'unchecked' and lanes are
  // recorded 'unwired'.
  link: engineLink({
    registryUrl: process.env.RE_REGISTRY_URL || '',
    keyFile, certFile, caFile: process.env.NODE_EXTRA_CA_CERTS || ''
  })
});
server.listen(Number(process.env.PORT || 8443), '0.0.0.0');

// Provision the service identity, retrying while assets-css comes up. /health
// reports it; phase 3's pod reads need it.
for (let attempt = 1; ; attempt += 1) {
  try {
    await identity.provision();
    identityState = { status: 'ready', webId: identity.webId };
    console.log(`lifecycle: service identity ${identity.webId}`);
    server.inboxes?.start();
    break;
  } catch (e) {
    identityState = { status: 'error', error: e.message };
    if (attempt === 1 || attempt % 10 === 0) console.error(`lifecycle: service identity: ${e.message}`);
    await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * attempt)));
  }
}

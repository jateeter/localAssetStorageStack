// The stack's local-lane smoke test (ROADMAP phase 11), against a running
// stack (started by `node scripts/up.js` or RealityEngine_CI's
// `startUniverse.sh --assets`):
// - pod provisioning: every seeded person's pod and WebID, registration closed;
// - a pin read back from CSS: what the lifecycle pinned is what CSS serves;
// - addresses stable across a restart: the same pod URL and WebID, and the
//   lifecycle still holds the asset;
// - offline receipt verification, with nothing but the receipt and /keys.
//
//   node --dns-result-order=ipv4first scripts/smoke.js [report.json]
// with NODE_EXTRA_CA_CERTS set to the lane CA.
import { execFileSync } from 'node:child_process';
import { verifyReceipt } from '../lifecycle/src/integrity.js';
import { CSS, checks, config, lifecycle, person, request, root, until } from './lib/universe.js';

const cfg = config();
const lc = lifecycle(cfg);
const t = checks('asset-storage-smoke');

// Pod provisioning.
for (const pod of Object.keys(cfg.accounts)) {
  const r = await fetch(`${CSS}${pod}/profile/card`);
  t.check(`pod ${pod}: WebID served`, r.status === 200, `${CSS}${pod}/profile/card#me ${r.status}`);
}
const signup = await fetch(`${CSS}.account/account/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
t.check('registration is closed', signup.status === 404, signup.status);

// A pin read back from CSS.
const author = await person(cfg, Object.keys(cfg.accounts).find((p) => p !== 'lifecycle'));
const doc = `${author.webId.replace('profile/card#me', '')}assets/smoke-${Date.now()}.html`;
const put = await author.pod(doc, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<p>smoke</p>' });
t.check('the author writes a document in their assets/ container', put.status === 201, put.status);
const reg = await lc('POST', '/assets', 'registrar', { podUrl: doc, caseId: 'smoke', revision: 'r1' });
const head = await author.pod(doc, { method: 'HEAD' });
t.check('the lifecycle pinned what CSS serves (ETag)', reg.status === 201 && reg.body.current.etag === head.headers.get('etag'),
  `${reg.body?.current?.etag} vs ${head.headers.get('etag')}`);

// Offline receipt verification: the frame-built receipt, against /keys.
const frame = await lc('POST', '/frames', 'registrar', { documents: [{ assetId: reg.body.id }], preparer: author.webId,
  case: { delimiter: 'smoke' }, first: { next: { engineId: 'smoke', templateId: 'machine-smoke' } } });
const hist = await lc('GET', `/frames/${frame.body.frameId}/history`, 'engine');
const built = (hist.body || []).find((e) => e.type === 'frame.built');
const receipt = (await lc('GET', `/receipts/${built?.receiptId}`, 'engine')).body;
const keys = (await request('GET', new URL('/keys', cfg.lifecycleUrl).href)).body;
t.check('a receipt verifies offline with /keys alone', verifyReceipt(receipt, keys), receipt?.kid);
t.check('and a tampered one does not', !verifyReceipt({ ...receipt, preparer: 'someone-else' }, keys));
await lc('POST', `/frames/${frame.body.frameId}/abandon`, 'registrar', { reason: 'smoke test done' });

// Addresses stable across a restart.
const webIdBefore = author.webId;
// The stack's own compose project, whatever COMPOSE_PROJECT_NAME the caller has.
const { COMPOSE_PROJECT_NAME, ...composeEnv } = process.env;
execFileSync('docker', ['compose', 'restart', 'assets-css', 'lifecycle'], { cwd: root, stdio: 'ignore', env: composeEnv });
await until('the lifecycle is ready again', async () => {
  try { const h = await request('GET', new URL('/health', cfg.lifecycleUrl).href); return h.body?.identity?.status === 'ready'; } catch { return false; }
});
const after = await fetch(`${CSS}${webIdBefore.slice(CSS.length).replace('#me', '')}`);
t.check('after a restart the WebID is the same and served', after.status === 200, webIdBefore);
const again = await lc('GET', `/assets/${reg.body.id}`, 'engine');
t.check('after a restart the lifecycle holds the asset at the same pod URL', again.status === 200 && again.body.podUrl === doc, again.body?.podUrl);

process.exit(t.report(process.argv[2]) ? 1 : 0);

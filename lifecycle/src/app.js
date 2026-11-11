import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Raw, mountFrames } from './frames.js';
import { mountLanes } from './lanes.js';
import { workflowMetrics } from './metrics.js';
import { mountInbox } from './inbox.js';
import { reviewAccess } from './access.js';
import { IntegrityError, eventLog, receiptSigner, verifyReceipt } from './integrity.js';
import { AuthError, capabilityIssuer, isCapability, roleList, serviceTokens, solidOidcVerifier } from './identity.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const id = (p) => `${p}-${crypto.randomUUID()}`;
const now = () => new Date().toISOString();

// TLS under RealityEngine_CI config/transport-profile.json (RealityEngine_CI#668):
// TLS 1.3 only, the profile's AEAD suites, the post-quantum hybrid group first.
export const TLS_PROFILE = {
  minVersion: 'TLSv1.3',
  maxVersion: 'TLSv1.3',
  ciphers: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
  ecdhCurve: 'X25519MLKEM768:X25519:secp384r1'
};
export const tlsServerOptions = ({ key, cert }) => ({ ...TLS_PROFILE, key, cert });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const need = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };

export class Store {
  constructor(file) {
    this.file = file;
    this.d = { assets: {}, findings: {}, dispositions: {}, receipts: {}, roles: {}, frames: {}, heads: {} };
    if (file && fs.existsSync(file)) this.d = { ...this.d, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  save() {
    if (!this.file) return;
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.d));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}

function validPodUrl(u, allowedOrigin) {
  let p;
  try { p = new URL(u); } catch { return false; }
  return p.protocol === 'https:' && (!allowedOrigin || p.origin === allowedOrigin);
}

// Principals (ROADMAP phase 2): `tokens` holds the service tokens (admin,
// registrar, engine); people come from Solid-OIDC tokens checked by `verifyPerson`
// (solidOidcVerifier, trusting assets-css) with roles from `roles`; agents carry
// capability tokens from `capabilities`.
//
// Integrity (ROADMAP phase 3): `pod` (integrity.podClient) is how the service
// reads and writes pod documents itself; `receipts` (integrity.receiptSigner)
// signs every receipt with Ed25519 over RFC 8785; `log` (integrity.eventLog) is
// the append-only, fsynced history every change is written to before it is
// answered.
export function createApp({ tokens, store = new Store(), podOrigin = '', registryFile = '', tls = null,
  verifyPerson = null, rolesFile = '', capabilities = capabilityIssuer(), identityStatus = () => null,
  pod = null, receipts = receiptSigner(), log = eventLog(),
  // Whether an engine instance carries a template, for a continuation's rule 7:
  // 'carries', 'missing' or 'unchecked' (no instance registry configured).
  // Defaults to the engine link's answer.
  engineCheck = null,
  // The link to the engines through the instance registry (engines.js):
  // rule 7, reserved cells and the PE sources of frame lanes (phase 6).
  link = { configured: false },
  // Where each committed event line goes besides the log, for Loki (phase 10);
  // server.js writes it to stdout.
  eventOut = null,
  // The pods' side of the asset inboxes (inbox.inboxClient, ROADMAP phase 5):
  // dokieli's annotation notifications become findings. Unset, assets get no
  // inbox.
  inbox = null,
  // Review access (access.accessClient, ROADMAP phase 5; owner 2026-11-11):
  // the resuming role reads a frame's documents while it is parked for them.
  // serviceWebId is this service's WebID, kept on those ACLs. Unset, no ACL is
  // written.
  access = null, serviceWebId = () => null }) {
  engineCheck ||= link.configured ? (e, t) => link.carries(e, t) : async () => 'unchecked';
  const d = () => store.d;
  const receipt = (type, body) => {
    const r = receipts.sign({ id: id('rcpt'), type, issuedAt: now(), ...body });
    d().receipts[r.id] = r;
    return r;
  };
  // Who did it, for the history.
  const actor = (p) => (p.kind === 'person' ? p.webId : p.kind === 'agent' ? `${p.capability.sub}:${p.capability.frm}` : p.roles[0]);
  // The history first (fsynced), then the state snapshot: a crash between the
  // two leaves an event the snapshot lacks, never a change with no history.
  // Frames a change touched, so their lanes are re-pushed before it is answered.
  let touched = null;
  const metrics = workflowMetrics({ d, log });
  const commit = (event) => {
    const line = log.append(event);
    store.save();
    metrics.observe(line);
    if (eventOut) eventOut(line);
    if (touched && event.frameId) touched.add(event.frameId);
  };
  // Changes run one at a time (see the handler).
  let queue = Promise.resolve();
  const serial = (fn) => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };
  const inboxes = inbox ? mountInbox({ d, commit: (e) => commit(e), serial, now, id, sha256 }, inbox) : null;
  const readPod = async (url) => {
    need(pod, 503, 'the service cannot read pods (no service identity)');
    return pod.read(url);
  };
  const asset = (aid) => { const a = d().assets[aid]; need(a, 404, 'asset not found'); return a; };

  const serviceRole = serviceTokens(tokens);
  const roles = roleList({ file: rolesFile, overrides: d().roles });
  const holders = (role) => Object.entries(roles.all()).filter(([, rs]) => rs.includes(role)).map(([w]) => w);
  const reviews = access ? reviewAccess({ d, commit: (e) => commit(e), holders, serviceWebId }, access) : null;

  // Resolves the caller to one principal: { kind: 'service', roles: [role] },
  // { kind: 'person', webId, roles } or { kind: 'agent', capability }.
  const authenticate = async (req, path) => {
    const h = req.headers.authorization || '';
    if (h.startsWith('DPoP ')) {
      need(verifyPerson, 401, 'Solid-OIDC sign-in is not configured');
      const url = `${tls ? 'https' : 'http'}://${req.headers.host}${path}`;
      const { webId } = await verifyPerson({ authorization: h, dpop: req.headers.dpop, method: req.method, url });
      return { kind: 'person', webId, roles: roles.of(webId) };
    }
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    need(t, 401, 'unauthorized');
    if (isCapability(t)) return { kind: 'agent', roles: ['agent'], capability: capabilities.check(t) };
    const role = serviceRole(t);
    need(role, 401, 'unauthorized');
    return { kind: 'service', roles: [role] };
  };
  // `admin` manages roles and nothing else: it implies no other role.
  const allow = (principal, ...wanted) => need(principal.roles.some((r) => wanted.includes(r)), 403, 'forbidden');
  // A person's identity comes from the token, never the body: a body naming
  // someone else is refused.
  const self = (principal, claimed, field) => {
    need(claimed === undefined || claimed === null || claimed === principal.webId, 403, `${field} is taken from the sign-in token`);
    return principal.webId;
  };

  // Pins a revision from the pod itself (ROADMAP finding 2): the service reads
  // the document and records the ETag and the SHA-256 of the exact bytes. A
  // registrar may name the hash it expects; it must match what the pod holds.
  // Nothing the registrar sends is taken as the document.
  async function pin(a, { revision, content, hash }) {
    need(typeof revision === 'string' && revision, 400, 'revision required');
    need(content === undefined, 400, 'content is read from the pod, never sent');
    need(hash === undefined || /^[0-9a-f]{64}$/.test(hash), 400, 'hash must be a SHA-256 hex digest');
    // The inbox link first: writing it changes the ETag, which this pin then holds.
    if (inboxes) await inboxes.link(a);
    const read = await readPod(a.podUrl);
    need(hash === undefined || hash === read.hash, 409, 'hash does not match the pod');
    return { revision, hash: read.hash, etag: read.etag, pinnedAt: now() };
  }
  const applyPin = (a, pinned) => {
    a.revisions.push(pinned);
    a.current = { revision: pinned.revision, hash: pinned.hash, etag: pinned.etag };
  };

  const readRegistry = () => {
    need(registryFile, 503, 'instance registry unavailable');
    let registry;
    try {
      registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT' || e instanceof SyntaxError) throw new HttpError(503, 'instance registry unavailable');
      throw e;
    }
    need([1, 2].includes(registry?.schemaVersion) && registry.services && typeof registry.services === 'object', 503, 'instance registry unavailable');
    return [200, registry];
  };

  const routes = [];
  const route = (method, path, fn) => routes.push([method, new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn]);

  route('POST', '/assets', async ({ body, principal }) => {
    allow(principal, 'registrar');
    need(validPodUrl(body.podUrl, podOrigin), 400, 'podUrl invalid or outside configured CSS origin');
    need(body.caseId, 400, 'caseId required');
    const a = { id: id('asset'), podUrl: body.podUrl, caseId: body.caseId, authority: body.authority || null,
      dependencies: Array.isArray(body.dependencies) ? body.dependencies : [], revisions: [], current: null, createdAt: now() };
    const pinned = await pin(a, body);
    applyPin(a, pinned);
    d().assets[a.id] = a;
    commit({ type: 'asset.registered', assetId: a.id, podUrl: a.podUrl, caseId: a.caseId, by: actor(principal), pinned });
    return [201, a];
  });
  route('GET', '/assets', () => [200, Object.values(d().assets)]);
  route('GET', '/assets/:id', ({ params }) => [200, asset(params.id)]);
  route('POST', '/assets/:id/revisions', async ({ params, body, principal }) => {
    allow(principal, 'registrar');
    const a = asset(params.id);
    const pinned = await pin(a, body);
    applyPin(a, pinned);
    commit({ type: 'revision.pinned', assetId: a.id, by: actor(principal), pinned });
    onRepin(a.id, actor(principal));
    return [201, a];
  });
  route('GET', '/assets/:id/history', ({ params }) => { asset(params.id); return [200, log.read((e) => e.assetId === params.id)]; });
  // dokieli annotations become revision-specific findings.
  route('POST', '/assets/:id/annotations', ({ params, body, principal }) => {
    allow(principal, 'reviewer');
    const a = asset(params.id);
    need(body.revision === a.current.revision, 409, 'annotation targets a stale revision');
    need(typeof body.body === 'string' && body.body, 400, 'body required');
    const f = { id: id('finding'), assetId: a.id, revision: a.current.revision, author: self(principal, body.author, 'author'), motivation: body.motivation || 'commenting', body: body.body, target: body.target || null, createdAt: now() };
    d().findings[f.id] = f;
    commit({ type: 'finding.recorded', assetId: a.id, findingId: f.id, revision: f.revision, by: actor(principal) });
    return [201, f];
  });
  route('GET', '/assets/:id/annotations', ({ params }) => [200, Object.values(d().findings).filter((f) => f.assetId === params.id)]);
  // Record what the asset's inbox holds now, without waiting for its
  // notification channel (ROADMAP phase 5).
  route('POST', '/assets/:id/inbox/sweep', async ({ params, principal }) => {
    allow(principal, 'registrar', 'engine');
    const a = asset(params.id);
    need(inboxes && a.inbox, 409, 'the asset has no inbox');
    const made = await inboxes.sweepNow(a.id);
    return [200, { inbox: a.inbox, recorded: made.map((f) => f.id) }];
  });
  route('POST', '/assets/:id/dispositions', ({ params, body, principal }) => {
    allow(principal, 'reviewer');
    const a = asset(params.id);
    need(['accept', 'reject', 'rework', 'approve'].includes(body.decision), 400, 'invalid decision');
    need(body.revision === a.current.revision, 409, 'disposition targets a stale revision');
    const reviewer = self(principal, body.reviewer, 'reviewer');
    const prior = Object.values(d().dispositions).find((x) => x.assetId === a.id && x.revision === a.current.revision && x.reviewer === reviewer);
    need(!prior, 409, 'reviewer already dispositioned this revision');
    const x = { id: id('disp'), assetId: a.id, revision: a.current.revision, reviewer, decision: body.decision, findingIds: body.findingIds || [], createdAt: now() };
    d().dispositions[x.id] = x;
    commit({ type: 'disposition.recorded', assetId: a.id, dispositionId: x.id, revision: x.revision, decision: x.decision, by: actor(principal) });
    return [201, x];
  });
  // The assetID frame and its continuations (ROADMAP phase 4, frames.js).
  // `onRepin` is how a new pin reaches the frames that depend on the asset.
  let onRepin = () => {};
  const lanes = mountLanes({ route, need, allow, d, commit: (e) => commit(e), receipt, actor, now, link });
  onRepin = mountFrames({
    route, need, allow, d, commit: (e) => commit(e), receipt, asset, readPod, actor, engineCheck, now, id, sha256, log, capabilities, lanes,
    beforePin: (a) => (inboxes ? inboxes.link(a) : undefined),
    pod: { create: (...a) => { need(pod, 503, 'the service cannot write pods (no service identity)'); return pod.create(...a); },
           write: (...a) => { need(pod, 503, 'the service cannot write pods (no service identity)'); return pod.write(...a); } },
    applyPin: (a, pinned, opts) => { applyPin(a, pinned); onRepin(a.id, 'frame-step', opts); }
  });

  route('GET', '/roles', ({ principal }) => { allow(principal, 'admin'); return [200, roles.all()]; });
  route('PUT', '/roles', ({ body, principal }) => {
    allow(principal, 'admin');
    roles.set(body.webId, body.roles);
    commit({ type: 'roles.set', webId: body.webId, roles: roles.of(body.webId), by: actor(principal) });
    return [200, { webId: body.webId, roles: roles.of(body.webId) }];
  });
  // Whoever is calling, as this service sees them.
  route('GET', '/whoami', ({ principal }) => [200, principal.kind === 'agent'
    ? { kind: 'agent', principal: principal.capability.sub, frame: principal.capability.frm, continuation: principal.capability.knt }
    : { kind: principal.kind, webId: principal.webId, roles: principal.roles }]);
  route('GET', '/receipts/:id', ({ params }) => {
    const r = d().receipts[params.id];
    need(r, 404, 'receipt not found');
    return [200, r];
  });
  // The same check anyone can make offline with GET /keys.
  route('POST', '/receipts/:id/verify', ({ params }) => {
    const r = d().receipts[params.id];
    need(r, 404, 'receipt not found');
    return [200, { valid: verifyReceipt(r, receipts.jwks) }];
  });


  const handler = (req, res) => {
    const send = (s, o) => { const b = JSON.stringify(o); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 1e6) { send(413, { error: 'too large' }); req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      try {
        // Parsed against a fixed base: only the path and query are read.
        const requestUrl = new URL(req.url, 'https://lifecycle');
        const path = requestUrl.pathname;
        if (req.method === 'GET' && path === '/health') return send(200, { status: 'ok', identity: identityStatus() });
        // The receipt keys (Ed25519, JWKS): what an offline verifier needs.
        if (req.method === 'GET' && path === '/keys') return send(200, receipts.jwks);
        // The workflow in aggregate, for Prometheus (metrics.js): it names no
        // frame, asset or person, so it needs no sign-in, as /health does not.
        if (req.method === 'GET' && path === '/metrics') {
          const b = metrics.text();
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'content-length': Buffer.byteLength(b) });
          return res.end(b);
        }
        if (req.method === 'GET' && path === '/registry') {
          const [status, value] = readRegistry();
          return send(status, value);
        }
        const principal = await authenticate(req, path);
        const query = requestUrl.searchParams;
        // The pod proxy carries a document, not JSON.
        const raw = Buffer.concat(chunks);
        let body = {};
        if (path !== '/pod' && chunks.length) { try { body = JSON.parse(raw.toString()); } catch { throw new HttpError(400, 'invalid JSON'); } }
        need(body && typeof body === 'object' && !Array.isArray(body), 400, 'JSON object required');
        for (const [m, re, fn] of routes) {
          const match = re.exec(path);
          if (m === req.method && match) {
            // Changes run one at a time: a pod read sits between a change's
            // checks and its commit, and two interleaved there could both pass.
            const run = () => fn({ params: match.groups || {}, body, principal, query, raw, contentType: req.headers['content-type'] });
            const [s, o] = req.method === 'GET' ? await run() : await serial(async () => {
              touched = new Set();
              try {
                const out = await run();
                const frames = [...touched];
                touched = null;
                for (const fid of frames) await lanes.refresh(fid);
                for (const fid of frames) await reviews?.sync(fid);
                return out;
              } finally { touched = null; }
            });
            if (o instanceof Raw) {
              res.writeHead(s, { 'content-type': o.contentType, 'content-length': o.bytes.length, ...(o.etag ? { etag: o.etag } : {}) });
              return res.end(o.bytes);
            }
            return send(s, o);
          }
        }
        throw new HttpError(404, 'not found');
      } catch (e) {
        if (e instanceof HttpError || e instanceof AuthError || e instanceof IntegrityError) return send(e.status, { error: e.message });
        console.error(e);
        send(500, { error: 'internal error' });
      }
    });
  };
  // `tls` ({ key, cert }) serves HTTPS under the profile; without it the app is a
  // plain in-process handler, which only the unit tests use.
  const server = tls ? https.createServer(tlsServerOptions(tls), handler) : http.createServer(handler);
  // server.js starts the inbox watchers once the service identity is ready.
  server.inboxes = inboxes;
  server.reviews = reviews;
  server.on('close', () => inboxes?.stop());
  return server;
}

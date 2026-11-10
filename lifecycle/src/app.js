import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Raw, mountFrames } from './frames.js';
import { mountLanes } from './lanes.js';
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

// Guardrail classes: allowed actions and transitions bound to each machine at instantiation.
export const GUARDRAIL_CLASSES = {
  review: {
    actions: { extract: ['prepare'], prepare: ['check'], check: ['review', 'prepare'], review: ['publish', 'prepare'], publish: [] },
    initial: 'extract',
    scopes: { extract: ['pod:read'], prepare: ['pod:read', 'rag:read'], check: ['pod:read', 'beacon:read', 'rag:read'], review: ['pod:read', 'beacon:read'], publish: ['pod:read', 'pod:write'] }
  }
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const need = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };

export class Store {
  constructor(file) {
    this.file = file;
    this.d = { assets: {}, machines: {}, bindings: {}, proposals: {}, findings: {}, dispositions: {}, receipts: {}, roles: {}, frames: {}, heads: {} };
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
  link = { configured: false } }) {
  engineCheck ||= link.configured ? (e, t) => link.carries(e, t) : async () => 'unchecked';
  const d = () => store.d;
  const receipt = (type, body) => {
    const r = receipts.sign({ id: id('rcpt'), type, issuedAt: now(), ...body });
    d().receipts[r.id] = r;
    return r;
  };
  // Who did it, for the history.
  const actor = (p) => (p.kind === 'person' ? p.webId : p.kind === 'agent' ? `${p.capability.sub}:${p.capability.bnd}` : p.roles[0]);
  // The history first (fsynced), then the state snapshot: a crash between the
  // two leaves an event the snapshot lacks, never a change with no history.
  // Frames a change touched, so their lanes are re-pushed before it is answered.
  let touched = null;
  const commit = (event) => { log.append(event); store.save(); if (touched && event.frameId) touched.add(event.frameId); };
  const readPod = async (url) => {
    need(pod, 503, 'the service cannot read pods (no service identity)');
    return pod.read(url);
  };
  const asset = (aid) => { const a = d().assets[aid]; need(a, 404, 'asset not found'); return a; };
  const machine = (mid) => { const m = d().machines[mid]; need(m, 404, 'machine not found'); return m; };
  const binding = (bid) => { const b = d().bindings[bid]; need(b, 404, 'binding not found'); return b; };

  const serviceRole = serviceTokens(tokens);
  const roles = roleList({ file: rolesFile, overrides: d().roles });

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
    const read = await readPod(a.podUrl);
    need(hash === undefined || hash === read.hash, 409, 'hash does not match the pod');
    return { revision, hash: read.hash, etag: read.etag, pinnedAt: now() };
  }
  const applyPin = (a, pinned) => {
    a.revisions.push(pinned);
    a.current = { revision: pinned.revision, hash: pinned.hash, etag: pinned.etag };
    for (const m of Object.values(d().machines).filter((m) => m.assetId === a.id)) {
      m.staleRevision = m.pinned.revision !== pinned.revision;
    }
  };
  // Before a binding and before publish: the pod must still hold the pinned
  // bytes under the pinned ETag.
  async function unchangedSincePin(a) {
    const read = await readPod(a.podUrl);
    need(read.etag === a.current.etag && read.hash === a.current.hash, 409, 'pod changed since pin');
  }

  // Binding must reference current revision, machine generation and an allowed transition.
  function checkBinding(b, m, a) {
    need(m.status === 'active', 409, 'machine not active');
    need(!m.revoked, 403, 'machine revoked');
    need(b.generation === m.generation, 409, 'stale execution generation');
    need(b.revision === a.current.revision && b.hash === a.current.hash, 409, 'stale document revision');
  }

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
  route('POST', '/assets/:id/machines', ({ params, body, principal }) => {
    allow(principal, 'registrar');
    const a = asset(params.id);
    const cls = GUARDRAIL_CLASSES[body.guardrailClass || 'review'];
    need(cls, 400, 'unknown guardrail class');
    const m = { id: id('machine'), assetId: a.id, guardrailClass: body.guardrailClass || 'review', rules: cls, generation: 1,
      state: cls.initial, status: 'provisioning', revoked: false, staleRevision: false, pinned: { ...a.current }, createdAt: now() };
    d().machines[m.id] = m;
    commit({ type: 'machine.instantiated', assetId: a.id, machineId: m.id, by: actor(principal) });
    return [201, m];
  });
  // Bundle (triggers, PE sources, context policy, manifest) verified before observations are admitted.
  route('POST', '/machines/:id/verify', ({ params, body, principal }) => {
    allow(principal, 'registrar');
    const m = machine(params.id);
    need(m.status === 'provisioning', 409, 'machine not provisioning');
    need(body.manifestHash && body.manifestHash === sha256(JSON.stringify(body.manifest || {})), 400, 'manifest hash mismatch');
    m.status = 'active';
    m.manifestHash = body.manifestHash;
    commit({ type: 'machine.verified', assetId: m.assetId, machineId: m.id, manifestHash: m.manifestHash, by: actor(principal) });
    return [200, m];
  });
  route('POST', '/machines/:id/revoke', ({ params, principal }) => {
    allow(principal, 'registrar');
    const m = machine(params.id);
    m.revoked = true; m.status = 'revoked'; m.generation += 1;
    commit({ type: 'machine.revoked', assetId: m.assetId, machineId: m.id, generation: m.generation, by: actor(principal) });
    return [200, m];
  });
  route('GET', '/machines/:id', ({ params }) => [200, machine(params.id)]);

  // Step-binding receipt: ties the ISRE snapshot to the resulting OSRE recognition and exact asset revision.
  route('POST', '/machines/:id/bindings', async ({ params, body, principal }) => {
    allow(principal, 'engine');
    const m = machine(params.id);
    const a = asset(m.assetId);
    need(body.isreSnapshot && body.osreOutput, 400, 'isreSnapshot and osreOutput required');
    need(body.revision === a.current.revision && body.hash === a.current.hash, 409, 'stale document revision');
    need(body.generation === m.generation, 409, 'stale execution generation');
    need(m.status === 'active' && !m.revoked, 409, 'machine not active');
    need((m.rules.actions[m.state] || []).concat(m.state).includes(body.action) || body.action === m.state, 409, 'action not permitted');
    await unchangedSincePin(a);
    const b = { id: id('bind'), machineId: m.id, podUrl: a.podUrl, revision: a.current.revision, hash: a.current.hash,
      generation: m.generation, action: body.action, isreSnapshot: body.isreSnapshot, osreOutput: body.osreOutput,
      contextGrant: { scopes: m.rules.scopes[body.action] || [], podUrl: a.podUrl },
      predecessors: Array.isArray(body.predecessors) ? body.predecessors : [], status: 'dispatched', createdAt: now() };
    b.receipt = receipt('step-binding', { bindingId: b.id, machineId: m.id, podUrl: a.podUrl, revision: b.revision, hash: b.hash, etag: a.current.etag, isre: sha256(JSON.stringify(b.isreSnapshot)), osre: sha256(JSON.stringify(b.osreOutput)) }).id;
    d().bindings[b.id] = b;
    commit({ type: 'binding.created', assetId: a.id, machineId: m.id, bindingId: b.id, action: b.action, receiptId: b.receipt, by: actor(principal) });
    // The agent's capability for this binding (D8). It is returned once, to the
    // engine that dispatches the agent, and never stored or served again.
    return [201, { ...b, capability: capabilities.issue({ bindingId: b.id, scopes: b.contextGrant.scopes }) }];
  });
  route('GET', '/bindings/:id', ({ params }) => [200, binding(params.id)]);

  route('POST', '/bindings/:id/proposals', async ({ params, body, principal }) => {
    allow(principal, 'agent');
    need(principal.capability.bnd === params.id, 403, 'capability is for another binding');
    const b = binding(params.id);
    const m = machine(b.machineId);
    const a = asset(m.assetId);
    checkBinding(b, m, a);
    need(b.status === 'dispatched', 409, 'binding already completed');
    need(body.result !== undefined, 400, 'result required');
    // Publish is the one step that writes the pod: it must find the pinned bytes.
    if (b.action === 'publish') await unchangedSincePin(a);
    const p = Object.freeze({ id: id('prop'), bindingId: b.id, result: body.result, resultHash: sha256(JSON.stringify(body.result)), createdAt: now() });
    d().proposals[p.id] = p;
    b.status = 'completed';
    const next = m.rules.actions[b.action] || [];
    if (body.next !== undefined) {
      need(next.includes(body.next), 409, 'transition not permitted');
      m.state = body.next;
    } else if (next.length === 1) m.state = next[0];
    const r = receipt('proposal-commit', { proposalId: p.id, bindingId: b.id, resultHash: p.resultHash, machineState: m.state });
    commit({ type: 'proposal.committed', assetId: a.id, machineId: m.id, bindingId: b.id, proposalId: p.id, machineState: m.state, receiptId: r.id, by: actor(principal) });
    return [201, { proposal: p, receipt: r }];
  });

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
    ? { kind: 'agent', principal: principal.capability.sub, binding: principal.capability.bnd }
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

  let queue = Promise.resolve();
  const serial = (fn) => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };

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
  return tls ? https.createServer(tlsServerOptions(tls), handler) : http.createServer(handler);
}

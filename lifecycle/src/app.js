import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const id = (p) => `${p}-${crypto.randomUUID()}`;
const now = () => new Date().toISOString();

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
    this.d = { assets: {}, machines: {}, bindings: {}, proposals: {}, findings: {}, dispositions: {}, receipts: {} };
    if (file && fs.existsSync(file)) this.d = JSON.parse(fs.readFileSync(file, 'utf8'));
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
  return ['http:', 'https:'].includes(p.protocol) && (!allowedOrigin || p.origin === allowedOrigin);
}

export function createApp({ tokens, store = new Store(), podOrigin = '', secret = crypto.randomBytes(32), registryFile = '' }) {
  const d = () => store.d;
  const sign = (o) => crypto.createHmac('sha256', secret).update(JSON.stringify(o)).digest('hex');
  const receipt = (type, body) => {
    const r = { id: id('rcpt'), type, issuedAt: now(), ...body };
    r.signature = sign(r);
    d().receipts[r.id] = r;
    return r;
  };
  const asset = (aid) => { const a = d().assets[aid]; need(a, 404, 'asset not found'); return a; };
  const machine = (mid) => { const m = d().machines[mid]; need(m, 404, 'machine not found'); return m; };
  const binding = (bid) => { const b = d().bindings[bid]; need(b, 404, 'binding not found'); return b; };

  const authenticate = (req) => {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    const tb = Buffer.from(sha256(t));
    for (const [role, tok] of Object.entries(tokens)) {
      if (tok && crypto.timingSafeEqual(tb, Buffer.from(sha256(tok)))) return role;
    }
    return null;
  };
  const allow = (role, ...roles) => need(role === 'admin' || roles.includes(role), 403, 'forbidden');

  function pin(a, { revision, content, hash }) {
    need(typeof revision === 'string' && revision, 400, 'revision required');
    need(content !== undefined || /^[0-9a-f]{64}$/.test(hash || ''), 400, 'content or sha256 hash required');
    const h = content !== undefined ? sha256(String(content)) : hash;
    need(!hash || h === hash, 400, 'hash does not match content');
    a.revisions.push({ revision, hash: h, pinnedAt: now() });
    a.current = { revision, hash: h };
    for (const m of Object.values(d().machines).filter((m) => m.assetId === a.id)) {
      m.staleRevision = m.pinned.revision !== revision;
    }
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
    need(registry?.schemaVersion === 1 && registry.services && typeof registry.services === 'object', 503, 'instance registry unavailable');
    return [200, registry];
  };

  const routes = [];
  const route = (method, path, fn) => routes.push([method, new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn]);

  route('POST', '/assets', ({ body, role }) => {
    allow(role, 'registrar');
    need(validPodUrl(body.podUrl, podOrigin), 400, 'podUrl invalid or outside configured CSS origin');
    need(body.caseId, 400, 'caseId required');
    const a = { id: id('asset'), podUrl: body.podUrl, caseId: body.caseId, authority: body.authority || null,
      dependencies: Array.isArray(body.dependencies) ? body.dependencies : [], revisions: [], current: null, createdAt: now() };
    pin(a, body);
    d().assets[a.id] = a;
    store.save();
    return [201, a];
  });
  route('GET', '/assets', () => [200, Object.values(d().assets)]);
  route('GET', '/assets/:id', ({ params }) => [200, asset(params.id)]);
  route('POST', '/assets/:id/revisions', ({ params, body, role }) => {
    allow(role, 'registrar');
    const a = asset(params.id);
    pin(a, body);
    store.save();
    return [201, a];
  });
  route('POST', '/assets/:id/machines', ({ params, body, role }) => {
    allow(role, 'registrar');
    const a = asset(params.id);
    const cls = GUARDRAIL_CLASSES[body.guardrailClass || 'review'];
    need(cls, 400, 'unknown guardrail class');
    const m = { id: id('machine'), assetId: a.id, guardrailClass: body.guardrailClass || 'review', rules: cls, generation: 1,
      state: cls.initial, status: 'provisioning', revoked: false, staleRevision: false, pinned: { ...a.current }, createdAt: now() };
    d().machines[m.id] = m;
    store.save();
    return [201, m];
  });
  // Bundle (triggers, PE sources, context policy, manifest) verified before observations are admitted.
  route('POST', '/machines/:id/verify', ({ params, body, role }) => {
    allow(role, 'registrar');
    const m = machine(params.id);
    need(m.status === 'provisioning', 409, 'machine not provisioning');
    need(body.manifestHash && body.manifestHash === sha256(JSON.stringify(body.manifest || {})), 400, 'manifest hash mismatch');
    m.status = 'active';
    m.manifestHash = body.manifestHash;
    store.save();
    return [200, m];
  });
  route('POST', '/machines/:id/revoke', ({ params, role }) => {
    allow(role, 'registrar');
    const m = machine(params.id);
    m.revoked = true; m.status = 'revoked'; m.generation += 1;
    store.save();
    return [200, m];
  });
  route('GET', '/machines/:id', ({ params }) => [200, machine(params.id)]);

  // Step-binding receipt: ties the ISRE snapshot to the resulting OSRE recognition and exact asset revision.
  route('POST', '/machines/:id/bindings', ({ params, body, role }) => {
    allow(role, 'engine');
    const m = machine(params.id);
    const a = asset(m.assetId);
    need(body.isreSnapshot && body.osreOutput, 400, 'isreSnapshot and osreOutput required');
    need(body.revision === a.current.revision && body.hash === a.current.hash, 409, 'stale document revision');
    need(body.generation === m.generation, 409, 'stale execution generation');
    need(m.status === 'active' && !m.revoked, 409, 'machine not active');
    need((m.rules.actions[m.state] || []).concat(m.state).includes(body.action) || body.action === m.state, 409, 'action not permitted');
    const b = { id: id('bind'), machineId: m.id, podUrl: a.podUrl, revision: a.current.revision, hash: a.current.hash,
      generation: m.generation, action: body.action, isreSnapshot: body.isreSnapshot, osreOutput: body.osreOutput,
      contextGrant: { scopes: m.rules.scopes[body.action] || [], podUrl: a.podUrl },
      predecessors: Array.isArray(body.predecessors) ? body.predecessors : [], status: 'dispatched', createdAt: now() };
    b.receipt = receipt('step-binding', { bindingId: b.id, machineId: m.id, revision: b.revision, isre: sha256(JSON.stringify(b.isreSnapshot)), osre: sha256(JSON.stringify(b.osreOutput)) }).id;
    d().bindings[b.id] = b;
    store.save();
    return [201, b];
  });
  route('GET', '/bindings/:id', ({ params }) => [200, binding(params.id)]);

  route('POST', '/bindings/:id/proposals', ({ params, body, role }) => {
    allow(role, 'agent');
    const b = binding(params.id);
    const m = machine(b.machineId);
    checkBinding(b, m, asset(m.assetId));
    need(b.status === 'dispatched', 409, 'binding already completed');
    need(body.result !== undefined, 400, 'result required');
    const p = Object.freeze({ id: id('prop'), bindingId: b.id, result: body.result, resultHash: sha256(JSON.stringify(body.result)), createdAt: now() });
    d().proposals[p.id] = p;
    b.status = 'completed';
    const next = m.rules.actions[b.action] || [];
    if (body.next !== undefined) {
      need(next.includes(body.next), 409, 'transition not permitted');
      m.state = body.next;
    } else if (next.length === 1) m.state = next[0];
    const r = receipt('proposal-commit', { proposalId: p.id, bindingId: b.id, resultHash: p.resultHash, machineState: m.state });
    store.save();
    return [201, { proposal: p, receipt: r }];
  });

  // dokieli annotations become revision-specific findings.
  route('POST', '/assets/:id/annotations', ({ params, body, role }) => {
    allow(role, 'reviewer');
    const a = asset(params.id);
    need(body.revision === a.current.revision, 409, 'annotation targets a stale revision');
    need(typeof body.body === 'string' && body.body, 400, 'body required');
    const f = { id: id('finding'), assetId: a.id, revision: a.current.revision, author: body.author || null, motivation: body.motivation || 'commenting', body: body.body, target: body.target || null, createdAt: now() };
    d().findings[f.id] = f;
    store.save();
    return [201, f];
  });
  route('GET', '/assets/:id/annotations', ({ params }) => [200, Object.values(d().findings).filter((f) => f.assetId === params.id)]);
  route('POST', '/assets/:id/dispositions', ({ params, body, role }) => {
    allow(role, 'reviewer');
    const a = asset(params.id);
    need(['accept', 'reject', 'rework', 'approve'].includes(body.decision), 400, 'invalid decision');
    need(body.revision === a.current.revision, 409, 'disposition targets a stale revision');
    const prior = Object.values(d().dispositions).find((x) => x.assetId === a.id && x.revision === a.current.revision && x.reviewer === body.reviewer);
    need(!prior, 409, 'reviewer already dispositioned this revision');
    need(body.reviewer, 400, 'reviewer required');
    const x = { id: id('disp'), assetId: a.id, revision: a.current.revision, reviewer: body.reviewer, decision: body.decision, findingIds: body.findingIds || [], createdAt: now() };
    d().dispositions[x.id] = x;
    store.save();
    return [201, x];
  });
  route('GET', '/receipts/:id', ({ params }) => {
    const r = d().receipts[params.id];
    need(r, 404, 'receipt not found');
    return [200, r];
  });
  route('POST', '/receipts/:id/verify', ({ params }) => {
    const r = d().receipts[params.id];
    need(r, 404, 'receipt not found');
    const { signature, ...rest } = r;
    return [200, { valid: signature === sign(rest) }];
  });

  const server = http.createServer((req, res) => {
    const send = (s, o) => { const b = JSON.stringify(o); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 1e6) { send(413, { error: 'too large' }); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try {
        const path = new URL(req.url, 'http://x').pathname;
        if (req.method === 'GET' && path === '/health') return send(200, { status: 'ok' });
        if (req.method === 'GET' && path === '/registry') {
          const [status, value] = readRegistry();
          return send(status, value);
        }
        const role = authenticate(req);
        need(role, 401, 'unauthorized');
        let body = {};
        if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'invalid JSON'); } }
        need(body && typeof body === 'object' && !Array.isArray(body), 400, 'JSON object required');
        for (const [m, re, fn] of routes) {
          const match = re.exec(path);
          if (m === req.method && match) {
            const [s, o] = fn({ params: match.groups || {}, body, role });
            return send(s, o);
          }
        }
        throw new HttpError(404, 'not found');
      } catch (e) {
        if (e instanceof HttpError) return send(e.status, { error: e.message });
        console.error(e);
        send(500, { error: 'internal error' });
      }
    });
  });
  return server;
}

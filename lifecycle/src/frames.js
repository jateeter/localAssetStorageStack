// The assetID frame and its continuations (ROADMAP phase 4; localAssetStorageStack#13;
// RealityEngine_CI docs/CONTINUATIONS_APPROVAL_CHAIN.md, which is authoritative).
//
// A frame is the stack frame an agentic dispatch acts on. Its id is the
// assetID the engines' clone route is given. It holds:
// - `documents`: registered assets, each pinned (revision, SHA-256, ETag);
// - `action`, `arguments` and `return`;
// - the case keys (entity, period, asset type) that name its workflow head;
// - `upstreamRefs`: assets whose new revision makes the frame stale;
// - `continuations`: the append-only log, with `current` naming the live one.
//
// The rules (CONTINUATIONS_APPROVAL_CHAIN.md, "Rules that make it safe"):
// 1. a continuation names a template and an engine instance, never a clone;
// 2. one-shot: it resumes once, with its generation;
// 3. resumption needs the principal it names; never an agent, and an approver
//    is never the preparer;
// 4. pinned: a changed document takes the escape path, never the approve path;
// 5. delimited by the case; 6. every action is a receipt and a log event;
// 7. an engine instance that no longer carries the template takes the escape.
// No step chooses its successor (D10): capture records what the engine side
// recognised. Abandoning needs the case's abandon capability (D11 §3), and
// termination closes the workflow head (D11).

export const HEAD = Object.freeze({
  DRAFT: 'DRAFT', IN_REVIEW: 'IN_REVIEW', APPROVED: 'APPROVED', STALE: 'STALE', CLOSED: 'CLOSED', ABANDONED: 'ABANDONED'
});
// What an agent's frame capability may carry. Approve, record and publish are
// never among them: those are resumptions, and agents never resume.
export const AGENT_SCOPES = ['frame:read', 'frame:return', 'pod:read', 'pod:write'];
const DEFAULT_SCOPES = ['frame:read', 'frame:return', 'pod:read'];
const RESUMERS = ['engine', 'reviewer', 'author'];
const OPEN = (status) => status === 'captured' || status === 'parked';

export class Raw {
  constructor(bytes, contentType, etag) { this.bytes = bytes; this.contentType = contentType; this.etag = etag; }
}

const isWebId = (s) => { try { const u = new URL(s); return u.protocol === 'https:' && !!u.hash; } catch { return false; } };

export function mountFrames(ctx) {
  const { route, need, allow, d, commit, receipt, asset, readPod, pod, capabilities, actor, engineCheck, now, id, applyPin } = ctx;
  d().frames ||= {};
  d().heads ||= {};

  const frame = (fid) => { const f = d().frames[fid]; need(f, 404, 'frame not found'); return f; };
  const cont = (f, kid) => { const c = f.continuations.find((x) => x.continuationId === kid); need(c, 404, 'continuation not found'); return c; };
  const currentOf = (f) => f.continuations.find((x) => x.continuationId === f.current);
  const open = (f) => need(f.status === 'open', 409, `frame is ${f.status}`);
  const setHead = (f, status) => {
    f.headStatus = status;
    if (f.headKey) d().heads[f.headKey] = { frameId: f.frameId, status, at: now() };
  };
  const pins = (f) => f.documents.map(({ assetId, revision, sha256, etag }) => ({ assetId, revision, sha256, etag }));
  const primaryPin = (f) => ({ revision: f.documents[0].revision, sha256: f.documents[0].sha256 });
  // An agent reaches only its own frame, and only for the step it was given.
  const agentFrame = (principal, fid, scope) => {
    if (principal.kind !== 'agent') return false;
    need(principal.capability.frm === fid, 403, 'capability is for another frame');
    need(principal.capability.scope.split(' ').includes(scope), 403, `capability lacks ${scope}`);
    return true;
  };

  function checkNext(next) {
    need(next && typeof next.engineId === 'string' && next.engineId && typeof next.templateId === 'string' && next.templateId,
      400, 'next must name an engineId and a templateId');
    // Rule 1: a clone id is <machineId>.<instance>.<envelope>; machine ids hold no dot.
    need(!next.templateId.includes('.'), 400, 'a continuation names a template, never a clone');
    return { engineId: next.engineId, templateId: next.templateId };
  }
  function checkResumer(f, resumableBy) {
    need(resumableBy && RESUMERS.includes(resumableBy.role), 400, `resumableBy.role must be one of ${RESUMERS.join(', ')}`);
    const out = { role: resumableBy.role };
    if (resumableBy.role !== 'engine') {
      // A person's step: the approver is never the preparer unless told otherwise
      // explicitly, and an explicit identity must be a WebID.
      const ex = resumableBy.excludeIdentity === undefined || resumableBy.excludeIdentity === 'preparer' ? f.preparer : resumableBy.excludeIdentity;
      need(ex === null || isWebId(ex), 400, 'excludeIdentity must be a WebID or "preparer"');
      out.excludeIdentity = ex;
    }
    return out;
  }
  function checkScopes(scopes) {
    if (scopes === undefined) return [...DEFAULT_SCOPES];
    need(Array.isArray(scopes) && scopes.every((s) => AGENT_SCOPES.includes(s)), 400, `scopes must be drawn from ${AGENT_SCOPES.join(', ')}`);
    return [...new Set(scopes)];
  }

  function record(f, spec, generation, status, extra = {}) {
    const c = {
      continuationId: `k${f.continuations.length}`,
      assetId: f.frameId,
      delimiter: f.case.delimiter,
      next: spec.next,
      resumableBy: spec.resumableBy,
      scopes: spec.scopes,
      pinned: { ...primaryPin(f), documents: pins(f) },
      generation,
      onStale: spec.onStale,
      status,
      capturedAt: now(),
      ...extra
    };
    f.continuations.push(c);
    f.current = c.continuationId;
    return c;
  }
  const maxGeneration = (f) => Math.max(...f.continuations.map((x) => x.generation));

  // The escape path (rules 4 and 7, a stale upstream, rework): supersede the
  // pending continuation and re-enter at its onStale target, as a fresh record.
  function escape(f, c, reason, by, headStatus = HEAD.STALE) {
    c.status = 'superseded';
    c.supersededAt = now();
    c.supersededReason = reason;
    const target = cont(f, c.onStale);
    const k = record(f, { next: target.next, resumableBy: target.resumableBy, scopes: target.scopes, onStale: target.onStale },
      maxGeneration(f) + 1, 'captured', { escapedFrom: c.continuationId, reason });
    setHead(f, headStatus);
    const r = receipt('continuation-escaped', { frameId: f.frameId, superseded: c.continuationId, generation: c.generation, continuationId: k.continuationId, reason, by });
    commit({ type: 'continuation.escaped', assetId: f.frameId, frameId: f.frameId, superseded: c.continuationId, continuationId: k.continuationId, reason, by, receiptId: r.id });
    return { outcome: 'escape', reason, superseded: c.continuationId, continuation: k, receipt: r.id };
  }

  // Rule 4: every pinned document must still be what the pod holds.
  async function pinnedHolds(c) {
    for (const p of c.pinned.documents) {
      const read = await readPod(asset(p.assetId).podUrl);
      if (read.etag !== p.etag || read.hash !== p.sha256) return false;
    }
    return true;
  }

  // ── build ──────────────────────────────────────────────────────────────────
  route('POST', '/frames', async ({ body, principal }) => {
    allow(principal, 'engine', 'registrar');
    need(Array.isArray(body.documents) && body.documents.length, 400, 'documents required');
    need(isWebId(body.preparer), 400, 'preparer must be a WebID');
    const kase = body.case || {};
    need(typeof kase.delimiter === 'string' && kase.delimiter, 400, 'case.delimiter required');
    const keyed = ['entity', 'period', 'assetType'].filter((k) => kase[k] !== undefined);
    need(keyed.length === 0 || keyed.length === 3, 400, 'case keys come together: entity, period and assetType');
    const headKey = keyed.length ? `${kase.entity}|${kase.period}|${kase.assetType}` : null;
    if (headKey) {
      const head = d().heads[headKey];
      need(!head || head.status === HEAD.CLOSED || head.status === HEAD.ABANDONED, 409, `the workflow head ${headKey} has an open frame (${head?.frameId})`);
    }
    const documents = [];
    for (const doc of body.documents) {
      const a = asset(doc.assetId);
      need(a.current, 409, `asset ${a.id} has no pinned revision`);
      const read = await readPod(a.podUrl);
      need(read.etag === a.current.etag && read.hash === a.current.hash, 409, 'pod changed since pin');
      documents.push({ assetId: a.id, uri: a.podUrl, tag: doc.tag || null, revision: a.current.revision, sha256: a.current.hash,
        etag: a.current.etag, permissions: doc.permissions || [], authority: doc.authority ?? a.authority, identification: doc.identification || null });
    }
    const upstreamRefs = (Array.isArray(body.upstreamRefs) ? body.upstreamRefs : []).map((ref) => {
      const a = asset(ref);
      return { assetId: a.id, revision: a.current?.revision ?? null };
    });
    const f = {
      frameId: id('frame'), case: { delimiter: kase.delimiter, entity: kase.entity ?? null, period: kase.period ?? null, assetType: kase.assetType ?? null },
      headKey, preparer: body.preparer, documents, upstreamRefs, action: body.action ?? null, arguments: body.arguments ?? null,
      return: null, continuations: [], current: null, status: 'open', headStatus: null, pointer: null, createdAt: now(),
      // What the frame's lanes report (lanes.js): set as the observations happen.
      observed: { pinned: false, approved: false, rework: false }
    };
    const first = body.first || {};
    const spec = { next: checkNext(first.next), resumableBy: checkResumer(f, first.resumableBy || { role: 'engine' }), scopes: checkScopes(first.scopes), onStale: 'k0' };
    record(f, spec, 1, 'captured');
    setHead(f, HEAD.DRAFT);
    // D10: the assetID's pod document holds a pointer to the frame, beside the
    // primary document. A pointer that cannot be written is recorded, not hidden.
    const primary = new URL(documents[0].uri);
    const pointerUrl = new URL(`${f.frameId}.json`, primary).href;
    try {
      await pod.create(pointerUrl, Buffer.from(JSON.stringify({ frameId: f.frameId, frame: `/frames/${f.frameId}`, documents: documents.map((x) => x.uri) })), { contentType: 'application/json' });
      f.pointer = { url: pointerUrl };
    } catch (e) { f.pointer = { url: pointerUrl, error: e.message }; }
    d().frames[f.frameId] = f;
    const by = actor(principal);
    const r = receipt('frame-built', { frameId: f.frameId, headKey, preparer: f.preparer, documents: pins(f), continuationId: 'k0', generation: 1, by });
    commit({ type: 'frame.built', assetId: f.frameId, frameId: f.frameId, headKey, documents: pins(f), by, receiptId: r.id });
    return [201, f];
  });

  route('GET', '/frames/:id', ({ params, principal }) => {
    agentFrame(principal, params.id, 'frame:read');
    return [200, frame(params.id)];
  });
  route('GET', '/frames/:id/history', ({ params, principal }) => {
    need(principal.kind !== 'agent', 403, 'forbidden');
    frame(params.id);
    return [200, ctx.log.read((e) => e.frameId === params.id)];
  });
  route('GET', '/heads', ({ principal }) => { need(principal.kind !== 'agent', 403, 'forbidden'); return [200, d().heads]; });

  // ── the step's return ───────────────────────────────────────────────────────
  route('PUT', '/frames/:id/return', ({ params, body, principal }) => {
    const f = frame(params.id);
    open(f);
    const c = currentOf(f);
    if (agentFrame(principal, f.frameId, 'frame:return')) {
      need(principal.capability.knt === c.continuationId && c.status === 'resumed', 403, 'capability is for another step');
    } else allow(principal, 'engine');
    need(body.return !== undefined, 400, 'return required');
    f.return = body.return;
    const r = receipt('frame-return', { frameId: f.frameId, continuationId: c.continuationId, returnHash: ctx.sha256(JSON.stringify(body.return)), by: actor(principal) });
    commit({ type: 'frame.return', assetId: f.frameId, frameId: f.frameId, continuationId: c.continuationId, by: actor(principal), receiptId: r.id });
    return [200, { frameId: f.frameId, return: f.return, receipt: r.id }];
  });

  // ── capture (the epilogue) ────────────────────────────────────────────────────
  route('POST', '/frames/:id/continuations', ({ params, body, principal }) => {
    allow(principal, 'engine');
    const f = frame(params.id);
    open(f);
    const c = currentOf(f);
    need(c.status === 'resumed', 409, `the current continuation ${c.continuationId} is ${c.status}, not resumed: no step ran`);
    const by = actor(principal);
    // An upstream or document changed while the step ran: the step's outcome is
    // superseded before it is recorded.
    if (f.staleWhileRunning) {
      const reason = f.staleWhileRunning;
      delete f.staleWhileRunning;
      return [200, escape(f, c, reason, by)];
    }
    const onStale = body.onStale ?? 'k0';
    cont(f, onStale);
    const spec = { next: checkNext(body.next), resumableBy: checkResumer(f, body.resumableBy || { role: 'engine' }), scopes: checkScopes(body.scopes), onStale };
    const k = record(f, spec, maxGeneration(f) + 1, body.park ? 'parked' : 'captured');
    if (body.park && spec.resumableBy.role !== 'engine') setHead(f, HEAD.IN_REVIEW);
    const r = receipt(body.park ? 'continuation-parked' : 'continuation-captured', { frameId: f.frameId, after: c.continuationId, continuationId: k.continuationId, generation: k.generation, next: k.next, resumableBy: k.resumableBy, pinned: k.pinned, by });
    commit({ type: body.park ? 'continuation.parked' : 'continuation.captured', assetId: f.frameId, frameId: f.frameId, continuationId: k.continuationId, generation: k.generation, by, receiptId: r.id });
    return [201, { continuation: k, receipt: r.id }];
  });

  // ── resume (the prologue, or a reviewer's decision) ─────────────────────────────
  route('POST', '/frames/:id/continuations/:kid/resume', async ({ params, body, principal }) => {
    const f = frame(params.id);
    open(f);
    const c = cont(f, params.kid);
    need(c.status !== 'resumed', 409, 'continuation already resumed');
    need(c.status !== 'superseded', 409, 'continuation superseded');
    need(OPEN(c.status) && f.current === c.continuationId, 409, `continuation is ${c.status}`);
    need(Number.isInteger(body.generation), 400, 'generation required');
    need(body.generation === c.generation, 409, `generation ${body.generation} is not the continuation's (${c.generation})`);
    // Rule 3: the principal it names; never an agent.
    need(principal.kind !== 'agent', 403, 'an agent never resumes a continuation');
    const { role, excludeIdentity } = c.resumableBy;
    if (role === 'engine') allow(principal, 'engine');
    else {
      need(principal.kind === 'person', 403, `continuation is resumed by a ${role}`);
      allow(principal, role);
      need(!excludeIdentity || principal.webId !== excludeIdentity, 403, 'the approver must not be the preparer');
    }
    const by = actor(principal);
    // Rule 4: pinned.
    if (!(await pinnedHolds(c))) return [200, escape(f, c, 'pod changed since pin', by)];
    // A person's step is a decision.
    if (role !== 'engine') {
      need(['approve', 'rework'].includes(body.decision), 400, 'decision must be approve or rework');
      const primary = f.documents[0];
      const x = { id: id('disp'), assetId: primary.assetId, frameId: f.frameId, revision: c.pinned.revision, sha256: c.pinned.sha256,
        reviewer: principal.webId, decision: body.decision, findingIds: Array.isArray(body.findingIds) ? body.findingIds : [], createdAt: now() };
      d().dispositions[x.id] = x;
      commit({ type: 'disposition.recorded', assetId: primary.assetId, frameId: f.frameId, dispositionId: x.id, revision: x.revision, decision: x.decision, by });
      if (body.decision === 'rework') { f.observed.rework = true; return [200, escape(f, c, 'rework', by, HEAD.DRAFT)]; }
    }
    // Rule 7: the named engine instance must still carry the template.
    const carried = await engineCheck(c.next.engineId, c.next.templateId);
    if (carried === 'missing') return [200, escape(f, c, `engine ${c.next.engineId} does not carry ${c.next.templateId}`, by)];
    c.status = 'resumed';
    c.resumedAt = now();
    c.resumedBy = by;
    f.observed.rework = false;
    if (role !== 'engine') { c.decision = body.decision; f.observed.approved = true; setHead(f, HEAD.APPROVED); }
    const r = receipt('continuation-resumed', { frameId: f.frameId, continuationId: c.continuationId, generation: c.generation, pinned: c.pinned, next: c.next, decision: c.decision ?? null, engineCheck: carried, by });
    commit({ type: 'continuation.resumed', assetId: f.frameId, frameId: f.frameId, continuationId: c.continuationId, generation: c.generation, engineCheck: carried, by, receiptId: r.id });
    const out = { outcome: 'resume', next: c.next, continuation: c, engineCheck: carried, receipt: r.id };
    // The step's agent capability, once, to the engine side that dispatches it.
    if (role === 'engine') out.capability = capabilities.issue({ frameId: f.frameId, continuationId: c.continuationId, scopes: c.scopes });
    return [200, out];
  });

  route('POST', '/frames/:id/continuations/:kid/supersede', ({ params, body, principal }) => {
    allow(principal, 'engine');
    const f = frame(params.id);
    open(f);
    const c = cont(f, params.kid);
    need(f.current === c.continuationId && OPEN(c.status), 409, `continuation is ${c.status}`);
    need(typeof body.reason === 'string' && body.reason, 400, 'reason required');
    return [200, escape(f, c, body.reason, actor(principal))];
  });

  // ── abandon and close ────────────────────────────────────────────────────────────
  // The case's abandon capability: the preparer, or registrar automation. Never
  // an agent, never the engine side.
  route('POST', '/frames/:id/abandon', async ({ params, body, principal }) => {
    const f = frame(params.id);
    open(f);
    const holds = (principal.kind === 'person' && principal.webId === f.preparer) || (principal.kind === 'service' && principal.roles.includes('registrar'));
    need(holds, 403, "abandoning needs the case's abandon capability");
    need(typeof body.reason === 'string' && body.reason, 400, 'reason required');
    const c = currentOf(f);
    c.status = 'abandoned';
    f.status = 'abandoned';
    setHead(f, HEAD.ABANDONED);
    const by = actor(principal);
    await ctx.lanes.releaseFrame(f.frameId, by, 'abandoned');
    const r = receipt('frame-abandoned', { frameId: f.frameId, continuationId: c.continuationId, generation: c.generation, reason: body.reason, by });
    commit({ type: 'frame.abandoned', assetId: f.frameId, frameId: f.frameId, continuationId: c.continuationId, generation: c.generation, reason: body.reason, by, receiptId: r.id });
    return [200, { frame: f, receipt: r.id }];
  });
  // Termination (D11): the step that ran was the last; the frame and its
  // workflow head close together.
  route('POST', '/frames/:id/close', async ({ params, principal }) => {
    allow(principal, 'engine');
    const f = frame(params.id);
    open(f);
    const c = currentOf(f);
    need(c.status === 'resumed', 409, `the current continuation ${c.continuationId} is ${c.status}: only a step that ran can terminate`);
    c.status = 'closed';
    f.status = 'closed';
    f.closedAt = now();
    setHead(f, HEAD.CLOSED);
    const by = actor(principal);
    // Termination (D11): the frame's lanes go with it.
    await ctx.lanes.releaseFrame(f.frameId, by, 'closed');
    const r = receipt('frame-closed', { frameId: f.frameId, headKey: f.headKey, continuationId: c.continuationId, generation: c.generation, return: f.return === null ? null : ctx.sha256(JSON.stringify(f.return)), by });
    commit({ type: 'frame.closed', assetId: f.frameId, frameId: f.frameId, headKey: f.headKey, by, receiptId: r.id });
    return [200, { frame: f, receipt: r.id }];
  });

  // ── the /pod proxy: an agent's only way to a document (D5) ───────────────────────
  route('GET', '/pod', async ({ query, principal }) => {
    const { f, doc } = frameDocument(principal, query.get('url'), 'pod:read');
    const read = await readPod(doc.uri);
    need(read.etag === doc.etag && read.hash === doc.sha256, 409, 'pod changed since pin');
    commit({ type: 'pod.read', assetId: f.frameId, frameId: f.frameId, uri: doc.uri, by: actor(principal) });
    return [200, new Raw(read.bytes, read.contentType, read.etag)];
  });
  route('PUT', '/pod', async ({ query, raw, contentType, principal }) => {
    const { f, doc } = frameDocument(principal, query.get('url'), 'pod:write');
    const written = await pod.write(doc.uri, raw, { ifMatch: doc.etag, contentType: contentType || 'application/octet-stream' });
    // The frame's own write: re-pin it here, so the frame does not read its own
    // step as a stale document. Other frames that reference the asset do.
    const a = asset(doc.assetId);
    const read = await readPod(doc.uri);
    const pinned = { revision: `${doc.revision}+${f.current}`, hash: read.hash, etag: read.etag, pinnedAt: now() };
    applyPin(a, pinned, { except: f.frameId });
    Object.assign(doc, { revision: pinned.revision, sha256: pinned.hash, etag: pinned.etag });
    f.observed.pinned = true;
    const r = receipt('pod-written', { frameId: f.frameId, continuationId: f.current, uri: doc.uri, revision: pinned.revision, sha256: pinned.hash, etag: written.etag ?? read.etag, by: actor(principal) });
    commit({ type: 'pod.written', assetId: doc.assetId, frameId: f.frameId, uri: doc.uri, revision: pinned.revision, by: actor(principal), receiptId: r.id });
    return [200, { uri: doc.uri, revision: pinned.revision, sha256: pinned.hash, etag: pinned.etag, receipt: r.id }];
  });
  function frameDocument(principal, url, scope) {
    need(principal.kind === 'agent' && principal.capability.frm, 403, 'the pod proxy serves agents acting on a frame');
    need(typeof url === 'string' && url, 400, 'url required');
    const f = frame(principal.capability.frm);
    open(f);
    agentFrame(principal, f.frameId, scope);
    need(principal.capability.knt === f.current && currentOf(f).status === 'resumed', 403, 'capability is for another step');
    const doc = f.documents.find((x) => x.uri === url);
    need(doc, 403, 'not a document of this frame');
    return { f, doc };
  }

  // ── staleness: a new revision of a frame document or an upstream ref ──────────────
  // Called by the revision route once the new pin is applied. Rule 4 by another
  // road: the open frames that depend on the asset take the escape path now,
  // rather than discovering it at resume.
  return function onRepin(assetId, by, { except } = {}) {
    const a = asset(assetId);
    for (const f of Object.values(d().frames)) {
      if (f.status !== 'open' || f.frameId === except) continue;
      const doc = f.documents.find((x) => x.assetId === assetId);
      const up = f.upstreamRefs.find((x) => x.assetId === assetId);
      if (!doc && !up) continue;
      if (doc) { Object.assign(doc, { revision: a.current.revision, sha256: a.current.hash, etag: a.current.etag }); f.observed.pinned = true; }
      if (up) up.revision = a.current.revision;
      const reason = doc ? `document ${assetId} re-pinned at ${a.current.revision}` : `upstream ${assetId} re-pinned at ${a.current.revision}`;
      const c = currentOf(f);
      if (OPEN(c.status)) escape(f, c, reason, by);
      else {
        // A step is running: it is superseded when it is captured. Recorded
        // now, so the history (and the frame's lanes) show the stale head.
        f.staleWhileRunning = reason;
        setHead(f, HEAD.STALE);
        commit({ type: 'frame.stale', assetId: f.frameId, frameId: f.frameId, continuationId: c.continuationId, reason, by });
      }
    }
  };
}

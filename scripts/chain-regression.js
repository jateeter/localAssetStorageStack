// The IFRS approval chain on every voting engine, compared 3-of-3 (ROADMAP
// phase 11; RealityEngine_CI#715). It needs a universe with this stack and
// Manager's instantiation component running (RealityEngine_CI
// `startUniverse.sh --assets`), and drives only what a person or registrar
// would; Manager runs every step.
//
// On each voting engine (cpp, lsp, scala from the instance registry):
// - prepare on IFRS_Sec01_GeneralPurposeFS_Verifier parks the successor
//   IFRS_Sec03_Compliance_Assertion_Arbiter for review, holding no block;
// - approver ≠ preparer: a frame the reviewer prepared cannot be approved by
//   the same reviewer;
// - an annotation announced to the document's inbox, as dokieli sends it, is a
//   finding on the parked frame and resumes nothing (phase 5);
// - the reviewer approves; a replayed approval is refused;
// - the arbiter step runs and termination closes the frame and its head;
// - a stale upstream takes the escape path;
// - clone.maxActive + 1 actions show the pool limit, and after every recycle
//   the pool is as it was.
// Each engine's outcome is reduced to what must agree, and the three must be
// identical: the rule is compared, not any one engine's answer.
//
//   node --dns-result-order=ipv4first scripts/chain-regression.js [report.json]
import { checks, config, lifecycle, person, request, until } from './lib/universe.js';

const cfg = config();
const lc = lifecycle(cfg);
const t = checks('asset-workflow-chain');
const tls = cfg.harness;
const T1 = 'machine-ifrs-sec01-generalpurposefs-verifier';
const T2 = 'machine-ifrs-sec03-compliance-assertion-arbiter';
const VOTERS = ['cpp', 'lsp', 'scala'];
const run = Date.now().toString(36);

const registry = (await request('GET', cfg.registryUrl, { tls })).body;
const engines = VOTERS.map((rt) => (registry.instances || []).find((i) => i.runtime === rt && (i.status ?? 'running') === 'running' && i.role !== 'follower'));
if (engines.some((e) => !e)) {
  console.log(`SKIP  3-of-3 needs cpp, lsp and scala; the instance registry lists ${(registry.instances || []).map((i) => i.id).join(', ')}`);
  process.exit(t.report(process.argv[2], { status: 'skipped' }) ? 1 : 0);
}
const people = Object.keys(cfg.accounts).filter((p) => p !== 'lifecycle');
const roles = (await lc('GET', '/roles', 'admin')).body;
const pick = (role) => people.find((p) => (roles[`https://assets-css.localhost:13443/${p}/profile/card#me`] || []).includes(role));
const author = await person(cfg, pick('author'));
const reviewer = await person(cfg, pick('reviewer'));

const frame = async (fid) => (await lc('GET', `/frames/${fid}`, 'engine')).body;
const last = (f) => f.continuations[f.continuations.length - 1];
const clonesOf = async (e, fid) => ((await request('GET', `${e.re_url}/api/engine/clones`, { tls })).body.clones || []).filter((c) => !fid || c.assetId === fid);
async function newAsset(name) {
  const doc = `${author.webId.replace('profile/card#me', '')}assets/${name}-${run}.html`;
  await author.pod(doc, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: `<p>${name}</p>` });
  return { doc, asset: (await lc('POST', '/assets', 'registrar', { podUrl: doc, caseId: `chain-${run}`, revision: 'r1' })).body };
}
const assetOf = {};
async function build(e, { preparer, upstreamRefs = [], entity }) {
  const { doc, asset } = await newAsset(`ifrs-${e.id}-${entity}`);
  const r = await lc('POST', '/frames', 'registrar', { documents: [{ assetId: asset.id }], preparer: preparer.webId, upstreamRefs,
    case: { delimiter: 'ifrs-approval-case', entity: `${entity}-${e.id}-${run}`, period: '2026-Q4', assetType: 'COMPLIANCE-REVIEW' },
    action: 'prepare', first: { next: { engineId: e.id, templateId: T1 } } });
  if (r.status !== 201) throw new Error(`${e.id}: frame refused ${r.status} ${JSON.stringify(r.body)}`);
  assetOf[r.body.frameId] = { doc, asset };
  return r.body.frameId;
}
const parkedK = (k) => async (fid) => { const f = await frame(fid); const c = last(f); return c.status === 'parked' && c.continuationId === k ? f : null; };
const resume = (fid, k, who, body) => lc('POST', `/frames/${fid}/continuations/${k}/resume`, who, body);
const types = async (fid) => (await lc('GET', `/frames/${fid}/history`, 'engine')).body.map((x) => x.type);

const outcomes = {};
for (const e of engines) {
  const o = {};
  // The chain.
  const a = await build(e, { preparer: author, entity: 'A' });
  const parked = await until(`${e.id}: prepare parks`, () => parkedK('k1')(a));
  o.parked = { next: last(parked).next.templateId, head: parked.headStatus, role: last(parked).resumableBy.role };
  o.blocksWhileParked = (await clonesOf(e, a)).length;
  // An annotation on the document under review, announced to its inbox as
  // dokieli's notifyInbox sends it: a finding on the frame, never a resume.
  const { doc: aDoc, asset: aAsset } = assetOf[a];
  const sent = await reviewer.pod(aAsset.inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' },
    body: JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', type: 'Announce', actor: reviewer.webId,
      object: `${reviewer.webId.replace('profile/card#me', '')}annotations/${run}-${e.id}`, inReplyTo: aDoc, summary: 'approve' }) });
  const noted = await until(`${e.id}: the inbox annotation is a finding on the frame`, async () =>
    ((await lc('GET', `/frames/${a}/history`, 'engine')).body.some((x) => x.type === 'finding.recorded') ? true : null), 30);
  const still = last(await frame(a));
  o.inbox = { posted: sent.status, finding: noted, stillParked: still.status === 'parked' && still.continuationId === 'k1' };
  // Approver ≠ preparer.
  const b = await build(e, { preparer: reviewer, entity: 'B' });
  await until(`${e.id}: B parks`, () => parkedK('k1')(b));
  const self = await resume(b, 'k1', reviewer, { generation: 2, decision: 'approve' });
  o.approveByPreparer = { status: self.status, error: self.body?.error };
  await lc('POST', `/frames/${b}/abandon`, reviewer, { reason: 'regression: approver-is-preparer case done' });
  // Approve, replay, termination.
  const ok = await resume(a, 'k1', reviewer, { generation: 2, decision: 'approve' });
  const replay = await resume(a, 'k1', reviewer, { generation: 2, decision: 'approve' });
  o.approve = { status: ok.status, outcome: ok.body?.outcome };
  o.replay = { status: replay.status, error: replay.body?.error };
  const closed = await until(`${e.id}: the approved step terminates`, async () => { const f = await frame(a); return f.status === 'closed' ? f : null; });
  o.closed = { head: closed.headStatus, lastReturnTemplate: closed.return?.template, history: (await types(a)).filter((x) => x !== 'pod.read') };
  o.blocksAfterClose = (await clonesOf(e, a)).length;
  // A stale upstream takes the escape path.
  const { doc: upDoc, asset: up } = await newAsset(`upstream-${e.id}`);
  const c = await build(e, { preparer: author, upstreamRefs: [up.id], entity: 'C' });
  await until(`${e.id}: C parks`, () => parkedK('k1')(c));
  await author.pod(upDoc, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<p>upstream, revised</p>' });
  await lc('POST', `/assets/${up.id}/revisions`, 'registrar', { revision: 'r2' });
  const stale = await frame(c);
  const escaped = stale.continuations.find((k) => k.continuationId === 'k1');
  o.staleUpstream = { k1: escaped.status, reasonIsUpstream: /^upstream .* re-pinned at r2$/.test(escaped.supersededReason || ''), escapeTo: stale.continuations[2]?.next.templateId };
  await until(`${e.id}: C re-entered and parked again`, () => parkedK('k3')(c));
  await lc('POST', `/frames/${c}/abandon`, 'registrar', { reason: 'regression: stale-upstream case done' });
  // The pool limit, through Manager's routes, and the pool as it was after.
  const cfgUrl = `${e.re_url}/api/engine/config/clone.maxActive`;
  await request('PUT', cfgUrl, { tls, body: { value: 2 } });
  const before = await clonesOf(e);
  const made = [];
  for (const k of [1, 2, 3]) {
    const r = await request('POST', `${cfg.managerUrl}/api/engine/${e.id}/clone/machine/${T1}?asset=pool-${run}&envelope=pool-${run}-${k}`);
    made.push(r);
  }
  o.pool = { statuses: made.map((r) => r.status), refusal: made[2].body?.error };
  for (const r of made.filter((x) => x.status === 201)) {
    await request('POST', `${cfg.managerUrl}/api/engine/${e.id}/recycle/machine/${encodeURIComponent(r.body.cloneId)}?generation=${r.body.generation}`);
  }
  await request('DELETE', cfgUrl, { tls });
  const afterPool = await clonesOf(e);
  o.pool.asBefore = afterPool.length === before.length;
  outcomes[e.id] = o;
  t.check(`${e.id}: prepare parked ${T2} for a reviewer, holding no block`, o.parked.next === T2 && o.parked.role === 'reviewer' && o.parked.head === 'IN_REVIEW' && o.blocksWhileParked === 0);
  t.check(`${e.id}: an inbox annotation is a finding on the parked frame and approves nothing`, o.inbox.posted === 201 && o.inbox.finding && o.inbox.stillParked, JSON.stringify(o.inbox));
  t.check(`${e.id}: the preparer cannot approve`, o.approveByPreparer.status === 403 && o.approveByPreparer.error === 'the approver must not be the preparer', JSON.stringify(o.approveByPreparer));
  t.check(`${e.id}: the reviewer approves; the replay is refused`, o.approve.outcome === 'resume' && o.replay.status === 409);
  t.check(`${e.id}: the arbiter step ran and terminated; the head is closed`, o.closed.head === 'CLOSED' && o.closed.lastReturnTemplate === T2 && o.blocksAfterClose === 0);
  t.check(`${e.id}: a stale upstream took the escape path`, o.staleUpstream.k1 === 'superseded' && o.staleUpstream.reasonIsUpstream && o.staleUpstream.escapeTo === T1, JSON.stringify(o.staleUpstream));
  t.check(`${e.id}: maxActive + 1 shows the pool limit; the pool is as it was after`, JSON.stringify(o.pool.statuses) === '[201,201,409]' && /maxActive/.test(o.pool.refusal || '') && o.pool.asBefore, JSON.stringify(o.pool));
}
const forms = Object.values(outcomes).map((o) => JSON.stringify(o));
t.check('3-of-3: the voting engines agree on every outcome', new Set(forms).size === 1,
  new Set(forms).size === 1 ? 'identical' : Object.entries(outcomes).map(([k, o]) => `${k}: ${JSON.stringify(o)}`).join(' | '));
process.exit(t.report(process.argv[2], { outcomes }) ? 1 : 0);

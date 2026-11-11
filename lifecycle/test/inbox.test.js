// dokieli → the lifecycle (ROADMAP phase 5): the notification formats dokieli
// sends, and an inbox item driven through the service to a finding on the
// frame that holds the asset.
import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { tlsFixture } from './support/tls.js';
import { inboxOf, parseActivity, parseAnnotation } from '../src/inbox.js';
import { fakePod } from './support/pod.js';

const CSS = 'https://assets-css.localhost:13443/';
const AUTHOR = `${CSS}author/profile/card#me`;
const REVIEWER = `${CSS}reviewer/profile/card#me`;
const tokens = { admin: 'adm-token-0123456789-0123456789-01', registrar: 'reg-token-0123456789-0123456789-01', engine: 'eng-token-0123456789-0123456789-01' };

test('the inbox sits under the pod\'s assets/ container', () => {
  assert.equal(inboxOf(`${CSS}author/assets/report.html`, 'asset-1'), `${CSS}author/assets/inbox/asset-1/`);
  assert.equal(inboxOf(`${CSS}author/assets/2026/q4/report.html`, 'asset-1'), `${CSS}author/assets/inbox/asset-1/`);
  assert.equal(inboxOf(`${CSS}author/notes/x.html`, 'asset-1'), null);
});

test('dokieli\'s announce, compact or expanded, reads the same', () => {
  const doc = `${CSS}author/assets/report.html`;
  const compact = { '@context': 'https://www.w3.org/ns/activitystreams', type: 'Announce', actor: REVIEWER,
    object: `${CSS}reviewer/annotations/n1`, inReplyTo: doc, summary: 'Note 3 is wrong' };
  const prefixed = { '@context': { as: 'https://www.w3.org/ns/activitystreams#' }, '@type': 'as:Announce',
    'as:actor': { '@id': REVIEWER }, 'as:object': { '@id': `${CSS}reviewer/annotations/n1` }, 'as:inReplyTo': { '@id': doc } };
  const expanded = [{ '@id': 'urn:x', '@type': ['https://www.w3.org/ns/activitystreams#Announce'],
    'https://www.w3.org/ns/activitystreams#actor': [{ '@id': REVIEWER }],
    'https://www.w3.org/ns/activitystreams#object': [{ '@id': `${CSS}reviewer/annotations/n1` }],
    'https://www.w3.org/ns/activitystreams#inReplyTo': [{ '@id': doc }] }];
  for (const json of [compact, prefixed, expanded]) {
    const a = parseActivity(json);
    assert.equal(a.type, 'Announce');
    assert.equal(a.actor, REVIEWER);
    assert.equal(a.object, `${CSS}reviewer/annotations/n1`);
    assert.equal(a.inReplyTo, doc);
  }
});

test('a Web Annotation\'s creator, motivation, body and target', () => {
  const note = `${CSS}reviewer/annotations/n1`;
  const doc = `${CSS}author/assets/report.html`;
  // As dokieli writes it into its annotation store: a Create wrapping the note.
  const stored = { '@context': ['https://www.w3.org/ns/activitystreams', { oa: 'http://www.w3.org/ns/oa#' }], type: 'Create', actor: REVIEWER,
    object: { id: note, type: 'oa:Annotation', 'oa:motivatedBy': { id: 'oa:replying' }, 'as:attributedTo': REVIEWER,
      'oa:hasBody': { id: `${note}#body`, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#value': 'The going-concern note omits Q4.' },
      'oa:hasTarget': { id: `${note}#target`, 'oa:hasSource': { id: doc } } } };
  const a = parseAnnotation(stored, note);
  assert.equal(a.creator, REVIEWER);
  assert.equal(a.motivation, 'replying');
  assert.equal(a.body, 'The going-concern note omits Q4.');
  assert.equal(a.target, doc);
  assert.equal(parseAnnotation({ type: 'Note', content: 'x' }), null);
});

// A pod with inboxes: link() replaces the document's ETag, as CSS's .meta
// write does; the inbox holds JSON-LD items; annotations live in the
// annotator's pod.
function inboxPod(pod) {
  const boxes = new Map();
  const others = new Map();
  const links = [];
  return {
    links, boxes,
    post(inbox, json) { const url = `${inbox}${boxes.get(inbox).size + 1}`; boxes.get(inbox).set(url, json); return url; },
    put(url, json) { others.set(url, json); },
    client: {
      async link(docUrl, inbox) {
        if (!boxes.has(inbox)) boxes.set(inbox, new Map());
        if (links.some((l) => l.inbox === inbox && l.etagAfter === pod.etag(docUrl))) return false;
        pod.put(docUrl, 'same bytes, new ETag'); // the .meta write
        links.push({ docUrl, inbox, etagAfter: pod.etag(docUrl) });
        return true;
      },
      async list(inbox) { return [...(boxes.get(inbox)?.keys() || [])]; },
      async read(url) {
        const json = [...boxes.values()].map((b) => b.get(url)).find(Boolean) || others.get(url.split('#')[0]);
        return json ? { bytes: Buffer.from(JSON.stringify(json)), json } : null;
      },
      async subscribe() { return { close() {} }; }
    }
  };
}

test('an annotation announced to the asset\'s inbox becomes a finding on its frame, once, and resumes nothing', async () => {
  const pod = fakePod();
  const doc = `${CSS}author/assets/report.html`;
  pod.put(doc, 'same bytes, new ETag');
  const ib = inboxPod(pod);
  const fx = tlsFixture();
  const server = createApp({ tokens, podOrigin: CSS.slice(0, -1), pod: pod.client, inbox: ib.client, tls: fx.tls });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${server.address().port}`;
  const call = async (method, p, who, body) => {
    const r = await fx.request(`${base}${p}`, { method, headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const reg = await call('POST', '/assets', 'registrar', { podUrl: doc, caseId: 'c1', revision: 'r1' });
    assert.equal(reg.status, 201);
    const inbox = `${CSS}author/assets/inbox/${reg.body.id}/`;
    assert.equal(reg.body.inbox, inbox);
    // The link was written before the pin, so the pin holds the ETag it left.
    assert.equal(ib.links.length, 1);
    assert.equal(reg.body.current.etag, pod.etag(doc));
    const fr = await call('POST', '/frames', 'registrar', { documents: [{ assetId: reg.body.id }], preparer: AUTHOR,
      case: { delimiter: 'ifrs-approval-case', entity: 'E', period: 'P', assetType: 'COMPLIANCE-REVIEW' },
      first: { next: { engineId: 'cpp-1', templateId: 'machine-t1' } } });
    assert.equal(fr.status, 201);
    const before = (await call('GET', `/frames/${fr.body.frameId}`, 'engine')).body;

    // The reviewer's annotation in their own pod, announced to the inbox.
    const note = `${CSS}reviewer/annotations/n1`;
    ib.put(note, { '@context': 'https://www.w3.org/ns/activitystreams', type: 'Note',
      '@graph': [{ id: note, type: 'http://www.w3.org/ns/oa#Annotation', 'http://www.w3.org/ns/oa#bodyValue': 'Q4 is missing.',
        'http://purl.org/dc/terms/creator': { id: REVIEWER }, 'http://www.w3.org/ns/oa#motivatedBy': { id: 'http://www.w3.org/ns/oa#commenting' },
        'http://www.w3.org/ns/oa#hasTarget': { id: doc } }] });
    const item = ib.post(inbox, { '@context': 'https://www.w3.org/ns/activitystreams', type: 'Announce', actor: REVIEWER, object: note, inReplyTo: doc });
    // A claim alone: the actor says it is the author, with no annotation behind it.
    ib.post(inbox, { '@context': 'https://www.w3.org/ns/activitystreams', type: 'Announce', actor: AUTHOR, object: `${CSS}nobody/x`, summary: 'approve' });

    const swept = await call('POST', `/assets/${reg.body.id}/inbox/sweep`, 'engine');
    assert.equal(swept.status, 200);
    assert.equal(swept.body.recorded.length, 2);
    const findings = (await call('GET', `/assets/${reg.body.id}/annotations`, 'engine')).body;
    const real = findings.find((f) => f.source.item === item);
    assert.equal(real.author, REVIEWER);
    assert.equal(real.attribution, 'corroborated');
    assert.equal(real.body, 'Q4 is missing.');
    assert.equal(real.revision, 'r1');
    assert.deepEqual(real.target, { source: doc, matchesAsset: true });
    const claim = findings.find((f) => f.source.item !== item);
    assert.equal(claim.attribution, 'claimed');
    assert.equal(claim.body, 'approve');

    // On the frame's log, never as a resumption.
    const history = (await call('GET', `/frames/${fr.body.frameId}/history`, 'engine')).body;
    assert.equal(history.filter((e) => e.type === 'finding.recorded').length, 2);
    assert.ok(history.every((e) => e.type !== 'continuation.resumed'));
    const after = (await call('GET', `/frames/${fr.body.frameId}`, 'engine')).body;
    assert.deepEqual(after.continuations, before.continuations);
    assert.equal(after.headStatus, before.headStatus);

    // Once: a second sweep records nothing.
    assert.deepEqual((await call('POST', `/assets/${reg.body.id}/inbox/sweep`, 'engine')).body.recorded, []);

    // A re-pin restores the link first, and the pin holds the ETag it left.
    pod.put(doc, 'the author edited it'); // a PUT drops the link on CSS
    ib.links.length = 0;
    const rp = await call('POST', `/assets/${reg.body.id}/revisions`, 'registrar', { revision: 'r2' });
    assert.equal(rp.status, 201);
    assert.equal(ib.links.length, 1);
    assert.equal(rp.body.current.etag, pod.etag(doc));
  } finally {
    server.close();
  }
});

test('a running service watches a newly registered asset\'s inbox and records what its notification announces', async () => {
  const pod = fakePod();
  const doc = `${CSS}author/assets/watched.html`;
  pod.put(doc, 'v1');
  const ib = inboxPod(pod);
  const channels = new Map();
  ib.client.subscribe = async (topic, { onMessage }) => { channels.set(topic, onMessage); return { close() {} }; };
  const fx = tlsFixture();
  const server = createApp({ tokens, podOrigin: CSS.slice(0, -1), pod: pod.client, inbox: ib.client, tls: fx.tls });
  server.inboxes.start();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${server.address().port}`;
  const call = async (method, p, who, body) => {
    const r = await fx.request(`${base}${p}`, { method, headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const reg = await call('POST', '/assets', 'registrar', { podUrl: doc, caseId: 'c2', revision: 'r1' });
    assert.equal(reg.status, 201);
    // Subscribed while registering, before the asset was stored.
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(channels.has(reg.body.inbox), 'the new inbox is watched');
    ib.post(reg.body.inbox, { '@context': 'https://www.w3.org/ns/activitystreams', type: 'Announce', actor: REVIEWER, object: `${CSS}reviewer/x`, summary: 'see note 3' });
    channels.get(reg.body.inbox)('{"type":"Add"}');
    let findings = [];
    for (let i = 0; i < 50 && !findings.length; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      findings = (await call('GET', `/assets/${reg.body.id}/annotations`, 'engine')).body;
    }
    assert.equal(findings.length, 1);
    assert.equal(findings[0].body, 'see note 3');
  } finally {
    server.close();
  }
});

// What dokieli (the pinned commit) actually wrote on 2026-11-11, when the
// author commented on a paragraph through its UI: the flattened Announce it
// posted to the document's inbox, and the Web Annotation in the author's store.
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const DOKIELI = {
  doc: `${CSS}author/assets/gc-review-mwc7cnhh.html`,
  item: `${CSS}author/assets/inbox/asset-19a0cfa5-93f0-44d4-9a1d-f8993e052d73/fefe5cd4-ef33-40e1-a0da-e0de4d4cc2c2`,
  note: `${CSS}author/annotations/fefe5cd4-ef33-40e1-a0da-e0de4d4cc2c2`
};

test('dokieli\'s real inbox item and annotation read as the author, the note and the paragraph', () => {
  const a = parseActivity(fixture('dokieli-inbox-item.jsonld'), DOKIELI.item);
  assert.equal(a.type, 'Announce');
  assert.equal(a.actor, AUTHOR);
  assert.equal(a.object, DOKIELI.note);
  const stub = parseAnnotation(fixture('dokieli-inbox-item.jsonld'), a.object, DOKIELI.item);
  assert.equal(stub.inReplyTo, `${DOKIELI.doc}#summary`);
  const note = parseAnnotation(fixture('dokieli-annotation.jsonld'), DOKIELI.note, DOKIELI.note);
  assert.equal(note.id, DOKIELI.note);
  assert.equal(note.creator, AUTHOR);
  assert.equal(note.motivation, 'replying');
  assert.equal(note.body, 'The going-concern assessment omits Q4 2026.');
  assert.equal(note.target, DOKIELI.doc);
});

test('dokieli\'s real notification becomes a corroborated finding with its text', async () => {
  const pod = fakePod();
  pod.put(DOKIELI.doc, 'v1');
  const ib = inboxPod(pod);
  const fx = tlsFixture();
  const server = createApp({ tokens, podOrigin: CSS.slice(0, -1), pod: pod.client, inbox: ib.client, tls: fx.tls });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${server.address().port}`;
  const call = async (method, p, who, body) => {
    const r = await fx.request(`${base}${p}`, { method, headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const reg = await call('POST', '/assets', 'registrar', { podUrl: DOKIELI.doc, caseId: 'c3', revision: 'r1' });
    ib.boxes.get(reg.body.inbox).set(DOKIELI.item, fixture('dokieli-inbox-item.jsonld'));
    ib.put(DOKIELI.note, fixture('dokieli-annotation.jsonld'));
    assert.equal((await call('POST', `/assets/${reg.body.id}/inbox/sweep`, 'engine')).body.recorded.length, 1);
    const [f] = (await call('GET', `/assets/${reg.body.id}/annotations`, 'engine')).body;
    assert.equal(f.author, AUTHOR);
    assert.equal(f.attribution, 'corroborated');
    assert.equal(f.motivation, 'replying');
    assert.equal(f.body, 'The going-concern assessment omits Q4 2026.');
    assert.deepEqual(f.target, { source: DOKIELI.doc, matchesAsset: true });
    assert.equal(f.annotation, DOKIELI.note);
  } finally {
    server.close();
  }
});

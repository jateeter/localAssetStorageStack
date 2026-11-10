// dokieli → the lifecycle service (ROADMAP phase 5, A7).
//
// Each registered asset gets an inbox container in its pod,
// `<pod>/assets/inbox/<assetId>/`, advertised on the document as
// `Link: <inbox>; rel="http://www.w3.org/ns/ldp#inbox"` through the document's
// description resource (`.meta`), which is how dokieli finds where to send an
// annotation's notification. CSS drops that triple when the document is
// replaced (PUT), and writing it changes the document's ETag, so link() runs
// before every pin: the pin then holds the ETag the link left.
//
// The service watches each inbox through CSS's Solid Notifications
// (WebSocketChannel2023), with a sweep at start and on every reconnect, and
// turns each new item into a finding on the asset, logged on every open frame
// that holds it. An inbox item has no authenticated sender: CSS checks the
// poster may append, not who they are, and dokieli's `actor` is the sender's own
// claim. So a finding records its author as claimed, `attribution: "claimed"`,
// or `"corroborated"` when the annotation it announces lives in the claimed
// author's own pod and names the same creator. Neither is ever an approval:
// reviewer decisions go through the API with the reviewer's Solid-OIDC token.

const LDP_INBOX = 'http://www.w3.org/ns/ldp#inbox';
const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';
const WS_CHANNEL = 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023';
const NS = {
  as: 'https://www.w3.org/ns/activitystreams#',
  oa: 'http://www.w3.org/ns/oa#',
  dcterms: 'http://purl.org/dc/terms/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  schema: 'http://schema.org/'
};
const ACTIVITIES = ['Announce', 'Create', 'Add', 'Update', 'Offer', 'Like', 'Dislike'];

// The asset's inbox: beside the person's workflow documents, which live under
// `<pod>/assets/` (scripts/grant-assets.js). null for a document elsewhere.
export function inboxOf(podUrl, assetId) {
  const u = new URL(podUrl);
  const i = u.pathname.indexOf('/assets/');
  if (i < 0) return null;
  return `${u.origin}${u.pathname.slice(0, i)}/assets/inbox/${encodeURIComponent(assetId)}/`;
}

// --- reading JSON-LD without a library: compact (an @context with short
// names, or as:/oa: prefixes) or expanded (full IRIs) ---------------------------

const nodesOf = (json) => {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (v['@graph']) walk(v['@graph']);
    if (v['@id'] || v.id || v['@type'] || v.type) out.push(v);
    for (const [k, x] of Object.entries(v)) if (k !== '@graph' && k !== '@context' && typeof x === 'object') walk(x);
  };
  walk(json);
  return out;
};
const keysFor = (name) => [name, ...Object.entries(NS).flatMap(([p, iri]) => [`${p}:${name}`, `${iri}${name}`])];
const values = (node, ...names) => {
  for (const name of names) {
    for (const k of keysFor(name)) if (node[k] !== undefined) return [].concat(node[k]);
  }
  return [];
};
const text = (v) => (v === null || v === undefined ? null
  : typeof v === 'string' ? v
    : typeof v === 'object' ? (v['@id'] ?? v.id ?? v['@value'] ?? v.href ?? null) : String(v));
const first = (node, ...names) => text(values(node, ...names)[0]);
const idOf = (node) => text(node['@id'] ?? node.id);
const local = (iri) => String(iri).replace(/^(as|oa):/, '').replace(/^.*[#/]/, '');
const typesOf = (node) => [].concat(node['@type'] ?? node.type ?? []).map(local);

// The activity dokieli posts to an inbox (notifyInbox): its type, the claimed
// actor, the annotation it announces (object) and the document it is about.
export function parseActivity(json) {
  const nodes = nodesOf(json);
  const node = nodes.find((n) => typesOf(n).some((t) => ACTIVITIES.includes(t))) || nodes.find((n) => values(n, 'actor').length);
  if (!node) return null;
  const object = values(node, 'object')[0];
  return {
    type: typesOf(node).find((t) => ACTIVITIES.includes(t)) || null,
    actor: first(node, 'actor'),
    object: text(object),
    target: first(node, 'target'),
    inReplyTo: first(node, 'inReplyTo'),
    context: first(node, 'context'),
    summary: first(node, 'summary', 'name'),
    content: first(node, 'content') ?? (object && typeof object === 'object' ? first(object, 'content', 'summary') : null)
  };
}

// A Web Annotation (dokieli's note), wherever it sits in the graph: its
// creator, motivation, body text and the source it targets.
export function parseAnnotation(json, objectIri = null) {
  const nodes = nodesOf(json);
  const base = objectIri ? objectIri.split('#')[0] : null;
  const node = (objectIri && nodes.find((n) => idOf(n) === objectIri && typesOf(n).includes('Annotation')))
    || nodes.find((n) => typesOf(n).includes('Annotation') && (!base || !idOf(n) || idOf(n).split('#')[0] === base))
    || nodes.find((n) => typesOf(n).includes('Annotation'));
  if (!node) return null;
  const bodyNode = values(node, 'hasBody', 'body')[0];
  const bodyObj = bodyNode && typeof bodyNode === 'object' ? (nodes.find((n) => idOf(n) && idOf(n) === idOf(bodyNode)) || bodyNode) : null;
  const targetNode = values(node, 'hasTarget', 'target')[0];
  const targetObj = targetNode && typeof targetNode === 'object' ? (nodes.find((n) => idOf(n) && idOf(n) === idOf(targetNode)) || targetNode) : null;
  return {
    id: idOf(node),
    creator: first(node, 'creator', 'attributedTo', 'author'),
    motivation: values(node, 'motivatedBy', 'motivation').map((m) => local(text(m)))[0] || null,
    body: first(node, 'bodyValue') ?? (bodyObj ? first(bodyObj, 'value', 'content', 'description', 'text') : null) ?? (typeof bodyNode === 'string' ? bodyNode : null),
    target: targetObj ? (first(targetObj, 'hasSource', 'source') ?? idOf(targetObj)) : text(targetNode)
  };
}

// The claimed author's own pod: the WebID's document path up to its profile.
const podRootOf = (webId) => {
  try {
    const u = new URL(webId);
    const i = u.pathname.indexOf('/profile/');
    return i < 0 ? null : `${u.origin}${u.pathname.slice(0, i + 1)}`;
  } catch { return null; }
};
const sameDocument = (a, b) => !!a && !!b && a.split('#')[0] === b.split('#')[0];

// --- the pod side: the service's own DPoP identity --------------------------------

// `fetchImpl` is the service identity's fetch; `WebSocketImpl` the client the
// notification channel speaks (Node's global WebSocket).
export function inboxClient({ fetchImpl, WebSocketImpl = globalThis.WebSocket }) {
  const linkOf = (r) => r.headers.get('link') || '';
  const subscriptions = new Map(); // storage description → subscription URL
  return {
    // The container exists (CSS creates its parents) and the document links it.
    async link(docUrl, inbox) {
      const c = await fetchImpl(inbox, { method: 'HEAD' });
      if (c.status === 404) {
        const made = await fetchImpl(inbox, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '' });
        if (!made.ok) throw new Error(`creating ${inbox}: ${made.status}`);
      } else if (!c.ok) throw new Error(`${inbox}: ${c.status}`);
      const h = await fetchImpl(docUrl, { method: 'HEAD' });
      if (!h.ok) throw new Error(`${docUrl}: ${h.status}`);
      const link = linkOf(h);
      if (link.includes(`<${inbox}>; rel="${LDP_INBOX}"`)) return false;
      const m = link.match(/<([^>]+)>;\s*rel="describedby"/);
      if (!m) throw new Error(`${docUrl} names no description resource`);
      const patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.\n_:link a solid:InsertDeletePatch; solid:inserts { <${docUrl}> <${LDP_INBOX}> <${inbox}> . }.`;
      const p = await fetchImpl(new URL(m[1], docUrl).href, { method: 'PATCH', headers: { 'content-type': 'text/n3' }, body: patch });
      if (!p.ok) throw new Error(`linking the inbox of ${docUrl}: ${p.status}`);
      return true;
    },
    async list(inbox) {
      const r = await fetchImpl(inbox, { headers: { accept: 'application/ld+json' } });
      if (r.status === 404) return [];
      if (!r.ok) throw new Error(`${inbox}: ${r.status}`);
      const own = nodesOf(await r.json()).find((n) => idOf(n) === inbox);
      return own ? [].concat(own[LDP_CONTAINS] ?? own.contains ?? own['ldp:contains'] ?? []).map(text).filter(Boolean) : [];
    },
    // An inbox item or an annotation: its bytes and, where it is JSON-LD, the
    // parsed document. Unreadable is null, not an error: an annotation may sit
    // in a store the service cannot read.
    async read(url) {
      const r = await fetchImpl(url.split('#')[0], { headers: { accept: 'application/ld+json' } });
      if (!r.ok) return null;
      const bytes = Buffer.from(await r.arrayBuffer());
      let json = null;
      if (/json/.test(r.headers.get('content-type') || '')) { try { json = JSON.parse(bytes.toString()); } catch { json = null; } }
      return { bytes, json };
    },
    // A WebSocketChannel2023 on `topic`; onMessage for each notification,
    // onClose when the channel ends. Returns the socket.
    async subscribe(topic, { onMessage, onClose }) {
      const h = await fetchImpl(topic, { method: 'HEAD' });
      const sd = (linkOf(h).match(/<([^>]+)>;\s*rel="http:\/\/www\.w3\.org\/ns\/solid\/terms#storageDescription"/) || [])[1];
      if (!sd) throw new Error(`${topic} names no storage description`);
      const sdUrl = new URL(sd, topic).href;
      if (!subscriptions.has(sdUrl)) {
        const desc = await (await fetchImpl(sdUrl, { headers: { accept: 'application/ld+json' } })).json();
        const node = nodesOf(desc).find((n) => [].concat(n['http://www.w3.org/ns/solid/notifications#channelType'] ?? n.channelType ?? [])
          .some((t) => text(t) === WS_CHANNEL || text(t) === 'WebSocketChannel2023'));
        if (!node) throw new Error(`${sdUrl} offers no WebSocketChannel2023`);
        subscriptions.set(sdUrl, idOf(node));
      }
      const r = await fetchImpl(subscriptions.get(sdUrl), { method: 'POST', headers: { 'content-type': 'application/ld+json' },
        body: JSON.stringify({ '@context': ['https://www.w3.org/ns/solid/notification/v1'], type: WS_CHANNEL, topic }) });
      if (!r.ok) throw new Error(`subscribing to ${topic}: ${r.status}`);
      const channel = await r.json();
      const ws = new WebSocketImpl(channel.receiveFrom);
      ws.onmessage = (m) => onMessage(String(m.data));
      ws.onclose = () => onClose();
      ws.onerror = () => {};
      return ws;
    }
  };
}

// --- the service side ------------------------------------------------------------

// ctx: { d, commit, serial, now, id, sha256 }. `client` is inboxClient(...).
export function mountInbox(ctx, client) {
  const { d, commit, serial, now, id, sha256 } = ctx;
  d().inboxSeen ||= {};
  const sockets = new Map();
  let running = false;

  // Before every pin: the inbox exists and the document advertises it.
  async function link(a) {
    if (a.inbox === undefined) a.inbox = inboxOf(a.podUrl, a.id);
    if (!a.inbox) return;
    await client.link(a.podUrl, a.inbox);
    // The asset itself, not its id: at registration it is not stored yet.
    if (running && !sockets.has(a.id)) watch(a);
  }

  // One inbox item becomes one finding, recorded once.
  async function ingest(a, itemUrl) {
    if (d().inboxSeen[itemUrl]) return null;
    const item = await client.read(itemUrl);
    if (!item) return null; // gone, or not yet readable: the next sweep sees it
    const activity = item.json ? parseActivity(item.json) : null;
    const embedded = item.json ? parseAnnotation(item.json, activity?.object) : null;
    let annotation = embedded;
    let objectSha256 = null;
    if (!annotation && activity?.object && /^https:\/\//.test(activity.object)) {
      const obj = await client.read(activity.object);
      if (obj) {
        objectSha256 = sha256(obj.bytes);
        annotation = obj.json ? parseAnnotation(obj.json, activity.object) : null;
      }
    }
    const claimed = activity?.actor || annotation?.creator || null;
    const root = podRootOf(claimed);
    const corroborated = !!(annotation && objectSha256 && root && activity?.object?.startsWith(root) && annotation.creator === claimed);
    const target = activity?.inReplyTo || activity?.target || annotation?.target || activity?.context || null;
    const f = {
      id: id('finding'), assetId: a.id, revision: a.current?.revision ?? null,
      author: claimed, attribution: corroborated ? 'corroborated' : 'claimed', via: 'inbox',
      motivation: annotation?.motivation || 'commenting',
      body: annotation?.body ?? activity?.content ?? activity?.summary ?? null,
      target: target ? { source: target, matchesAsset: sameDocument(target, a.podUrl) } : null,
      annotation: activity?.object || annotation?.id || null,
      source: { item: itemUrl, sha256: sha256(item.bytes), activity: activity?.type || null, objectSha256 },
      createdAt: now()
    };
    d().findings[f.id] = f;
    d().inboxSeen[itemUrl] = { findingId: f.id, sha256: f.source.sha256 };
    const event = { type: 'finding.recorded', assetId: a.id, findingId: f.id, revision: f.revision, via: 'inbox',
      attribution: f.attribution, claimedBy: claimed, by: 'inbox' };
    const frames = Object.values(d().frames || {}).filter((x) => x.status === 'open' && x.documents.some((doc) => doc.assetId === a.id));
    if (!frames.length) commit(event);
    for (const x of frames) commit({ ...event, frameId: x.frameId });
    return f;
  }

  // Everything in the inbox not yet recorded. sweepNow runs inside a change
  // that already holds the service's serial queue (a route); sweep queues.
  async function sweepNow(assetId) {
    const a = d().assets[assetId];
    if (!a) return []; // registered but not yet stored: its notification sweeps again
    if (!a?.inbox) return [];
    const made = [];
    for (const url of await client.list(a.inbox)) {
      const f = await ingest(a, url);
      if (f) made.push(f);
    }
    return made;
  }
  const sweep = (assetId) => serial(() => sweepNow(assetId));

  // Subscribe, sweep what arrived while unsubscribed, and come back after a
  // dropped channel.
  async function watch(a) {
    const assetId = a.id;
    if (!running || sockets.has(assetId) || !a.inbox) return;
    sockets.set(assetId, null);
    const retry = () => { sockets.delete(assetId); if (running) setTimeout(() => watch(a), 5000).unref(); };
    try {
      const ws = await client.subscribe(a.inbox, {
        onMessage: () => { sweep(assetId).catch((e) => console.error(`inbox ${a.inbox}: ${e.message}`)); },
        onClose: retry
      });
      sockets.set(assetId, ws);
      await sweep(assetId);
    } catch (e) {
      console.error(`inbox ${a.inbox}: ${e.message}`);
      retry();
    }
  }

  return {
    link,
    sweep,
    sweepNow,
    ingest,
    // Once the service identity is ready.
    start() {
      running = true;
      for (const a of Object.values(d().assets)) if (a.inbox) watch(a);
    },
    stop() {
      running = false;
      for (const ws of sockets.values()) ws?.close?.();
      sockets.clear();
    },
    get watching() { return [...sockets.keys()]; }
  };
}

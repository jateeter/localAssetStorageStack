// Review access (ROADMAP phase 5; owner decision 2026-11-11): the people who
// may resume a parked continuation read the frame's documents while it waits
// for them, and only then.
//
// A document under `<pod>/assets/` is readable by its owner and this service
// (scripts/grant-assets.js). While an open frame holding it is parked for a
// person, the service writes the document's own ACL: the owner and the service
// keep Read, Write and Control, and every WebID with the resuming role gets
// Read. When no open frame is parked for a person on it, the service deletes
// that ACL and the container's applies again. An ACL write leaves the
// document's ETag as it was, so no pin moves.

const ACL_REL = /<([^>]+)>;\s*rel="acl"/;

// The pod owner's WebID, by the stack's layout: `<pod>/profile/card#me` for a
// document under `<pod>/assets/` (scripts/accounts.js).
export function ownerOf(podUrl) {
  const u = new URL(podUrl);
  const i = u.pathname.indexOf('/assets/');
  return i < 0 ? null : `${u.origin}${u.pathname.slice(0, i)}/profile/card#me`;
}

export function aclBody(docUrl, { owner, service, readers }) {
  const full = [owner, service].filter(Boolean).map((w) => `<${w}>`).join(', ');
  return `@prefix acl: <http://www.w3.org/ns/auth/acl#>.

<#owner> a acl:Authorization;
  acl:agent ${full};
  acl:accessTo <${docUrl}>;
  acl:mode acl:Read, acl:Write, acl:Control.

<#review> a acl:Authorization;
  acl:agent ${readers.map((w) => `<${w}>`).join(', ')};
  acl:accessTo <${docUrl}>;
  acl:mode acl:Read.
`;
}

// The pod side, as the service: write or remove a document's own ACL.
export function accessClient({ fetchImpl }) {
  const aclOf = async (docUrl) => {
    const h = await fetchImpl(docUrl, { method: 'HEAD' });
    if (!h.ok) throw new Error(`${docUrl}: ${h.status}`);
    const m = (h.headers.get('link') || '').match(ACL_REL);
    if (!m) throw new Error(`${docUrl} names no ACL`);
    return new URL(m[1], docUrl).href;
  };
  return {
    async grant(docUrl, body) {
      const acl = await aclOf(docUrl);
      const r = await fetchImpl(acl, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body });
      if (!r.ok) throw new Error(`writing ${acl}: ${r.status}`);
    },
    async revoke(docUrl) {
      const acl = await aclOf(docUrl);
      const r = await fetchImpl(acl, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`removing ${acl}: ${r.status}`);
    }
  };
}

// ctx: { d, commit, holders(role) → WebIDs, serviceWebId() }.
export function reviewAccess(ctx, client) {
  const { d, commit, holders, serviceWebId } = ctx;
  d().reviewAccess ||= {}; // document URL → the readers its ACL grants now

  // Who may read `uri` now: the resuming role's holders, for every open frame
  // holding it whose current continuation waits on a person.
  const wanted = (uri) => {
    const readers = new Set();
    for (const f of Object.values(d().frames || {})) {
      if (f.status !== 'open' || !f.documents.some((x) => x.uri === uri)) continue;
      const c = f.continuations.find((k) => k.continuationId === f.current);
      if (c?.status === 'parked' && c.resumableBy?.role && c.resumableBy.role !== 'engine') {
        for (const w of holders(c.resumableBy.role)) readers.add(w);
      }
    }
    return [...readers].sort();
  };

  async function apply(uri, assetId) {
    const readers = wanted(uri);
    const now = d().reviewAccess[uri] || [];
    if (JSON.stringify(readers) === JSON.stringify(now)) return false;
    if (readers.length) await client.grant(uri, aclBody(uri, { owner: ownerOf(uri), service: serviceWebId(), readers }));
    else await client.revoke(uri);
    if (readers.length) d().reviewAccess[uri] = readers; else delete d().reviewAccess[uri];
    commit({ type: 'review.access', assetId, uri, readers });
    return true;
  }

  return {
    // After every change to a frame; a failure is retried at the next one.
    async sync(frameId) {
      const f = d().frames?.[frameId];
      if (!f) return;
      for (const doc of f.documents) {
        try { await apply(doc.uri, doc.assetId); } catch (e) { console.error(`review access ${doc.uri}: ${e.message}`); }
      }
    },
    // At start: every document an ACL was written for, and every open frame's.
    async reconcile() {
      const docs = new Map(Object.keys(d().reviewAccess).map((u) => [u, null]));
      for (const f of Object.values(d().frames || {})) {
        if (f.status === 'open') for (const doc of f.documents) docs.set(doc.uri, doc.assetId);
      }
      for (const [uri, assetId] of docs) {
        try { await apply(uri, assetId); } catch (e) { console.error(`review access ${uri}: ${e.message}`); }
      }
    }
  };
}

// A stand-in pod behind the real podClient: an in-memory map served with
// HTTP semantics (ETag on read, If-Match on write, 403 for documents the
// service may not read), so the tests exercise the same client the service uses.
import { podClient } from '../../src/integrity.js';

export function fakePod() {
  const docs = new Map(); // url → { bytes, etag }
  const forbidden = new Set();
  let version = 0;
  const put = (url, text) => { version += 1; docs.set(url, { bytes: Buffer.from(text), etag: `"v${version}"` }); };
  const fetchImpl = async (url, init = {}) => {
    if (forbidden.has(url)) return new Response('', { status: 403 });
    const doc = docs.get(url);
    if ((init.method || 'GET') === 'PUT') {
      if (!doc || init.headers['if-match'] !== doc.etag) return new Response('', { status: 412 });
      put(url, Buffer.from(init.body).toString());
      return new Response(null, { status: 204, headers: { etag: docs.get(url).etag } });
    }
    if (!doc) return new Response('', { status: 404 });
    return new Response(doc.bytes, { status: 200, headers: { etag: doc.etag, 'content-type': 'text/html' } });
  };
  return { client: podClient({ fetchImpl }), put, forbid: (url) => forbidden.add(url), etag: (url) => docs.get(url)?.etag };
}

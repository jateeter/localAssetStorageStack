// Integrity for the lifecycle service (ROADMAP phase 3, A3).
//
// - canonical(): RFC 8785 (JCS) canonical JSON, the form receipts are signed in.
// - receiptSigner(): Ed25519 receipts over that form, the public key served at
//   /keys, so a receipt verifies offline with nothing but the key.
// - eventLog(): the append-only history, one JSON line per event, fsynced
//   before the request that caused it is answered, each line chained to the
//   previous one by hash so a rewritten past is detectable.
// - podClient(): the service's own reads and writes of a pod document: the
//   exact bytes, their SHA-256 and the ETag, and writes conditional on the
//   pinned ETag (If-Match).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { thumbprint } from './jose.js';

export class IntegrityError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// --- RFC 8785 ---------------------------------------------------------------------

// Object members sorted by their names' UTF-16 code units (the default string
// sort), numbers in ECMAScript form (JSON.stringify's), strings escaped as
// JSON.stringify escapes them. Non-finite numbers and non-JSON values refuse.
export function canonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON has no non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot hold a ${typeof value}`);
}

export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// --- receipts ---------------------------------------------------------------------

const loadOrCreateEd25519 = (keyFile) => {
  if (keyFile && fs.existsSync(keyFile)) return crypto.createPrivateKey(fs.readFileSync(keyFile));
  const key = crypto.generateKeyPairSync('ed25519').privateKey;
  if (keyFile) {
    fs.writeFileSync(`${keyFile}.tmp`, key.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    fs.renameSync(`${keyFile}.tmp`, keyFile);
  }
  return key;
};

export function receiptSigner({ keyFile = '' } = {}) {
  const privateKey = loadOrCreateEd25519(keyFile);
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  const kid = thumbprint(jwk);
  const publicJwk = { ...jwk, kid, alg: 'EdDSA', use: 'sig' };
  return {
    kid,
    jwks: { keys: [publicJwk] },
    // The receipt is the body plus `kid`; `signature` signs its canonical form.
    sign(body) {
      const unsigned = { ...body, kid };
      const signature = crypto.sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64url');
      return { ...unsigned, signature };
    }
  };
}

// Offline verification: the receipt and a JWKS (GET /keys), nothing else.
export function verifyReceipt(receipt, jwks) {
  if (!receipt || typeof receipt.signature !== 'string') return false;
  const key = (jwks?.keys || []).find((k) => k.kid === receipt.kid);
  if (!key) return false;
  const { signature, ...unsigned } = receipt;
  try {
    const pub = crypto.createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x }, format: 'jwk' });
    return crypto.verify(null, Buffer.from(canonical(unsigned)), pub, Buffer.from(signature, 'base64url'));
  } catch { return false; }
}

// --- the event log ------------------------------------------------------------------

const GENESIS = '0'.repeat(64);

// One line per event: { seq, at, prev, ...event, hash }, where `hash` is the
// SHA-256 of the line's canonical form without `hash`, and `prev` the hash of
// the line before (GENESIS for the first). append() returns once the line is
// on disk (fsync).
export function eventLog({ file = '', now = () => new Date().toISOString() } = {}) {
  let seq = 0;
  let prev = GENESIS;
  const mem = [];
  if (file && fs.existsSync(file)) {
    const check = verifyLog(fs.readFileSync(file, 'utf8'));
    if (!check.ok) throw new Error(`event log ${file} is broken at line ${check.line}: ${check.error}`);
    seq = check.count;
    prev = check.last;
  }
  const fd = file ? fs.openSync(file, 'a', 0o600) : null;
  return {
    append(event) {
      const line = { seq: seq + 1, at: now(), prev, ...event };
      line.hash = sha256(canonical(line));
      const text = `${JSON.stringify(line)}\n`;
      if (fd !== null) { fs.writeSync(fd, text); fs.fsyncSync(fd); } else mem.push(text);
      seq += 1;
      prev = line.hash;
      return line;
    },
    read(filter = () => true) {
      const text = file ? fs.readFileSync(file, 'utf8') : mem.join('');
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter(filter);
    },
    get head() { return { seq, hash: prev }; },
    close() { if (fd !== null) fs.closeSync(fd); }
  };
}

// Checks every line's hash and its link to the one before.
export function verifyLog(text) {
  let prev = GENESIS;
  let count = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i]) { if (i === lines.length - 1) break; return { ok: false, line: i + 1, error: 'empty line' }; }
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { return { ok: false, line: i + 1, error: 'not JSON' }; }
    const { hash, ...rest } = entry;
    if (entry.seq !== count + 1) return { ok: false, line: i + 1, error: `sequence ${entry.seq}, expected ${count + 1}` };
    if (entry.prev !== prev) return { ok: false, line: i + 1, error: 'chain broken' };
    if (sha256(canonical(rest)) !== hash) return { ok: false, line: i + 1, error: 'hash mismatch' };
    prev = hash;
    count += 1;
  }
  return { ok: true, count, last: prev };
}

// --- pod reads and writes -------------------------------------------------------------

// `fetchImpl` is the service identity's DPoP-bound fetch. read() answers the
// exact bytes, their SHA-256 and the ETag; write() is conditional on `ifMatch`
// and refuses when the pod has moved on.
export function podClient({ fetchImpl }) {
  return {
    async read(url) {
      const r = await fetchImpl(url, { headers: { accept: '*/*' } });
      if (r.status === 401 || r.status === 403) {
        throw new IntegrityError(409, `the lifecycle service cannot read ${url} (${r.status}): the document must be in a container that grants it read access`);
      }
      if (r.status === 404) throw new IntegrityError(409, `${url} does not exist in the pod`);
      if (!r.ok) throw new IntegrityError(502, `pod read ${url}: ${r.status}`);
      const bytes = Buffer.from(await r.arrayBuffer());
      const etag = r.headers.get('etag');
      if (!etag) throw new IntegrityError(502, `pod read ${url}: no ETag`);
      return { etag, hash: sha256(bytes), bytes, contentType: r.headers.get('content-type') || 'application/octet-stream' };
    },
    async write(url, bytes, { ifMatch, contentType }) {
      if (!ifMatch) throw new IntegrityError(500, 'a pod write needs the pinned ETag');
      const r = await fetchImpl(url, { method: 'PUT', headers: { 'content-type': contentType, 'if-match': ifMatch }, body: bytes });
      if (r.status === 412) throw new IntegrityError(409, 'pod changed since pin');
      if (!r.ok) throw new IntegrityError(502, `pod write ${url}: ${r.status}`);
      return { etag: r.headers.get('etag') };
    }
  };
}

// Minimal JOSE on node:crypto: compact JWS sign/verify, RFC 7638 thumbprints and
// DPoP proofs (RFC 9449). Enough for Solid-OIDC (ROADMAP phase 2) without a
// dependency; the lifecycle service has none.
import crypto from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64u = (s) => Buffer.from(s, 'base64url');
const json = (s) => JSON.parse(fromB64u(s).toString('utf8'));

// alg → [hash, key options for crypto.sign/verify]
const ALGS = {
  ES256: ['sha256', { dsaEncoding: 'ieee-p1363' }],
  ES384: ['sha384', { dsaEncoding: 'ieee-p1363' }],
  RS256: ['sha256', {}],
  PS256: ['sha256', { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }],
  EdDSA: [null, {}]
};

export class JoseError extends Error {}

export function decode(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new JoseError('malformed JWT');
  try {
    return { header: json(parts[0]), payload: json(parts[1]), signature: fromB64u(parts[2]), input: `${parts[0]}.${parts[1]}` };
  } catch { throw new JoseError('malformed JWT'); }
}

const publicKey = (jwk) => {
  if (!jwk || typeof jwk !== 'object' || jwk.d !== undefined) throw new JoseError('not a public JWK');
  try { return crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { throw new JoseError('unusable JWK'); }
};

// Verifies the compact JWS against `jwk`; returns { header, payload }.
export function verify(token, jwk) {
  const t = decode(token);
  const alg = ALGS[t.header.alg];
  if (!alg) throw new JoseError(`algorithm ${t.header.alg} not accepted`);
  const ok = crypto.verify(alg[0], Buffer.from(t.input), { key: publicKey(jwk), ...alg[1] }, t.signature);
  if (!ok) throw new JoseError('bad signature');
  return { header: t.header, payload: t.payload };
}

export function sign(header, payload, privateKey) {
  const alg = ALGS[header.alg];
  if (!alg) throw new JoseError(`algorithm ${header.alg} not supported`);
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  return `${input}.${b64u(crypto.sign(alg[0], Buffer.from(input), { key: privateKey, ...alg[1] }))}`;
}

// RFC 7638: the required members, lexicographic, no whitespace.
const REQUIRED = { EC: ['crv', 'kty', 'x', 'y'], RSA: ['e', 'kty', 'n'], OKP: ['crv', 'kty', 'x'] };
export function thumbprint(jwk) {
  const members = REQUIRED[jwk?.kty];
  if (!members) throw new JoseError('unsupported key type');
  const canonical = `{${members.map((m) => `${JSON.stringify(m)}:${JSON.stringify(jwk[m])}`).join(',')}}`;
  return b64u(crypto.createHash('sha256').update(canonical).digest());
}

export const accessTokenHash = (token) => b64u(crypto.createHash('sha256').update(token).digest());

// htu comparison ignores query and fragment (RFC 9449 §4.3).
export const htu = (url) => { const u = new URL(url); return `${u.origin}${u.pathname}`; };

// A DPoP-bound client key: an ES256 pair whose public half rides in each proof.
export function dpopKey() {
  const { privateKey, publicKey: pub } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pub.export({ format: 'jwk' });
  return { privateKey, jwk, jkt: thumbprint(jwk) };
}

export function dpopProof(key, method, url, accessToken) {
  const payload = { htm: method, htu: htu(url), iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID() };
  if (accessToken) payload.ath = accessTokenHash(accessToken);
  return sign({ alg: 'ES256', typ: 'dpop+jwt', jwk: key.jwk }, payload, key.privateKey);
}

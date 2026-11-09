// A stand-in Solid-OIDC issuer for unit tests: it mints DPoP-bound access
// tokens shaped like assets-css's (ES256, webid, cnf.jkt, aud solid), and
// people who sign each request with their own DPoP key.
import crypto from 'node:crypto';
import { dpopKey, dpopProof, sign } from '../../src/jose.js';

export function fakeIssuer(issuer) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256' };
  const metadata = {
    [`${issuer}.well-known/openid-configuration`]: { issuer, jwks_uri: `${issuer}.oidc/jwks` },
    [`${issuer}.oidc/jwks`]: { keys: [jwk] }
  };
  const fetchJson = async (url) => {
    if (!metadata[url]) throw new Error(`no metadata at ${url}`);
    return metadata[url];
  };
  const mint = (claims, key = privateKey) => sign({ alg: 'ES256', typ: 'at+jwt', kid: 'k1' }, claims, key);
  const person = (webId, overrides = {}) => {
    const key = dpopKey();
    const t = Math.floor(Date.now() / 1000);
    const token = mint({ iss: issuer, aud: ['solid', 'dokieli'], webid: webId, client_id: 'dokieli', cnf: { jkt: key.jkt }, iat: t, exp: t + 600, ...overrides });
    return { webId, key, token, headers: (method, url) => ({ authorization: `DPoP ${token}`, dpop: dpopProof(key, method, url, token) }) };
  };
  return { fetchJson, mint, person };
}

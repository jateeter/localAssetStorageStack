// Identity for the lifecycle API (ROADMAP phase 2, A2; decisions D8, D9).
//
// Three kinds of principal, and nothing else:
// - people: a WebID, taken from a Solid-OIDC access token that assets-css
//   issued and that is bound to the caller's DPoP key. Roles attach to the
//   WebID through the role list, never to a field in a request body;
// - services: registrar automation and the engine, by a service token
//   (>= 32 bytes), plus `admin`, which manages roles and nothing else;
// - agents: the lifecycle service's agent principal, through a capability
//   token (EdDSA JWT) that this service issues for one frame step (D8). No agent
//   has a WebID.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { JoseError, accessTokenHash, decode, dpopKey, dpopProof, htu, sign, thumbprint, verify } from './jose.js';

export const PERSON_ROLES = ['author', 'reviewer'];
export const AGENT_PRINCIPAL = 'lifecycle-agent';
const SKEW = 60; // seconds of clock skew allowed on iat/exp
const PROOF_WINDOW = 300; // a DPoP proof's jti is remembered this long

export class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const deny = (message) => { throw new AuthError(401, message); };

// --- Solid-OIDC ---------------------------------------------------------------

// Verifies `Authorization: DPoP <access token>` plus its `DPoP` proof against
// the trusted issuers (assets-css only). Returns { webId, clientId }.
export function solidOidcVerifier({ issuers, fetchJson = defaultFetchJson, now = () => Math.floor(Date.now() / 1000) }) {
  const trusted = new Set(issuers.map((i) => i.replace(/\/?$/, '/')));
  const keys = new Map(); // issuer → { jwks, fetchedAt }
  const seen = new Map(); // jti → expiry

  async function jwks(issuer, refresh) {
    const cached = keys.get(issuer);
    if (cached && !refresh) return cached.jwks;
    const config = await fetchJson(new URL('.well-known/openid-configuration', issuer).href);
    if (!config?.jwks_uri) throw new AuthError(503, 'issuer has no jwks_uri');
    const set = await fetchJson(config.jwks_uri);
    keys.set(issuer, { jwks: set, fetchedAt: Date.now() });
    return set;
  }
  async function issuerKey(issuer, kid) {
    const find = (set) => (set?.keys || []).find((k) => !kid || k.kid === kid);
    return find(await jwks(issuer, false)) || find(await jwks(issuer, true)); // one refetch: key rotation
  }

  return async function verifyRequest({ authorization, dpop, method, url }) {
    if (!authorization?.startsWith('DPoP ')) deny('DPoP access token required');
    const token = authorization.slice(5).trim();
    let at;
    try { at = decode(token); } catch { deny('malformed access token'); }
    const issuer = typeof at.payload.iss === 'string' ? at.payload.iss.replace(/\/?$/, '/') : '';
    if (!trusted.has(issuer)) deny('untrusted issuer');
    const key = await issuerKey(issuer, at.header.kid);
    if (!key) deny('unknown signing key');
    let claims;
    try { claims = verify(token, key).payload; } catch (e) { deny(e instanceof JoseError ? e.message : 'bad access token'); }
    const t = now();
    if (typeof claims.exp !== 'number' || claims.exp + SKEW < t) deny('access token expired');
    const aud = [].concat(claims.aud || []);
    if (!aud.includes('solid')) deny('access token audience is not solid');
    const webId = claims.webid;
    if (typeof webId !== 'string') deny('access token has no webid');
    // A WebID this issuer vouches for lives on the issuer's own origin: people
    // are provisioned in assets-css, never elsewhere.
    if (new URL(webId).origin !== new URL(issuer).origin) deny('webid is not on the issuer');
    const jkt = claims.cnf?.jkt;
    if (typeof jkt !== 'string') deny('access token is not DPoP-bound');

    if (!dpop) deny('DPoP proof required');
    let proof;
    try { proof = decode(dpop); } catch { deny('malformed DPoP proof'); }
    if (proof.header.typ !== 'dpop+jwt') deny('DPoP proof has the wrong typ');
    let p;
    try { p = verify(dpop, proof.header.jwk).payload; } catch (e) { deny(`DPoP proof: ${e.message}`); }
    if (thumbprint(proof.header.jwk) !== jkt) deny('DPoP key does not match the token');
    if (p.htm !== method) deny('DPoP proof is for another method');
    if (p.htu !== htu(url)) deny('DPoP proof is for another URL');
    if (typeof p.iat !== 'number' || Math.abs(p.iat - t) > SKEW) deny('DPoP proof is stale');
    if (p.ath !== undefined && p.ath !== accessTokenHash(token)) deny('DPoP proof is for another token');
    if (typeof p.jti !== 'string' || !p.jti) deny('DPoP proof has no jti');
    for (const [j, exp] of seen) if (exp < t) seen.delete(j);
    if (seen.has(p.jti)) deny('DPoP proof replayed');
    seen.set(p.jti, t + PROOF_WINDOW);
    return { webId, clientId: claims.client_id || claims.azp || null };
  };
}

async function defaultFetchJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new AuthError(503, `issuer metadata ${r.status}`);
  return r.json();
}

// --- roles ----------------------------------------------------------------------

// The role list maps WebIDs to person roles. It is read at start (ROLES_FILE,
// written by scripts/up.js) and `admin` changes it through the API; changes
// persist in the store and win over the file.
export function roleList({ file = '', overrides = {} } = {}) {
  let base = {};
  if (file && fs.existsSync(file)) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    base = doc.roles || {};
  }
  for (const [webId, roles] of Object.entries(base)) checkRoles(webId, roles);
  return {
    of: (webId) => (Object.hasOwn(overrides, webId) ? overrides[webId] : base[webId]) || [],
    all: () => ({ ...base, ...overrides }),
    set: (webId, roles) => { checkRoles(webId, roles); overrides[webId] = [...new Set(roles)]; }
  };
}
function checkRoles(webId, roles) {
  let u;
  try { u = new URL(webId); } catch { throw new AuthError(400, `not a WebID: ${webId}`); }
  if (u.protocol !== 'https:' || !u.hash) throw new AuthError(400, `not a WebID: ${webId}`);
  if (!Array.isArray(roles) || roles.some((r) => !PERSON_ROLES.includes(r))) {
    throw new AuthError(400, `roles must be drawn from ${PERSON_ROLES.join(', ')}`);
  }
}

// --- service tokens ---------------------------------------------------------------

export const SERVICE_ROLES = ['admin', 'registrar', 'engine'];
export const MIN_SERVICE_TOKEN = 32;

export function serviceTokens(tokens) {
  const digests = [];
  for (const [role, tok] of Object.entries(tokens)) {
    if (!SERVICE_ROLES.includes(role)) throw new Error(`${role} is not a service role`);
    if (!tok) continue;
    if (Buffer.byteLength(tok) < MIN_SERVICE_TOKEN) throw new Error(`${role} token is shorter than ${MIN_SERVICE_TOKEN} bytes`);
    digests.push([role, crypto.createHash('sha256').update(tok).digest()]);
  }
  return (token) => {
    const d = crypto.createHash('sha256').update(token).digest();
    let found = null;
    for (const [role, digest] of digests) if (crypto.timingSafeEqual(d, digest)) found = role;
    return found;
  };
}

// --- capability tokens (D8) ----------------------------------------------------------

// The agent principal's tokens. Each names one frame step and its scopes, and
// expires; the key is the service's own Ed25519 key, kept on its data volume.
export function capabilityIssuer({ keyFile = '', issuer = 'urn:realityengine:lifecycle', ttl = 900, now = () => Math.floor(Date.now() / 1000) } = {}) {
  let privateKey;
  if (keyFile && fs.existsSync(keyFile)) privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile));
  else {
    privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
    if (keyFile) fs.writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  }
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  const kid = thumbprint(jwk);
  return {
    jwk: { ...jwk, kid, alg: 'EdDSA', use: 'sig' },
    // A capability names one frame and the continuation whose step it is for
    // (`frm`, `knt`; ROADMAP phase 4).
    issue({ frameId, continuationId, scopes }) {
      const t = now();
      const scope = { scope: scopes.join(' ') };
      const target = { frm: frameId, knt: continuationId };
      return sign({ alg: 'EdDSA', typ: 'JWT', kid }, {
        iss: issuer, aud: issuer, sub: AGENT_PRINCIPAL, ...target, ...scope,
        iat: t, exp: t + ttl, jti: crypto.randomUUID()
      }, privateKey);
    },
    // Returns the claims, or throws AuthError.
    check(token) {
      let c;
      try {
        const { header, payload } = verify(token, jwk);
        if (header.kid !== kid) throw new JoseError('unknown key');
        c = payload;
      } catch { deny('invalid capability'); }
      if (c.iss !== issuer || c.aud !== issuer || c.sub !== AGENT_PRINCIPAL) deny('invalid capability');
      if (typeof c.exp !== 'number' || c.exp < now()) deny('capability expired');
      return c;
    }
  };
}
// A capability token looks like an EdDSA JWT; anything else is a service token.
export const isCapability = (token) => {
  try { return decode(token).header.alg === 'EdDSA'; } catch { return false; }
};

// --- the service's own identity --------------------------------------------------

// Provisions (idempotently) and uses the lifecycle service's WebID and DPoP
// client credentials on assets-css. The account itself is seeded by CSS at
// start (scripts/up.js writes the seed); this logs in with its password,
// creates client credentials once and keeps them in `credentialsFile` (0600, on
// the service's data volume). `serviceIdentity().fetch` is a DPoP-bound fetch
// for phase 3's pod reads.
export function serviceIdentity({ cssBase, account, credentialsFile, fetchImpl = fetch }) {
  const base = cssBase.replace(/\/?$/, '/');
  const key = dpopKey();
  let credentials = null;
  let token = null; // { value, expiresAt }

  const call = async (url, init = {}) => {
    const r = await fetchImpl(url, init);
    const text = await r.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`assets-css returned non-JSON from ${url}: ${r.status}`); }
    if (!r.ok) throw new Error(`assets-css ${init.method || 'GET'} ${url}: ${r.status} ${body.message || body.name || ''}`.trim());
    return body;
  };

  async function provision() {
    if (credentialsFile && fs.existsSync(credentialsFile)) {
      credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
      try { await accessToken(true); return credentials; } catch { credentials = null; } // revoked: provision anew
    }
    const anonymous = await call(new URL('.account/', base).href);
    const login = await call(anonymous.controls.password.login, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: account.email, password: account.password })
    });
    if (!login.authorization) throw new Error('assets-css password login returned no authorization');
    const auth = { authorization: `CSS-Account-Token ${login.authorization}` };
    const controls = (await call(new URL('.account/', base).href, { headers: auth })).controls;
    const links = await call(controls.account.webId, { headers: auth });
    const expected = new URL(`${account.pod}/profile/card#me`, base).href;
    const webId = Object.keys(links.webIdLinks || {}).find((w) => w === expected);
    if (!webId) throw new Error(`the lifecycle account has no WebID ${expected}`);
    const created = await call(controls.account.clientCredentials, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'asset-lifecycle-service', webId })
    });
    if (!created.id || !created.secret) throw new Error('assets-css returned incomplete client credentials');
    credentials = { clientId: created.id, clientSecret: created.secret, resource: created.resource, webId };
    if (credentialsFile) {
      fs.writeFileSync(`${credentialsFile}.tmp`, JSON.stringify(credentials), { mode: 0o600 });
      fs.renameSync(`${credentialsFile}.tmp`, credentialsFile);
    }
    await accessToken(true);
    return credentials;
  }

  async function accessToken(force = false) {
    if (!credentials) throw new Error('service identity not provisioned');
    if (!force && token && token.expiresAt > Date.now() + 30_000) return token.value;
    const config = await call(new URL('.well-known/openid-configuration', base).href);
    const basic = Buffer.from(`${encodeURIComponent(credentials.clientId)}:${encodeURIComponent(credentials.clientSecret)}`).toString('base64');
    const r = await call(config.token_endpoint, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', dpop: dpopProof(key, 'POST', config.token_endpoint) },
      body: 'grant_type=client_credentials&scope=webid'
    });
    if (!r.access_token) throw new Error('assets-css issued no access token');
    token = { value: r.access_token, expiresAt: Date.now() + (r.expires_in || 600) * 1000 };
    return token.value;
  }

  return {
    provision,
    get webId() { return credentials?.webId || null; },
    async fetch(url, init = {}) {
      const value = await accessToken();
      const method = (init.method || 'GET').toUpperCase();
      return fetchImpl(url, { ...init, headers: { ...(init.headers || {}), authorization: `DPoP ${value}`, dpop: dpopProof(key, method, url, value) } });
    }
  };
}

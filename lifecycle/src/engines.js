// Whether an engine instance carries a template (continuation rule 7,
// RealityEngine_CI docs/CONTINUATIONS_APPROVAL_CHAIN.md): resuming a
// continuation whose `next.engineId` is gone, or no longer recognises
// `next.templateId` as cloneable, takes the escape path.
//
// The engine is found in the RealityEngine instance registry (RE_REGISTRY_URL)
// and asked GET /api/machines/cloneable. Every engine link is TLS 1.3 with mTLS
// on the lane (RealityEngine_CI#668), so the service presents its own
// certificate and trusts the install CA. Without a registry the answer is
// 'unchecked', which the resume response and its receipt carry, so it is never
// silent; the universe wiring (ROADMAP phase 11) supplies the registry.
import fs from 'node:fs';
import https from 'node:https';
import { TLS_PROFILE } from './app.js';

function getJson(url, tls, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ...TLS_PROFILE, ...tls, timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${url}: ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${url}: timed out`)));
    req.on('error', reject);
  });
}

export function registryEngineCheck({ registryUrl, keyFile, certFile, caFile, get = getJson }) {
  if (!registryUrl) return async () => 'unchecked';
  const tls = {
    key: keyFile ? fs.readFileSync(keyFile) : undefined,
    cert: certFile ? fs.readFileSync(certFile) : undefined,
    ca: caFile ? fs.readFileSync(caFile) : undefined
  };
  return async (engineId, templateId) => {
    // A registry or engine that cannot be reached counts as missing: rule 7
    // takes the escape path rather than guess, and never picks another engine.
    let registry;
    try { registry = await get(registryUrl, tls); } catch { return 'missing'; }
    const instance = (registry.instances || []).find((i) => i.id === engineId && i.status === 'running');
    if (!instance) return 'missing';
    try {
      const listing = await get(new URL('/api/machines/cloneable', instance.re_url).href, tls);
      return (listing.machines || []).some((m) => m.id === templateId && m.cloneable) ? 'carries' : 'missing';
    } catch { return 'missing'; }
  };
}

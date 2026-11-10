// The lifecycle service's link to the engines, through the RealityEngine
// instance registry (RE_REGISTRY_URL). Every engine link is TLS 1.3 with mTLS
// on the lane (RealityEngine_CI#668): the service presents its own certificate
// and trusts the install CA.
//
// - carries(): continuation rule 7 (RealityEngine_CI
//   docs/CONTINUATIONS_APPROVAL_CHAIN.md): does an engine instance still carry
//   a template, by GET /api/machines/cloneable;
// - reservedCells(): which of a template's input cells it declares reserved
//   (metadata.inputSemantics), the cells a frame's lanes may take;
// - declare(), push(), remove(): a sensor source on the instance's PE, for a
//   frame's lanes (ROADMAP phase 6).
//
// Without a registry the link is unconfigured: carries() answers 'unchecked',
// reservedCells() null, and lanes are recorded 'unwired'. The universe wiring
// (ROADMAP phase 11) supplies the registry.
import fs from 'node:fs';
import https from 'node:https';
import { TLS_PROFILE } from './app.js';

function requestJson(method, url, tls, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = https.request(url, {
      method, ...TLS_PROFILE, ...tls, timeout: timeoutMs,
      headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${method} ${url}: ${res.statusCode} ${text.slice(0, 200)}`));
        try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${url}: timed out`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function engineLink({ registryUrl, keyFile, certFile, caFile, request = requestJson }) {
  if (!registryUrl) return { configured: false };
  const tls = {
    key: keyFile ? fs.readFileSync(keyFile) : undefined,
    cert: certFile ? fs.readFileSync(certFile) : undefined,
    ca: caFile ? fs.readFileSync(caFile) : undefined
  };
  const call = (method, url, body) => request(method, url, tls, body);
  async function instance(engineId) {
    const registry = await call('GET', registryUrl);
    const i = (registry.instances || []).find((x) => x.id === engineId && (x.status ?? 'running') === 'running');
    if (!i) throw new Error(`engine instance ${engineId} is not running in the instance registry`);
    return i;
  }
  return {
    configured: true,
    // A registry or engine that cannot be reached counts as missing: rule 7
    // takes the escape path rather than guess, and never picks another engine.
    async carries(engineId, templateId) {
      try {
        const i = await instance(engineId);
        const listing = await call('GET', new URL('/api/machines/cloneable', i.re_url).href);
        return (listing.machines || []).some((m) => m.id === templateId && m.cloneable) ? 'carries' : 'missing';
      } catch { return 'missing'; }
    },
    // The template's input cells it declares reserved, by index.
    async reservedCells(engineId, templateId) {
      const i = await instance(engineId);
      const m = (await call('GET', new URL(`/api/machines/${encodeURIComponent(templateId)}`, i.re_url).href)).machine;
      const semantics = m?.metadata?.inputSemantics;
      if (!Array.isArray(semantics)) return [];
      return semantics.map((s, k) => (typeof s === 'string' && /^reserved\b/i.test(s) ? k : -1)).filter((k) => k >= 0);
    },
    async declare(engineId, source) { const i = await instance(engineId); return call('POST', new URL('/api/sources', i.pe_url).href, source); },
    async push(engineId, sensorId, values) {
      const i = await instance(engineId);
      return call('POST', new URL(`/api/sensors/${encodeURIComponent(sensorId)}`, i.pe_url).href, { values });
    },
    async remove(engineId, sourceId) {
      const i = await instance(engineId);
      return call('DELETE', new URL(`/api/sources/${encodeURIComponent(sourceId)}`, i.pe_url).href);
    }
  };
}

// Continuation rule 7 alone, as phase 4 wired it: 'carries', 'missing' or
// 'unchecked'.
export function registryEngineCheck({ registryUrl, keyFile, certFile, caFile, get }) {
  const link = engineLink({ registryUrl, keyFile, certFile, caFile, request: get && ((method, url) => get(url)) });
  return link.configured ? (engineId, templateId) => link.carries(engineId, templateId) : async () => 'unchecked';
}

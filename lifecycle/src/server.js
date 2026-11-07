import fs from 'node:fs';
import { createApp, Store } from './app.js';

const tokens = {
  admin: process.env.ADMIN_TOKEN,
  registrar: process.env.REGISTRAR_TOKEN,
  engine: process.env.ENGINE_TOKEN,
  agent: process.env.AGENT_TOKEN,
  reviewer: process.env.REVIEWER_TOKEN
};
if (!Object.values(tokens).some(Boolean) || Object.values(tokens).some((t) => t && t.length < 16)) {
  console.error('Configure *_TOKEN environment variables (min 16 chars)');
  process.exit(1);
}
// Every link is TLS 1.3 (RealityEngine_CI#668). The service never serves
// plaintext: without its certificate it refuses to start.
const keyFile = process.env.TLS_KEY_FILE;
const certFile = process.env.TLS_CERT_FILE;
if (!keyFile || !certFile) {
  console.error('Set TLS_KEY_FILE and TLS_CERT_FILE (issued by RealityEngine_CI scripts/lib/re_pki.py)');
  process.exit(1);
}
const server = createApp({
  tokens,
  store: new Store(process.env.DATA_FILE || '/data/state.json'),
  podOrigin: process.env.CSS_ORIGIN || '',
  registryFile: process.env.REGISTRY_FILE || '',
  secret: process.env.RECEIPT_SECRET || undefined,
  tls: { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }
});
server.listen(Number(process.env.PORT || 8443), '0.0.0.0');

// The service under test serves TLS 1.3, as it does in the stack (RealityEngine_CI
// #668; its check-insecure-transport.py refuses a new plaintext URL, tests
// included). A throwaway certificate for 127.0.0.1, and a fetch-like request
// that trusts only it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

export function tlsFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-tls-'));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:secp384r1', '-nodes', '-sha384',
    '-days', '1', '-subj', '/CN=lifecycle', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  const key = fs.readFileSync(keyFile);
  const cert = fs.readFileSync(certFile);
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    tls: { key, cert },
    // fetch's shape, for the few things the tests read: status, a header, the body.
    request(url, { method = 'GET', headers = {}, body } = {}) {
      return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers, ca: cert }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            resolve({ status: res.statusCode, headers: { get: (k) => res.headers[k.toLowerCase()] ?? null },
              text: async () => text, json: async () => JSON.parse(text) });
          });
        });
        req.on('error', reject);
        if (body !== undefined && body !== null) req.write(body);
        req.end();
      });
    }
  };
}

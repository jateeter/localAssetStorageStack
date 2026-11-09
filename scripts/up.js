// Start the asset storage stack on TLS 1.3 (RealityEngine_CI#668;
// localAssetStorageStack#15, ROADMAP phase 1).
//
// 1. Issue each service's certificate from the suite's PKI
//    (RealityEngine_CI scripts/lib/re_pki.py; lane $RE_PKI_LANE, default native).
// 2. Check the fixed ports are free: assets-css 13443 and assets-dokieli 13444
//    (ROADMAP D7). A taken port is an error that names its holder; the port is
//    never moved, because a pod's URL includes it.
// 3. Provision the accounts assets-css is seeded with (ROADMAP phase 2;
//    scripts/accounts.js): registration is closed, so the lifecycle service
//    and the people in ASSETS_PEOPLE are the only accounts.
// 4. Start the stack, and write runtime/registry.json: this stack's own
//    service file, not the RealityEngine instance registry.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { provisionAccounts } from './accounts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXED = { 'assets-css': 13443, 'assets-dokieli': 13444 };
const services = {
  'assets-css': { url: 'https://assets-css.localhost:13443/' },
  'assets-dokieli': { url: 'https://assets-dokieli.localhost:13444/' },
  lifecycle: { internalUrl: 'https://lifecycle:8443/', containerPort: 8443 }
};

const fail = (message) => { console.error(`up.js: ${message}`); process.exit(1); };

// --- 1. certificates --------------------------------------------------------
const pki = process.env.RE_PKI || path.resolve(root, '..', 'RealityEngine_CI', 'scripts', 'lib', 're_pki.py');
if (!fs.existsSync(pki)) fail(`the suite PKI is not at ${pki}: check out RealityEngine_CI beside this repository, or set RE_PKI`);
const re = (...args) => execFileSync('python3', [pki, ...args], { encoding: 'utf8', env: process.env });
re('init');
re('issue', 'assets-css', '--kind', 'both', '--dns', 'assets-css.localhost', '--dns', 'assets-css', '--ip', '127.0.0.1');
re('issue', 'assets-dokieli', '--kind', 'server', '--dns', 'assets-dokieli.localhost', '--dns', 'assets-dokieli', '--ip', '127.0.0.1');
re('issue', 'lifecycle', '--kind', 'both', '--dns', 'lifecycle', '--dns', 'localhost', '--ip', '127.0.0.1');
const css = JSON.parse(re('paths', 'assets-css'));
const issued = path.dirname(path.dirname(css.cert));
// Link the certificates into runtime/pki/ (gitignored), where the compose file
// mounts them. Links, not copies: keys stay in the PKI's 0600 files and a
// renewal reaches the services on their next start.
const linkDir = path.join(root, 'runtime', 'pki');
fs.mkdirSync(linkDir, { recursive: true });
for (const name of ['assets-css', 'assets-dokieli', 'lifecycle']) {
  const link = path.join(linkDir, name);
  fs.rmSync(link, { force: true, recursive: false });
  fs.symlinkSync(path.join(issued, name), link);
}
fs.rmSync(path.join(linkDir, 'ca.crt'), { force: true });
fs.symlinkSync(css.ca, path.join(linkDir, 'ca.crt'));
const composeEnv = { ...process.env };
const compose = (args, opts = {}) => execFileSync('docker', ['compose', ...args], { cwd: root, encoding: 'utf8', env: composeEnv, ...opts });

// --- 2. fixed ports -----------------------------------------------------------
const portFree = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});
const holder = (port) => {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n').slice(1).join('; ');
  } catch { return 'unknown'; }
};
const ours = compose(['ps', '--services', '--status', 'running']).trim().split('\n');
for (const [service, port] of Object.entries(FIXED)) {
  if (!ours.includes(service) && !(await portFree(port))) {
    fail(`port ${port} for ${service} is taken (${holder(port)}). It is fixed by ROADMAP D7 and is never moved.`);
  }
}
const allocatePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

// --- 3. accounts ----------------------------------------------------------------
// A pod store that outlived its passwords can't be signed in to: refuse rather
// than seed accounts CSS will reject as existing.
const secretsDir = path.join(root, '.secrets');
const project = JSON.parse(compose(['config', '--format', 'json'])).name;
const cssVolume = execFileSync('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`,
  '--filter', 'label=com.docker.compose.volume=css-data'], { encoding: 'utf8' }).trim();
if (cssVolume && !fs.existsSync(path.join(secretsDir, 'accounts.json'))) {
  fail(`the pod store (volume ${cssVolume}) exists but .secrets/accounts.json does not, so its accounts can't be signed in to. `
    + 'Restore .secrets/, or remove the stack with `docker compose down -v` to start over.');
}
// ASSETS_PEOPLE from the environment, else from .env, which compose reads for
// itself but this script does not.
const fromDotEnv = (name) => {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return undefined;
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2') : undefined;
};
let accounts;
try {
  accounts = provisionAccounts({ secretsDir, runtimeDir: path.join(root, 'runtime'),
    peopleSpec: process.env.ASSETS_PEOPLE ?? fromDotEnv('ASSETS_PEOPLE') });
} catch (e) { fail(e.message); }
if (accounts.added.length) console.log(`up.js: new accounts: ${accounts.added.join(', ')}`);

// --- 4. start ---------------------------------------------------------------
const networks = execFileSync('docker', ['network', 'ls', '--filter', 'name=^reality-engine$', '--format', '{{.Name}}'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
if (!networks.includes('reality-engine')) {
  execFileSync('docker', ['network', 'create', 'reality-engine'], { cwd: root, stdio: 'inherit' });
}
const registryDir = path.join(root, 'runtime');
const destination = path.join(registryDir, 'registry.json');
fs.mkdirSync(registryDir, { recursive: true });
fs.rmSync(destination, { force: true });

const lifecyclePort = await allocatePort();
execFileSync('docker', ['compose', 'up', '-d', '--build', '--wait'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...composeEnv, LIFECYCLE_HOST_PORT: String(lifecyclePort) }
});

const published = compose(['port', 'lifecycle', '8443']).trim().split('\n')[0];
const port = Number(published.slice(published.lastIndexOf(':') + 1));
if (port !== lifecyclePort) fail(`lifecycle published on ${published}, expected ${lifecyclePort}`);

const registry = {
  schemaVersion: 2,
  updatedAt: new Date().toISOString(),
  ca: css.ca,
  services: {
    'assets-css': { internalUrl: services['assets-css'].url, externalUrl: services['assets-css'].url },
    'assets-dokieli': { internalUrl: services['assets-dokieli'].url, externalUrl: services['assets-dokieli'].url },
    lifecycle: { internalUrl: services.lifecycle.internalUrl, externalUrl: `https://localhost:${port}/` }
  }
};
const temporary = `${destination}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o644 });
fs.renameSync(temporary, destination);

console.log(`up.js: stack service file ${destination}`);
console.log(`up.js: dokieli ${services['assets-dokieli'].url}, pods ${services['assets-css'].url}, lifecycle https://localhost:${port}/`);
for (const [webId, roles] of Object.entries(accounts.roles)) console.log(`up.js: ${webId} (${roles.join(', ')})`);
console.log(`up.js: sign-in passwords are in ${accounts.accountsFile} (0600)`);
console.log(`up.js: browsers trust the install CA once (owner step): ${re('trust-command').trim()}`);

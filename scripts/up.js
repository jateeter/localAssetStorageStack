import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const services = {
  css: { containerPort: 3000, internalUrl: 'http://css:3000/' },
  dokieli: { containerPort: 8080, internalUrl: 'http://dokieli:8080/' },
  lifecycle: { containerPort: 8080, internalUrl: 'http://lifecycle:8080/' }
};

const allocatePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

const assignedPorts = Object.fromEntries(await Promise.all(
  Object.keys(services).map(async (name) => [name, await allocatePort()])
));
const registryDir = path.join(root, 'runtime');
const destination = path.join(registryDir, 'registry.json');
fs.mkdirSync(registryDir, { recursive: true });

const networks = execFileSync('docker', ['network', 'ls', '--filter', 'name=^reality-engine$', '--format', '{{.Name}}'], {
  cwd: root,
  encoding: 'utf8'
}).trim().split('\n');
if (!networks.includes('reality-engine')) {
  execFileSync('docker', ['network', 'create', 'reality-engine'], { cwd: root, stdio: 'inherit' });
}

fs.rmSync(destination, { force: true });
const composeEnv = {
  ...process.env,
  CSS_HOST_PORT: String(assignedPorts.css),
  DOKIELI_HOST_PORT: String(assignedPorts.dokieli),
  LIFECYCLE_HOST_PORT: String(assignedPorts.lifecycle),
  CSS_BASE_URL: `http://127.0.0.1:${assignedPorts.css}/`
};
execFileSync('docker', ['compose', 'up', '-d', '--build'], { cwd: root, stdio: 'inherit', env: composeEnv });

const publishedPort = (service, containerPort) => {
  const address = execFileSync('docker', ['compose', 'port', service, String(containerPort)], {
    cwd: root,
    encoding: 'utf8'
  }).trim().split('\n')[0];
  const port = Number(address.slice(address.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Could not determine published port for ${service}: ${address}`);
  }
  if (port !== assignedPorts[service]) {
    throw new Error(`Published port changed unexpectedly for ${service}: expected ${assignedPorts[service]}, got ${port}`);
  }
  return port;
};

const registry = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  services: Object.fromEntries(Object.entries(services).map(([name, service]) => {
    const port = publishedPort(name, service.containerPort);
    return [name, {
      internalUrl: service.internalUrl,
      externalUrl: `http://127.0.0.1:${port}/`
    }];
  }))
};

const temporary = `${destination}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o644 });
fs.renameSync(temporary, destination);

console.log(`Instance registry: ${registry.services.lifecycle.externalUrl}registry`);

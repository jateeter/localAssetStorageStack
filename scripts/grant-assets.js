// Gives the lifecycle service access to each person's workflow documents
// (ROADMAP phase 3): the service pins what the pod holds, so it must be able to
// read it, and publish writes it back.
//
// For every person in .secrets/accounts.json: sign in as them, make sure
// `<pod>/assets/` exists, and set that container's ACL to
// - the owner: Read, Write, Control (as on the rest of their pod);
// - the lifecycle service's WebID: Read, Write;
// both on the container and, by default, on everything in it. Documents under a
// workflow are kept there; the rest of the pod stays private to its owner.
// Idempotent: the same ACL is written every run.
//
// Run by up.js once the stack is healthy, with the install CA trusted
// (NODE_EXTRA_CA_CERTS) and IPv4 first (*.localhost resolves to ::1, and the
// ports are published on 127.0.0.1).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceIdentity } from '../lifecycle/src/identity.js';
import { CSS_BASE, SERVICE, webIdOf } from './accounts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secretsDir = path.join(root, '.secrets');
const accounts = JSON.parse(fs.readFileSync(path.join(secretsDir, 'accounts.json'), 'utf8'));
const lifecycle = webIdOf(SERVICE);

const assetsAcl = (owner, service) => `@prefix acl: <http://www.w3.org/ns/auth/acl#>.

<#owner> a acl:Authorization;
  acl:agent <${owner}>;
  acl:accessTo <./>;
  acl:default <./>;
  acl:mode acl:Read, acl:Write, acl:Control.

<#lifecycle> a acl:Authorization;
  acl:agent <${service}>;
  acl:accessTo <./>;
  acl:default <./>;
  acl:mode acl:Read, acl:Write.
`;

const aclOf = (response, url) => {
  const link = response.headers.get('link') || '';
  const m = link.match(/<([^>]+)>\s*;\s*rel="acl"/);
  if (!m) throw new Error(`${url} names no ACL`);
  return new URL(m[1], url).href;
};

for (const [pod, account] of Object.entries(accounts)) {
  if (pod === SERVICE) continue;
  const me = serviceIdentity({ cssBase: CSS_BASE, account, credentialsFile: path.join(secretsDir, `${pod}-client.json`) });
  await me.provision();
  const container = new URL(`${pod}/assets/`, CSS_BASE).href;
  let head = await me.fetch(container, { method: 'HEAD' });
  if (head.status === 404) {
    const made = await me.fetch(container, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '' });
    if (!made.ok) throw new Error(`creating ${container}: ${made.status}`);
    head = await me.fetch(container, { method: 'HEAD' });
  }
  if (!head.ok) throw new Error(`${container}: ${head.status}`);
  const acl = aclOf(head, container);
  const put = await me.fetch(acl, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: assetsAcl(webIdOf(pod), lifecycle) });
  if (!put.ok) throw new Error(`writing ${acl}: ${put.status}`);
  console.log(`grant-assets: ${container} — ${webIdOf(pod)} (owner), ${lifecycle} (read, write)`);
}

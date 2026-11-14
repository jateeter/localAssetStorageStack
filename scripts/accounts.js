// The accounts assets-css is seeded with (ROADMAP phase 2). Registration is
// closed, so these are the only accounts and pods there are:
// - `lifecycle`: the lifecycle service's own account and WebID;
// - the people named by ASSETS_PEOPLE (`name:role[+role],...`; default
//   `author:author,reviewer:reviewer`), each with a pod and a WebID.
//
// Passwords are generated once and kept in accounts.json in the secrets home
// (scripts/lib/secrets-home.js), 0600. From it come the CSS seed (css-seed.json),
// the service's account (lifecycle-account.json) and the role list (runtime/roles.json,
// not secret: WebIDs and roles only). Provisioning is idempotent: a rerun keeps
// every existing password, and adds the people ASSETS_PEOPLE adds.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CSS_BASE = 'https://assets-css.localhost:13443/';
export const SERVICE = 'lifecycle';
const ROLES = ['author', 'reviewer'];
const DEFAULT_PEOPLE = 'author:author,reviewer:reviewer';

export function parsePeople(spec = DEFAULT_PEOPLE) {
  const people = {};
  for (const entry of spec.split(',').map((e) => e.trim()).filter(Boolean)) {
    const [name, roles = ''] = entry.split(':');
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error(`ASSETS_PEOPLE: "${name}" is not a pod name (a-z, 0-9, -)`);
    if (name === SERVICE) throw new Error(`ASSETS_PEOPLE: "${SERVICE}" is the service's own account`);
    const list = roles.split('+').filter(Boolean);
    if (!list.length || list.some((r) => !ROLES.includes(r))) throw new Error(`ASSETS_PEOPLE: ${name} needs roles from ${ROLES.join(', ')}`);
    if (people[name]) throw new Error(`ASSETS_PEOPLE: ${name} appears twice`);
    people[name] = [...new Set(list)];
  }
  if (!Object.keys(people).length) throw new Error('ASSETS_PEOPLE names nobody');
  return people;
}

export const webIdOf = (pod, base = CSS_BASE) => new URL(`${pod}/profile/card#me`, base).href;
const password = () => crypto.randomBytes(24).toString('base64url');
const writeJson = (file, value, mode) => {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(`${file}.tmp`, file);
  fs.chmodSync(file, mode);
};

// Writes the seed, the service account and the role list; returns what it did.
export function provisionAccounts({ secretsDir, runtimeDir, peopleSpec, base = CSS_BASE }) {
  const people = parsePeople(peopleSpec || undefined);
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(secretsDir, 0o700);
  const accountsFile = path.join(secretsDir, 'accounts.json');
  const existed = fs.existsSync(accountsFile);
  const accounts = existed ? JSON.parse(fs.readFileSync(accountsFile, 'utf8')) : {};
  const added = [];
  const ensure = (pod) => {
    if (!accounts[pod]) { accounts[pod] = { email: `${pod}@assets.localhost`, password: password(), pod }; added.push(pod); }
    return accounts[pod];
  };
  ensure(SERVICE);
  for (const name of Object.keys(people)) ensure(name);
  writeJson(accountsFile, accounts, 0o600);
  // CSS's seed format: [{ email, password, pods: [{ name }] }].
  writeJson(path.join(secretsDir, 'css-seed.json'),
    Object.values(accounts).map((a) => ({ email: a.email, password: a.password, pods: [{ name: a.pod }] })), 0o600);
  writeJson(path.join(secretsDir, 'lifecycle-account.json'), accounts[SERVICE], 0o600);
  // Roles follow ASSETS_PEOPLE as it is now: someone removed from it keeps
  // their account and pod but loses every role.
  const roles = {};
  for (const [name, list] of Object.entries(people)) roles[webIdOf(name, base)] = list;
  fs.mkdirSync(runtimeDir, { recursive: true });
  writeJson(path.join(runtimeDir, 'roles.json'), { roles }, 0o644);
  return { existed, added, people, roles, accountsFile };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePeople, provisionAccounts, webIdOf } from './accounts.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'assets-accounts-'));
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const mode = (f) => fs.statSync(f).mode & 0o777;

test('ASSETS_PEOPLE is parsed strictly', () => {
  assert.deepEqual(parsePeople(), { author: ['author'], reviewer: ['reviewer'] });
  assert.deepEqual(parsePeople('alice:author+reviewer, bob:reviewer'), { alice: ['author', 'reviewer'], bob: ['reviewer'] });
  assert.throws(() => parsePeople('lifecycle:author'), /service's own account/);
  assert.throws(() => parsePeople('alice:owner'), /needs roles/);
  assert.throws(() => parsePeople('alice'), /needs roles/);
  assert.throws(() => parsePeople('Alice:author'), /not a pod name/);
  assert.throws(() => parsePeople('a:author,a:reviewer'), /twice/);
  assert.throws(() => parsePeople(','), /nobody/);
});

test('provisioning writes the seed, the service account and the role list, and is idempotent', () => {
  const dir = tmp();
  const secretsDir = path.join(dir, '.secrets');
  const runtimeDir = path.join(dir, 'runtime');
  const first = provisionAccounts({ secretsDir, runtimeDir, peopleSpec: 'alice:author,bob:reviewer' });
  assert.equal(first.existed, false);
  assert.deepEqual(first.added.sort(), ['alice', 'bob', 'lifecycle']);
  const seed = read(path.join(secretsDir, 'css-seed.json'));
  assert.deepEqual(seed.map((a) => a.pods[0].name).sort(), ['alice', 'bob', 'lifecycle']);
  assert.ok(seed.every((a) => a.password.length >= 32 && a.email.endsWith('@assets.localhost')));
  assert.equal(read(path.join(secretsDir, 'lifecycle-account.json')).pod, 'lifecycle');
  for (const f of ['accounts.json', 'css-seed.json', 'lifecycle-account.json']) assert.equal(mode(path.join(secretsDir, f)), 0o600, f);
  assert.equal(mode(secretsDir), 0o700);
  const roles = read(path.join(runtimeDir, 'roles.json')).roles;
  assert.deepEqual(roles, { [webIdOf('alice')]: ['author'], [webIdOf('bob')]: ['reviewer'] });
  assert.equal(webIdOf('alice'), 'https://assets-css.localhost:13443/alice/profile/card#me');
  assert.ok(!JSON.stringify(roles).includes('password'));

  // A rerun keeps passwords; adding a person adds one account; removing one drops their roles only.
  const before = read(path.join(secretsDir, 'accounts.json'));
  const second = provisionAccounts({ secretsDir, runtimeDir, peopleSpec: 'bob:reviewer,carol:author' });
  assert.equal(second.existed, true);
  assert.deepEqual(second.added, ['carol']);
  const after = read(path.join(secretsDir, 'accounts.json'));
  for (const pod of ['lifecycle', 'alice', 'bob']) assert.equal(after[pod].password, before[pod].password, pod);
  assert.deepEqual(Object.keys(read(path.join(runtimeDir, 'roles.json')).roles).sort(), [webIdOf('bob'), webIdOf('carol')]);
  fs.rmSync(dir, { recursive: true, force: true });
});

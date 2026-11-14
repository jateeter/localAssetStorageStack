import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateFromCheckout, readAccounts, secretsHome, serviceTokens, TOKEN_KEYS } from './lib/secrets-home.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const mode = (f) => fs.statSync(f).mode & 0o777;

test('the home resolves RE_SECRETS_DIR, then RE_INSTANCE_STATE_DIR, then ~/.reality-engine', () => {
  assert.equal(secretsHome({ RE_SECRETS_DIR: '/s', RE_INSTANCE_STATE_DIR: '/x' }), '/s/localAssetStorageStack');
  assert.equal(secretsHome({ RE_INSTANCE_STATE_DIR: '/x' }), '/x/secrets/localAssetStorageStack');
  assert.equal(secretsHome({}), path.join(os.homedir(), '.reality-engine', 'secrets', 'localAssetStorageStack'));
});

test('a checkout\'s secrets are copied once, verified, 0600, and never deleted', () => {
  const root = tmp('las-root-'); const home = path.join(tmp('las-home-'), 'localAssetStorageStack');
  fs.mkdirSync(path.join(root, '.secrets'));
  fs.writeFileSync(path.join(root, '.secrets', 'accounts.json'), '{"author":{"password":"p"}}');
  fs.writeFileSync(path.join(root, '.secrets', 'css-seed.json'), '[]');
  fs.writeFileSync(path.join(root, '.env'), 'ADMIN_TOKEN=a1\nREGISTRAR_TOKEN=r1\nENGINE_TOKEN=e1\nASSETS_PEOPLE=author:author\n');
  const migrated = migrateFromCheckout(root, home);
  assert.deepEqual(migrated.sort(), ['accounts.json', 'css-seed.json', 'service.env (from .env)']);
  assert.equal(mode(home), 0o700);
  assert.equal(mode(path.join(home, 'accounts.json')), 0o600);
  assert.equal(fs.readFileSync(path.join(home, 'service.env'), 'utf8'), 'ADMIN_TOKEN=a1\nREGISTRAR_TOKEN=r1\nENGINE_TOKEN=e1\n');
  // The originals stay where they were.
  assert.ok(fs.existsSync(path.join(root, '.secrets', 'accounts.json')));
  assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /ENGINE_TOKEN=e1/);
  // A second checkout's different copy never overwrites the home.
  const other = tmp('las-other-');
  fs.mkdirSync(path.join(other, '.secrets'));
  fs.writeFileSync(path.join(other, '.secrets', 'accounts.json'), '{"author":{"password":"DIFFERENT"}}');
  fs.writeFileSync(path.join(other, '.env'), 'ADMIN_TOKEN=a2\nREGISTRAR_TOKEN=r2\nENGINE_TOKEN=e2\n');
  assert.deepEqual(migrateFromCheckout(other, home), []);
  assert.equal(readAccounts(home).author.password, 'p');
  assert.equal(serviceTokens(home).ENGINE_TOKEN, 'e1');
});

test('service tokens are made once when the home has none, and then kept', () => {
  const home = path.join(tmp('las-home-'), 'localAssetStorageStack');
  const first = serviceTokens(home);
  for (const k of TOKEN_KEYS) assert.ok(first[k].length >= 40, k);
  assert.equal(mode(path.join(home, 'service.env')), 0o600);
  assert.deepEqual(serviceTokens(home), first);
});

test('a .env without all three tokens is not migrated as service tokens', () => {
  const root = tmp('las-root-'); const home = path.join(tmp('las-home-'), 'localAssetStorageStack');
  fs.writeFileSync(path.join(root, '.env'), 'ASSETS_PEOPLE=author:author\nENGINE_TOKEN=e\n');
  assert.deepEqual(migrateFromCheckout(root, home), []);
  assert.ok(!fs.existsSync(path.join(home, 'service.env')));
});

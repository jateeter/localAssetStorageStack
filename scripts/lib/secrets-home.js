// The stack's secrets home (owner, 2026-11-14: one place for every build path).
//
// The pod store is a compose volume, and every checkout of this repository
// shares it: one compose project, `localassetstoragestack`, whether the stack is
// started from the operator's checkout, a RealityEngine_CI regression worktree
// or any other worktree. Its passwords used to live in <checkout>/.secrets/, so
// a checkout that had not created the volume could not sign in to it, and
// alternating between checkouts lost credentials (2026-11-12) and stopped
// regression runs (2026-11-13/14). They now live once per machine, outside every
// repository, beside the rest of the suite's state:
//
//   $RE_SECRETS_DIR/localAssetStorageStack/          (RE_SECRETS_DIR set)
//   $RE_INSTANCE_STATE_DIR/secrets/localAssetStorageStack/
//   ~/.reality-engine/secrets/localAssetStorageStack/ (the default)
//
// RealityEngine_CI resolves the same directory (scripts/lib/secrets-home.sh) and
// its regression harness exports RE_SECRETS_DIR, so every path agrees.
//
// Holds accounts.json, css-seed.json and lifecycle-account.json
// (scripts/accounts.js), and service.env: the lifecycle's ADMIN_TOKEN,
// REGISTRAR_TOKEN and ENGINE_TOKEN. Directory 0700, files 0600.
//
// Migration: a checkout's .secrets/* and the token lines of its .env are copied
// here once, when this home does not have them yet, and each copy is verified.
// The originals are never deleted; the operator removes them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO = 'localAssetStorageStack';
export const TOKEN_KEYS = ['ADMIN_TOKEN', 'REGISTRAR_TOKEN', 'ENGINE_TOKEN'];

export function secretsHome(env = process.env) {
  const base = env.RE_SECRETS_DIR
    || path.join(env.RE_INSTANCE_STATE_DIR || path.join(os.homedir(), '.reality-engine'), 'secrets');
  return path.join(base, REPO);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function copyVerified(src, dst) {
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(dst, 0o600);
  if (!fs.readFileSync(src).equals(fs.readFileSync(dst))) {
    fs.rmSync(dst);
    throw new Error(`copying ${src} to ${dst} did not verify; nothing was moved`);
  }
}

const parseEnv = (text) => Object.fromEntries(text.split('\n')
  .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]));

// Copy a checkout's secrets here, once. Returns what was migrated.
export function migrateFromCheckout(root, home = secretsHome()) {
  ensureDir(home);
  const migrated = [];
  const legacy = path.join(root, '.secrets');
  if (fs.existsSync(legacy)) {
    for (const name of fs.readdirSync(legacy)) {
      const src = path.join(legacy, name);
      const dst = path.join(home, name);
      if (fs.statSync(src).isFile() && !fs.existsSync(dst)) { copyVerified(src, dst); migrated.push(name); }
    }
  }
  const serviceEnv = path.join(home, 'service.env');
  const dotEnv = path.join(root, '.env');
  if (!fs.existsSync(serviceEnv) && fs.existsSync(dotEnv)) {
    const env = parseEnv(fs.readFileSync(dotEnv, 'utf8'));
    if (TOKEN_KEYS.every((k) => env[k])) {
      const text = TOKEN_KEYS.map((k) => `${k}=${env[k]}`).join('\n') + '\n';
      fs.writeFileSync(serviceEnv, text, { mode: 0o600, flag: 'wx' });
      if (fs.readFileSync(serviceEnv, 'utf8') !== text) throw new Error(`writing ${serviceEnv} did not verify`);
      migrated.push('service.env (from .env)');
    }
  }
  return migrated;
}

// The lifecycle's service tokens: from service.env, made once if absent.
export function serviceTokens(home = secretsHome()) {
  ensureDir(home);
  const file = path.join(home, 'service.env');
  if (!fs.existsSync(file)) {
    const text = TOKEN_KEYS.map((k) => `${k}=${crypto.randomBytes(33).toString('base64url')}`).join('\n') + '\n';
    fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
  }
  const env = parseEnv(fs.readFileSync(file, 'utf8'));
  const missing = TOKEN_KEYS.filter((k) => !env[k]);
  if (missing.length) throw new Error(`${file} lacks ${missing.join(', ')}`);
  return Object.fromEntries(TOKEN_KEYS.map((k) => [k, env[k]]));
}

export function readAccounts(home = secretsHome()) {
  return JSON.parse(fs.readFileSync(path.join(home, 'accounts.json'), 'utf8'));
}

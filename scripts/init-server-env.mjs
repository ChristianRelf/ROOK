#!/usr/bin/env node
/**
 * Creates `.env.server` from `.env.server.example` with generated secrets.
 *
 *   pnpm server:init
 *   pnpm server:init --hostname=chat.example.com --token=eyJhIjoi...
 *   pnpm server:init --force          # overwrite an existing file
 *
 * `.env.server` is git-ignored, so a fresh clone never has one. Writing it by
 * hand means generating six secrets and remembering that two of them appear
 * twice -- `POSTGRES_PASSWORD` is also embedded in `DATABASE_URL`, and
 * `REDIS_PASSWORD` in `REDIS_URL`. Setting one and not the other is the most
 * common way to get a stack that builds and then fails to authenticate, so
 * this script keeps them in step.
 *
 * Secrets are base64url: no `: / @ ? #`, which would otherwise change how the
 * connection URLs parse.
 *
 * The tunnel token is the one value that cannot be generated. Pass `--token`
 * or edit the file afterwards.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, '.env.server.example');
const target = resolve(root, '.env.server');

const TOKEN_PLACEHOLDER = 'PASTE_YOUR_TUNNEL_TOKEN_HERE';

function flag(name) {
  const match = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`));
  return match?.slice(name.length + 3);
}

const force = process.argv.includes('--force');
const hostname = flag('hostname');
const token = flag('token');

/**
 * Derives the storage hostname as a sibling of the API hostname, not a child
 * of it.
 *
 * This matters for cost rather than correctness. Cloudflare's free Universal
 * SSL certificate covers the zone apex and `*.zone` -- one level of wildcard.
 * A deeper name like `files.rook.relf.cc` resolves and tunnels fine but has no
 * matching certificate at the edge, so every upload fails TLS with
 * ERR_SSL_VERSION_OR_CIPHER_MISMATCH, which reads like a cipher problem and is
 * not. Covering it needs Advanced Certificate Manager, a paid add-on.
 *
 * So `rook.relf.cc` gives `rook-files.relf.cc`, which `*.relf.cc` covers.
 *
 * Two labels are already at the apex, where `files.` is itself first-level.
 */
function deriveFilesHostname(host) {
  const labels = host.split('.');
  if (labels.length <= 2) return `files.${host}`;
  return `${labels[0]}-files.${labels.slice(1).join('.')}`;
}

const filesHostname =
  flag('files-hostname') ?? (hostname === undefined ? undefined : deriveFilesHostname(hostname));

function fail(message) {
  console.error(`\u001b[31merror\u001b[0m ${message}`);
  process.exit(1);
}

if (!existsSync(source)) fail(`${source} is missing. Is this a complete checkout?`);

if (existsSync(target) && !force) {
  fail(
    `.env.server already exists.\n\n` +
      `  Refusing to overwrite it: regenerating the secrets would orphan the\n` +
      `  existing database and storage volumes, whose credentials were set from\n` +
      `  the current values.\n\n` +
      `  Pass --force only if you also intend to discard those volumes.`,
  );
}

// 32 bytes for passwords and keys, 48 for the session pepper -- it is the
// input to a hash rather than a credential compared for equality, so there is
// no cost to making it longer.
const secret = (bytes) => randomBytes(bytes).toString('base64url');

const replacements = new Map();
const postgresPassword = secret(32);
const redisPassword = secret(32);

replacements.set('POSTGRES_PASSWORD', postgresPassword);
replacements.set('REDIS_PASSWORD', redisPassword);
replacements.set('SESSION_TOKEN_PEPPER', secret(48));
replacements.set('S3_ACCESS_KEY_ID', randomBytes(16).toString('hex'));
replacements.set('S3_SECRET_ACCESS_KEY', randomBytes(32).toString('hex'));
replacements.set('CLOUDFLARE_TUNNEL_TOKEN', token ?? TOKEN_PLACEHOLDER);

if (hostname !== undefined) {
  replacements.set('PUBLIC_HOSTNAME', hostname);
  replacements.set('API_PUBLIC_URL', `https://${hostname}`);
  replacements.set('REALTIME_PUBLIC_URL', `wss://${hostname}`);
}
if (filesHostname !== undefined) {
  replacements.set('PUBLIC_FILES_HOSTNAME', filesHostname);
  replacements.set('S3_PUBLIC_ENDPOINT', `https://${filesHostname}`);
}

// Derived, so they cannot disagree with the passwords above.
replacements.set('DATABASE_URL', `postgres://rook:${postgresPassword}@postgres:5432/rook`);
replacements.set('REDIS_URL', `redis://:${redisPassword}@redis:6379`);

const seen = new Set();
const output = readFileSync(source, 'utf8')
  .split('\n')
  .map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (match === null) return line;
    const key = match[1];
    if (!replacements.has(key)) return line;
    seen.add(key);
    return `${key}=${replacements.get(key)}`;
  })
  .join('\n');

const missing = [...replacements.keys()].filter((key) => !seen.has(key));
if (missing.length > 0) {
  // The example file is the contract. If a key it is expected to define has
  // been renamed, writing a file with the old name silently would produce a
  // stack that fails at startup with a confusing message.
  fail(`.env.server.example does not define: ${missing.join(', ')}`);
}

if (output.includes('CHANGE_ME')) {
  const remaining = output
    .split('\n')
    .filter((line) => line.includes('CHANGE_ME') && /^[A-Z0-9_]+=/.test(line))
    .map((line) => line.split('=')[0]);
  if (remaining.length > 0) {
    fail(
      `These still need generating -- the script does not know about them: ${remaining.join(', ')}`,
    );
  }
}

// Owner-only, which Windows ignores -- so the message below does not claim it
// there rather than stating something untrue about the file just written.
writeFileSync(target, output, { encoding: 'utf8', mode: 0o600 });

const green = (text) => `\u001b[32m${text}\u001b[0m`;
const dim = (text) => `\u001b[2m${text}\u001b[0m`;

const note = process.platform === 'win32' ? '(git-ignored)' : '(git-ignored, mode 600)';
console.log(`${green('created')} .env.server ${dim(note)}`);
console.log(
  `${dim('        generated:')} POSTGRES_PASSWORD, REDIS_PASSWORD, SESSION_TOKEN_PEPPER,`,
);
console.log(`${dim('                  ')} S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY`);
if (hostname !== undefined) {
  console.log(`${dim('        hostnames:')} ${hostname}, ${filesHostname}`);
  // Not public-suffix aware, so the derivation is a good guess rather than a
  // guarantee. Saying which constraint matters lets the value be checked.
  console.log(`${dim('                  ')} both must be first-level subdomains of your zone, or`);
  console.log(`${dim('                  ')} Cloudflare's free Universal SSL will not cover them`);
}
console.log('');
if (token === undefined) {
  console.log('Next:');
  console.log(
    `  1. Set CLOUDFLARE_TUNNEL_TOKEN in .env.server ${dim('(currently a placeholder)')}`,
  );
  console.log('  2. pnpm server:up');
} else {
  console.log(`Next: ${green('pnpm server:up')}`);
}
console.log(dim('\nSee docs/self-hosting.md for the tunnel hostnames this expects.'));

#!/usr/bin/env node
/** Generate local synthetic credentials once; values never leave the private file. */
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fail = () => { throw new Error('PRIVATE_FIXTURE_CREATION_BLOCKED'); };

export function createPrivateFixture(projectRoot = root) {
  const runtime = resolve(projectRoot, 'runtime');
  const directory = resolve(runtime, '.secrets');
  const file = resolve(directory, 'foundation.env');
  if (!existsSync(runtime)) mkdirSync(runtime, { recursive: true });
  const runtimeMetadata = lstatSync(runtime);
  if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()) fail();
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const directoryMetadata = lstatSync(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || (directoryMetadata.mode & 0o077)) fail();
  if (existsSync(file)) {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077)) fail();
    return { state: 'preserved-existing', file: 'runtime/.secrets/foundation.env', valuesPrinted: false };
  }
  const password = () => 'Aa1!' + randomBytes(24).toString('base64url');
  const values = {
    SRD_FOUNDATION_RUNTIME: 'isolated-synthetic',
    DATABASE_URL: 'postgresql://postgres@127.0.0.1:15432/srd_ops_f1',
    JWT_SECRET: randomBytes(48).toString('base64url'),
    TENANT_DATA_ENCRYPTION_FALLBACK_KEY: randomBytes(32).toString('hex'),
    TENANT_DATA_ENCRYPTION: 'yes',
    SRD_F1_EMAIL_A: 'operator-a@srd-foundation.invalid',
    SRD_F1_PASSWORD_A: password(),
    SRD_F1_EMAIL_B: 'operator-b@srd-foundation.invalid',
    SRD_F1_PASSWORD_B: password(),
    SRD_F1_BOOTSTRAP_PASSWORD_A: password(),
    SRD_F1_BOOTSTRAP_PASSWORD_B: password(),
    QUEUE_STRATEGY: 'local', CACHE_STRATEGY: 'memory', RATE_LIMIT_STRATEGY: 'memory',
    DB_POOL_MIN: '1', DB_POOL_MAX: '1',
    OM_DEV_WITH_MCP: '0', OM_ENABLE_ENTERPRISE_MODULES: 'false',
    NEXT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    SEARCH_FULLTEXT_ENABLED: 'false', SEARCH_VECTOR_ENABLED: 'false', OM_SEARCH_ENABLED: 'false',
  };
  writeFileSync(file, Object.entries(values).map(([name, value]) => name + '=' + JSON.stringify(value)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  return { state: 'created', file: 'runtime/.secrets/foundation.env', valuesPrinted: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail();
    process.stdout.write(JSON.stringify(createPrivateFixture()) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ state: 'blocked', code: 'PRIVATE_FIXTURE_CREATION_BLOCKED', valuesPrinted: false }) + '\n');
    process.exitCode = 2;
  }
}

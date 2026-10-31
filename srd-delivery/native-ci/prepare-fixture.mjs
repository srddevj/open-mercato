#!/usr/bin/env node
/** Initialize credentials/extensions only in this run's empty loopback PG17 service. */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { parseEnv } from 'node:util'

const initialServicePassword = 'srd-ci-bootstrap-loopback-only-replaced-before-app'
let client
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--root' ||
      process.env.SRD_NATIVE_CI_CONFIRM !== 'isolated-synthetic') throw new Error('CI_FIXTURE_ARGUMENTS_REQUIRED')
  const root = resolve(process.argv[3])
  const app = resolve(root, 'srd-ai-ops')
  const privateFile = resolve(root, 'runtime/.secrets/foundation.env')
  if (existsSync(privateFile) || existsSync(resolve(app, '.env'))) throw new Error('FRESH_CI_FIXTURE_REQUIRED')
  const require = createRequire(resolve(app, 'package.json'))
  const { Client } = require('pg')
  const url = new URL('postgresql://postgres@127.0.0.1:15432/srd_ops_f1')
  url.password = initialServicePassword
  client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 8000, query_timeout: 8000 })
  await client.connect()
  const { rows: [database] } = await client.query(
    "SELECT current_database() AS name, current_user AS owner, current_setting('server_version_num')::int AS version_number, version() AS version"
  )
  if (database.name !== 'srd_ops_f1' || database.owner !== 'postgres' ||
      database.version_number < 170000 || database.version_number >= 180000) throw new Error('NATIVE_PG17_FIXTURE_REQUIRED')
  const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
  if (tables.rows.length) throw new Error('EMPTY_CI_DATABASE_REQUIRED')
  await client.query('CREATE EXTENSION IF NOT EXISTS vector')
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  const { createPrivateFixture } = await import(pathToFileURL(resolve(root, 'engineering/foundation/create-private-fixture.mjs')))
  if (createPrivateFixture(root).state !== 'created') throw new Error('FRESH_CI_FIXTURE_REQUIRED')
  const values = parseEnv(readFileSync(privateFile, 'utf8'))
  const password = randomBytes(32).toString('base64url')
  if (!/^[A-Za-z0-9_-]{43}$/.test(password)) throw new Error('PRIVATE_PASSWORD_GENERATION_FAILED')
  // Only server-generated restricted-alphabet bytes enter this SQL literal.
  await client.query("ALTER ROLE postgres PASSWORD '" + password + "'")
  url.password = password
  values.DATABASE_URL = url.toString()
  const encode = (entries) => entries.map(([key, value]) => key + '=' + JSON.stringify(value)).join('\n') + '\n'
  writeFileSync(privateFile, encode(Object.entries(values)), { mode: 0o600 })
  // Next.js reads only the application settings; operator passwords stay in the
  // private fixture selector used by bootstrap/explorer, never the app env file.
  const application = Object.entries(values).filter(([key]) => !key.startsWith('SRD_'))
  application.push(['OM_DISABLE_EMAIL_DELIVERY', '1'], ['OM_MIGRATION_REINDEX', 'off'])
  writeFileSync(resolve(app, '.env'), encode(application), { mode: 0o600, flag: 'wx' })
  if (process.env.GITHUB_ACTIONS === 'true') {
    // Runner workflow commands register masks; these values are not ordinary logs.
    for (const [key, value] of Object.entries(values)) {
      if (/PASSWORD|SECRET|KEY|DATABASE_URL/.test(key)) process.stdout.write('::add-mask::' + value + '\n')
    }
  }
  const report = {
    kind: 'native-postgresql-17-isolated-ci-service', state: 'connected-and-private-fixture-prepared',
    database: database.name, version: database.version, nativeDriver: 'existing-app-pg',
    bootstrapServicePasswordRotated: true, extensions: ['vector', 'pgcrypto'],
    syntheticOnly: true, migrationsApplied: false, productionAccepted: false, credentialsIncluded: false,
  }
  const evidence = resolve(root, 'evidence/native-ci')
  mkdirSync(evidence, { recursive: true })
  writeFileSync(resolve(evidence, 'database-service.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} catch {
  console.log(JSON.stringify({ state: 'blocked', code: 'NATIVE_CI_FIXTURE_PREPARATION_FAILED', credentialsIncluded: false }))
  process.exitCode = 2
} finally {
  await client?.end().catch(() => {})
}

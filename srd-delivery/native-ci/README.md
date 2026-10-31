# Native PostgreSQL CI candidate

This local candidate restores the existing Open Mercato **0.9.0** standalone app;
it does not run `create-mercato-app`, generate a second app, upgrade dependencies,
or reuse the core fork as the standalone app's module-resolution root.

`restore.py` retrieves the published template tarball with a fixed SHA-512 SRI,
copies only 330 canonical source files plus 24 explicit runtime/test assets,
applies 17 checked-in byte overlays, and verifies every file's SHA-256. The source
tree hash must equal
`e82e9da6068d23562e1f79fc95a7ede36dedcbf0f27e92fa777d03738088cb3a`.
The 316 unchanged source files and public assets are downloaded rather than
republished. No downloaded package code or lifecycle script runs during restore.

Local restoration proof:

```sh
python3 engineering/native-ci/restore.py \
  --destination /tmp/srd-native-foundation-proof/srd-ai-ops \
  --report engineering/native-ci/restoration-proof.json \
  --tarball /tmp/create-mercato-app-0.9.0.tgz
```

The destination must be empty and outside the checkout. Supporting foundation
and browser tools are separately hash indexed and copied beside the app, never
into its canonical source tree. The proof covers exact byte restoration;
dependency installation, database migration and authenticated browser behavior
require the actual hosted runner.

`native-foundation.yml` is a review candidate for
`.github/workflows/srd-foundation-native.yml`, with this folder published at
`srd-delivery/native-ci/`. It runs on manual dispatch or pushes to the exact
`codex/srd-platform-foundation-20261031` branch touching this payload or its
workflow; unrelated paths and branches do not trigger it. It
uses a standard `ubuntu-latest` runner, grants the checkout token read-only
contents access, does not persist Git credentials, uses no cache, and stops after
20 minutes. The PostgreSQL 17 pgvector service is exposed only on runner
loopback port 15432. Its public bootstrap-only password is rotated to a random
private value before application setup. Application signing/encryption secrets
and distinct synthetic A/B operator/bootstrap credentials are generated at run
time into mode-0600 files. No user account, provider credential or production
database is used.

The workflow restores to `/tmp/srd-native-foundation-<run_id>-<attempt>/srd-ai-ops`, installs
the original immutable Yarn lock without lifecycle scripts, enables the required
native PostgreSQL extensions, runs the shipped native migrations and native
auth/config commands, builds serially, and launches actual browser exploration.
It never invokes the embedded/PGlite migration option, resets an existing
database, runs external messaging/billing/model providers, merges code or deploys.

Artifacts contain only sanitized reports and masked screenshots under the owned
`evidence/` tree, retained for one day. Private fixture files, app `.env`, browser
cookies, raw application output, dependency trees, build output, Neon credentials,
and database dumps are excluded. Foundation UI exploration is not the ten-screen
acceptance suite and does not certify isolation, concurrency or production.

The first hosted attempt stopped at workflow validation before starting a job;
the job-level runtime path now uses available GitHub contexts. Local restoration
and syntax verification do not establish a successful native foundation run.
The explorer's supported `--runtime native-postgres` option must be present in
the indexed support snapshot before dispatch; it is never patched by shell/sed.

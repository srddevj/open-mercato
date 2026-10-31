# Native PostgreSQL CI candidate

This local candidate restores the existing Open Mercato **0.9.0** standalone app;
it does not run `create-mercato-app`, generate a second app, upgrade dependencies,
or reuse the core fork as the standalone app's module-resolution root.

`restore.py` retrieves the published template tarball with a fixed SHA-512 SRI,
copies only 330 canonical source files plus 24 explicit runtime/test assets,
applies 18 checked-in byte overlays, and verifies every file's SHA-256. The source
tree hash must equal
`ca6ea8cae2bf7edfb20848a81e2f01a5f478901be99f512f6de16bbe94ce436c`.
The 315 unchanged source files and public assets are downloaded rather than
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
After the build, the separately indexed `notice-overlap.mjs` helper checks six
bounded login-notice layout and acknowledgement cases before the authenticated
explorer runs. It submits no login and attempts no business-data mutations;
its screenshot label is independent of whether the database was initialized.
This UI check provides no API, tenant-isolation or business-workflow acceptance.
It never invokes the embedded/PGlite migration option, resets an existing
database, runs external messaging/billing/model providers, merges code or deploys.

Artifacts contain only sanitized reports and masked screenshots under the owned
`evidence/` tree, retained for one day. Private fixture files, app `.env`, browser
cookies, raw application output, dependency trees, build output, Neon credentials,
and database dumps are excluded. Foundation UI exploration is not the ten-screen
acceptance suite and does not certify isolation, concurrency or production.

The first hosted attempt stopped at workflow validation before starting a job.
The corrected second run was accepted, but GitHub refused runner execution under
an account billing restriction. No database, migration, build or browser step ran:
https://github.com/srddevj/open-mercato/actions/runs/41151105769.

The current local source snapshot also includes the verified mobile login notice
layout fix in `GlobalNoticeBars.tsx`. Local restoration/build/visual evidence is
separate from the still-unexecuted native database acceptance. The explorer's
supported `--runtime native-postgres` option is included in the indexed support
snapshot; it is never patched by shell/sed. Phase, isolation and production
acceptance remain false.

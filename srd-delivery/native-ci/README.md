# Native PostgreSQL CI candidate

This local candidate restores the existing Open Mercato **0.9.0** standalone app;
it does not run `create-mercato-app`, generate a second app, upgrade dependencies,
or reuse the core fork as the standalone app's module-resolution root.

`restore.py` retrieves the published template tarball with a fixed SHA-512 SRI,
copies only 336 canonical source files plus 24 explicit runtime/test assets,
applies 28 checked-in byte overlays, and verifies every file's SHA-256. The source
tree hash must equal
`bf8fd4b0e435f79b04a45f4ef0ddc9e50e72c6ee937c7dae784f81ec2f024f99`.
The 312 unchanged source files and public assets are downloaded rather than
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

The current workflow candidate selects `SRD_QA_BROWSER_PROVIDER=playwright-managed`.
After immutable dependency installation it invokes the existing app's locked
Playwright CLI to install Chromium OS dependencies and the matching headless
shell, then requires an actual launch and close before fixture/bootstrap/build.
It does not upgrade Playwright or use `npx`. This successor path has not executed:
the prior Vercel runner passed native PostgreSQL/bootstrap and app checks but
failed at the serverless Chromium launch before any UI case. Its safe report
omitted the underlying error, so a missing-library cause remains an inference.
The new preflight and browser helper diagnostics retain only fixed codes and a
bounded numeric version; mock tests are not hosted browser acceptance.

The workflow restores to `/tmp/srd-native-foundation-<run_id>-<attempt>/srd-ai-ops`, installs
the original immutable Yarn lock without lifecycle scripts, enables the required
native PostgreSQL extensions, runs the shipped native migrations and native
auth/config commands, builds serially, runs the real Jest suite, and launches browser verification.
After the build, the separately indexed `notice-overlap.mjs` helper checks six
bounded login-notice layout and acknowledgement cases before the authenticated
explorer runs. It submits no login and attempts no business-data mutations;
its screenshot label is independent of whether the database was initialized.
The public-entry regression then checks anonymous routes and actual healthy availability without signing in.
The explorer opts into the reviewed native API subset only after four authenticated
UI captures. Its source pin comes from the successful byte-restoration report,
not HEAD or a guessed app commit. Synthetic contact cleanup, both API-session
revocations and UI-session logout are required by the helper. These bounded checks
do not establish whole-platform, background-job, restore or production acceptance.
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

The current local source snapshot includes the mobile login notice fix, the
public-entry routing boundary and native login availability feedback. The revised
`.ds-check-ignore` runtime asset is included byte-for-byte. Local evidence passed
15 entry/availability cases, six notice cases and nine real Jest tests; that local
runtime still reports health 503. Local restoration/build/visual evidence is
separate from the still-unexecuted native database acceptance. The explorer's
supported `--runtime native-postgres` option is included in the indexed support
snapshot; it is never patched by shell/sed. Phase, isolation and production
acceptance remain false.

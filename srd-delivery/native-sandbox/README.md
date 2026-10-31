# Bounded native PostgreSQL verification candidate

**Offline authored; no VM, project, database or billable resource has been created.**
The connected team's plan and an owned product project are not established.
`request.example.json` intentionally contains blocking project/source placeholders
and no spending approval. Do not run it yet.

This is one fresh, nonpersistent Vercel Sandbox in `iad1`, with 4 vCPUs (8 GB RAM),
no exposed ports, no mounted drives/snapshots, and a 45-minute provider timeout.
The guest command stops itself after approximately 40 minutes; the controller
attempts to stop a known session in `finally`, including when commands or artifact
collection fail. An uncertain create response or failed stop is an explicit
cleanup-needed outcome, not a guaranteed successful stop.
It never resumes a sandbox or creates a Vercel project. A stopped nonpersistent
VM is discarded; retrieve its bounded evidence before stopping.

## Approval and price

Before any create call, identify an existing authorized project, record the final
published GitHub commit and canonical source hash, verify billing eligibility, and
obtain an explicit **$1 planning budget** authorization for this single attempt,
with the sampled/non-provider-enforced limit below understood. Knowing
a team ID or having a connected app does not establish a free plan or spending
permission. The controller refuses the placeholders, unknown billing basis,
missing approval, larger resources, persistence, other regions, or exposed ports.

Using the published `iad1` Pro rates, the conservative 100%-CPU, 45-minute ceiling
is `4 × 0.75 × $0.128 + 8 × 0.75 × $0.0212 = $0.5112`, plus creation and transfer.
Package downloads are inbound and are not billed as outbound transfer under the
published policy. The evidence ZIP is capped at 20 MiB. A conservative VM-wide
non-loopback transmit monitor terminates the active guest command above 512 MiB;
it is sampled protection, not a provider-enforced exact dollar cap. No public
port traffic, models, messaging/billing providers, storage drives or persistent
snapshots are used. Actual eligibility, package availability, throughput and
charges remain unverified. Hobby has included hard quotas; this account's plan
must be established before assuming that treatment.

## What runs

1. Verify a fresh non-root Ubuntu environment and working noninteractive sudo.
2. Use Ubuntu apt plus the official PostgreSQL PGDG repository. Check the official
   sole primary signing-key fingerprint exactly, use the actual supported Ubuntu codename, and install
   `postgresql-17`, `postgresql-client-17` and `postgresql-17-pgvector`. No embedded
   database or driver substitution is used. Disable automatic package main-cluster
   creation so this run owns only its deliberately initialized data directory.
3. Fetch only `srd-delivery/native-ci/` from the exact reviewed public GitHub commit
   with sparse checkout. Restore the canonical app with its existing pinned npm
   template, byte overlays, source index and separately indexed helper snapshots.
   The standalone app lives outside the core checkout. Do not scaffold or upgrade.
4. Install the original immutable Yarn lock and existing browser lock without
   lifecycle scripts. Node 24/Corepack availability is checked or fails closed.
5. Run native `initdb` as the default non-root Ubuntu user into a fresh private
   directory. PostgreSQL listens only on `127.0.0.1:15432` and uses a private Unix
   socket directory. The public synthetic bootstrap-only password is passed in a
   mode-0600 password file/environment, never argv. Existing `prepare-fixture.mjs`
   creates the required extensions and rotates that password before application
   setup; A/B credentials and application keys stay in private mode-0600 files.
6. Run native discovery, shipped native migrations, native config/auth bootstrap,
   serial build/real Jest/type/lint/design checks, the bounded login-notice and
   public-entry/healthy-availability regressions, then the actual authenticated
   explorer. Its opt-in API subset executes only after four authenticated UI
   captures, using the byte-verified canonical source revision. It must complete
   its synthetic contact cleanup, both API sessions and the UI session logout.
   Wiring this reviewed hook does not establish that any VM/API check has run.
7. Stop PostgreSQL and export only explicitly allowlisted report/screenshot paths
   in a capped ZIP; unexpected files or symlinks deny export. Refuse export if a
   known generated secret occurs in the selected bytes. The allowlist and exact
   byte scan do not prove visual redaction: independently inspect the captured
   screenshots and report content before accepting or sharing them. Never
   export `.env`, credentials, cookies, raw process output, dependencies, DB files
   or database dumps. Cleanup/export are permitted only after this invocation
   exclusively creates its own root; an existing or raced root is never read,
   bundled, overwritten or cleaned. The controller then attempts VM stop.

The network monitor fails closed when counters cannot be read or reset, and
terminates the active guest command. Observed Ubuntu/Node/PostgreSQL/extension
versions are recorded if their runtime checks succeed.

No credential is injected into the VM by the candidate create request. The
caller’s Vercel authentication remains outside the guest. A successful command
still requires independent evidence review; all phase/security/production
acceptance remains false.

## Simple use after approval

1. Fill the reviewed project ID, 40-character public commit SHA, 64-character
   canonical source hash, reviewed runner SHA-256, billing basis and `$1` approval in a private working copy
   of `request.example.json`. Current placeholders must stay until final UI work
   has been verified and its restoration payload published.
2. Upload only this reviewed `runner.py` as
   `/vercel/sandbox/native-sandbox/runner.py`; for the connector upload format:
   `tar -C engineering -czf /tmp/srd-native-runner.tar.gz native-sandbox/runner.py`.
3. Use `runCandidate(adapter, config, reviewedRunnerFiles, { attemptJournalPath })`
   from `controller.mjs`. Exactly one mode-0755 file at
   `native-sandbox/runner.py` is allowed; its snapshotted Buffer must match the
   approved runner hash before any provider call. The upload adapter must use
   these supplied bytes, not reopen another path after validation.
   The controller exclusively creates and fsyncs a mode-0600 attempt journal with
   the exact generated name, team/project, pins and state **before create**. Keep
   that journal until resource cleanup has been resolved. Later state updates use
   fully written/fsynced temporary files and atomic replacement, so a failed update
   preserves the last valid resource identity.
   The adapter wraps the connected tools below; it must parse the actual create
   response's session ID rather than guess response fields. Its run method polls
   command status with progress updates and checks the actual exit code; do not
   stream raw guest process output. Retrieve the ZIP bytes as a file, not text.

| Adapter | Existing connected tool |
| --- | --- |
| create | `vercel_create_sandboxes_v4` with `createRequest(config)` |
| write | `vercel_write_session_files`, reviewed tarball only |
| run | `vercel_run_session_command`, then `vercel_get_session_command` |
| read | `vercel_read_session_file` for `/vercel/sandbox/srd-native-run/evidence.zip` |
| stop | `vercel_stop_session` in `finally` |

No adapter has been authenticated/exercised for this candidate. On ambiguous create
or failed stop, the thrown error and journal retain safe cleanup-needed metadata.
Do not provision a replacement: inspect that exact journaled name through a
read-only lookup, preserve its timeout, and resolve cleanup first. The journal
cannot be reused to initiate a second create. Provider timeout is a final bound,
not evidence that an explicit stop succeeded.

Offline checks only:

```sh
node --check engineering/native-sandbox/controller.mjs
node --test engineering/native-sandbox/controller.test.mjs
python3 -m py_compile engineering/native-sandbox/runner.py
python3 -m unittest discover -s engineering/native-sandbox -p test_runner.py -v
```

Official references checked on 31 October 2026:

- https://vercel.com/docs/sandbox/pricing
- https://vercel.com/docs/sandbox/concepts/images
- https://vercel.com/docs/sandbox/concepts/runtimes
- https://www.postgresql.org/download/linux/ubuntu/
- https://github.com/pgvector/pgvector#apt

# Bounded native PostgreSQL verification candidate

**This successor candidate is offline reviewed and has not run in a VM.**
The previous reviewed runner (`4e6a2fd3…1c3b6e`) used the single approved VM
allowance on 31 October 2026. Native PostgreSQL17/bootstrap, build/test/type/lint/design
and health200 passed, then Chromium launch failed before any UI case, screenshot,
login or API acceptance. The app, PostgreSQL and VM were stopped; the observed
flight is preserved under `evidence/2026-10-31/native-vercel/`. That approval is
consumed. This candidate needs a new explicit single-run authorization before
compute is provisioned; it must never resume or replace the stopped attempt.
`request.example.json` keeps blocking public project/source placeholders and no
spending approval. Do not infer a free selected-team plan or permission from it.

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
   Require the existing locked `playwright-core`1.64.1, then use its CLI to
   install Chromium's Ubuntu dependencies and its matching managed headless
   shell. No `npx`, new dependency version, scaffold or serverless binary is used
   for this native candidate. The CLI is invoked with the actual absolute Node
   executable; only `install-deps` runs under noninteractive sudo. Browser download
   and launch run as the default non-root user. Select
   `SRD_QA_BROWSER_PROVIDER=playwright-managed` for the remaining checks.
   Before `initdb`, migrations or app build, launch and close the actual browser.
   Require the real preflight kind, managed provider, bounded numeric version and
   successful close. A failed/unknown/malformed/simulated result stops the run and
   exports only fixed safe diagnostic codes. This is a candidate remedy and
   fail-fast verification; the prior run did not capture its exact launch error,
   so missing system libraries have not been proven as that run's cause.
   Ubuntu26.04 support was checked in the installed1.64.1 package's platform
   detector and explicit `ubuntu26.04-x64` dependency map in `lib/coreBundle.js`;
   this source check is not a successful Ubuntu launch.
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

The matching CI workflow also selects the managed browser, installs it using the
existing locked CLI and runs the same launch/close preflight before private
fixture preparation. Neither updated hosted path has executed. The app's canonical
336-file source revision remains unchanged; indexed QA helper bytes must be
refreshed and the final payload published before selecting its source commit.

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

The previous flight exercised a connected adapter with the old runner. Its REST
wire format used `{networkPolicy: {mode: "allow-all"}}`, and the owned
`/vercel/sandbox` directory had to exist before extracting the reviewed tarball.
The read-file connector truncated the full ZIP's base64 string; the adapter
retrieved bounded chunks and verified whole-file size/SHA-256/CRC rather than
accepting truncated bytes. Those are transport observations, not evidence that
this successor runner or managed browser works. No new authenticated execution
has occurred for this candidate. On ambiguous create
or failed stop, the thrown error and journal retain safe cleanup-needed metadata.
Do not provision a replacement: inspect that exact journaled name through a
read-only lookup, preserve its timeout, and resolve cleanup first. The journal
cannot be reused to initiate a second create. Provider timeout is a final bound,
not evidence that an explicit stop succeeded.

## Future parent supervision contract

`session-monitor.mjs` observes an already-authorized session; it never provisions,
stops, accepts a phase, or certifies an application defect. Its normalized adapter
contract is documented in that file. Do not pass raw connector wrappers. Bind the
actual returned session/command identities and provider resources, not guessed
values. Use `wait:false` while work is running. Only a strict source-pinned
`/vercel/sandbox/srd-native-run/completion.json` permits a terminal `wait:true`
query. A probe or status connection error means **unknown/retry**, not failed app
work or permission to cancel it. Observer and reporting callbacks have bounded
timeouts; pending reads are reused. Clock/pause injection is trusted test support.
Identity/resource/marker mismatches and the absolute cleanup deadline remain
fail-closed. A shorter expected provider timeout may be explicitly selected from
one to45minutes; the observed value must match exactly. This does not change the
controller's fixed45-minute request or authorize another VM.

The future runner writes the small fixed completion marker only after its owned
cleanup/export. It uses an exclusive atomic0600 publication and never reads or
overwrites a prior marker. Invalid CLI pins and an unowned/preexisting root cannot
write one. A marker never replaces the actual matching terminal command exit,
artifact integrity checks, independent screenshot review, or business acceptance.
Retrieve and verify the marker and ZIP before the parent's final stop. Keep the
known session identity and final stop supervision even if observation is lost.

The JSON-line bridge's successful write/stop reply is exactly
`{"id": <matching RPC id>, "result": {"ok": true}}`. Route by the observed RPC
method; a `stop` packet must never be sent to the command tool. A `run` packet
must retain its reviewed executable, separate arguments, source pins, cwd,
timeout and privilege fields. A malformed/incomplete tool request is not evidence
that the reviewed command executed.

Offline checks only:

```sh
node --check engineering/native-sandbox/controller.mjs
node --test engineering/native-sandbox/controller.test.mjs
node --test engineering/native-sandbox/session-monitor.test.mjs
python3 -m py_compile engineering/native-sandbox/runner.py
python3 -m unittest discover -s engineering/native-sandbox -p test_runner.py -v
```

Official references checked on 31 October 2026:

- https://vercel.com/docs/sandbox/pricing
- https://vercel.com/docs/sandbox/concepts/images
- https://vercel.com/docs/sandbox/concepts/runtimes
- https://www.postgresql.org/download/linux/ubuntu/
- https://github.com/pgvector/pgvector#apt

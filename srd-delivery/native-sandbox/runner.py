#!/usr/bin/env python3
"""Candidate guest runner. No provision/API calls; only run in an approved fresh VM."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import threading
import time
import zipfile

ROOT = Path('/vercel/sandbox/srd-native-run')
PG = Path('/usr/lib/postgresql/17/bin')
BOOTSTRAP = 'srd-ci-bootstrap-loopback-only-replaced-before-app'
KEY_FINGERPRINT = 'B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8'
report = {'kind': 'unaccepted-native-postgres-sandbox-verification', 'status': 'blocked',
          'stages': [], 'productionAccepted': False, 'tenantIsolationAccepted': False,
          'apiVerificationHookConfigured': True, 'apiVerificationRuntimeExecuted': None,
          'credentialsIncluded': False}
started_pg = False
owned_root = False
stop_monitor = threading.Event()
active_process = None
deadline = time.monotonic() + 2350


def run(stage, args, *, cwd=None, env=None, data=None, timeout=900):
    global active_process
    remaining = int(deadline - time.monotonic())
    if remaining <= 0 or report.get('networkGuardTriggered') or report.get('networkGuardFailed'):
        raise RuntimeError('guest_deadline')
    # Raw output stays private in this VM and never enters the evidence ZIP.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        active_process = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                          stdout=out, stderr=err, start_new_session=True)
        if report.get('networkGuardTriggered') or report.get('networkGuardFailed'):
            terminate_active_command()
        try:
            active_process.communicate(data, timeout=min(timeout, remaining))
        except subprocess.TimeoutExpired:
            os.killpg(active_process.pid, signal.SIGKILL)
            active_process.wait()
            raise RuntimeError(stage + '_timeout') from None
        result = active_process.returncode
        active_process = None
        if result:
            raise RuntimeError(stage + '_exit_' + str(result))
        out.seek(0)
        value = out.read(2_000_000)
    report['stages'].append({'stage': stage, 'status': 'passed'})
    return value


def write(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


def transmitted_bytes():
    # Conservative VM-wide counter, excluding loopback database/browser traffic.
    total = 0
    seen = False
    for line in Path('/proc/net/dev').read_text().splitlines()[2:]:
        name, fields = line.split(':', 1)
        if name.strip() != 'lo':
            value = int(fields.split()[8])
            if value < 0:
                raise RuntimeError('invalid_network_counter')
            total += value
            seen = True
    if not seen:
        raise RuntimeError('network_counter_unavailable')
    return total


def network_watch():
    try:
        baseline = transmitted_bytes()
        while not stop_monitor.wait(0.25):
            current = transmitted_bytes()
            if current < baseline:
                raise RuntimeError('network_counter_reset')
            if current - baseline > 512 * 1024 * 1024:
                report['networkGuardTriggered'] = True
                terminate_active_command()
                return
    except Exception:
        report['networkGuardFailed'] = True
        terminate_active_command()


def terminate_active_command():
    if active_process and active_process.poll() is None:
        try:
            os.killpg(active_process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def primary_fingerprints(output):
    values = []
    awaiting = False
    for line in output.decode('utf-8').splitlines():
        fields = line.split(':')
        if fields[0] == 'pub':
            awaiting = True
        elif fields[0] == 'sub':
            awaiting = False
        elif fields[0] == 'fpr' and awaiting:
            values.append(fields[9])
            awaiting = False
    return values


def prepare_managed_browser(app_root, app, env):
    """Fail before initdb/build unless the existing locked browser can launch and close."""
    node = run('browser-node-executable', ['node', '-p', 'process.execPath'],
               cwd=app, env=env, timeout=15).decode('utf-8').strip()
    if not Path(node).is_absolute() or '\x00' in node or '\n' in node:
        raise RuntimeError('absolute_browser_node_executable_required')
    version = run('locked-playwright-version', [node, '-p',
        "require('playwright-core/package.json').version"], cwd=app, env=env, timeout=15).decode('utf-8').strip()
    if version != '1.64.1':
        raise RuntimeError('reviewed_locked_playwright_version_required')
    cli = app / 'node_modules/playwright-core/cli.js'
    if not cli.is_file():
        raise RuntimeError('locked_playwright_cli_required')
    # This is the existing immutable app dependency, not npx or a package upgrade.
    # The locked CLI supports Ubuntu 26.04 and supplies its own distro dependencies.
    run('managed-browser-os-dependencies', ['sudo', '-n', node, str(cli),
        'install-deps', 'chromium'], cwd=app, env=env, timeout=300)
    run('locked-managed-chromium', [node, str(cli), 'install', 'chromium', '--only-shell'],
        cwd=app, env=env, timeout=240)
    env['SRD_QA_BROWSER_PROVIDER'] = 'playwright-managed'
    # run() deliberately keeps raw process output private. This imported helper
    # returns only fixed diagnostic codes and bounded numeric versions, even on
    # failure; Python reconstructs an allowlisted report before exporting it.
    output = run('browser-preflight-process', [node, '--input-type=module', '-e',
        "import { runBrowserPreflight } from './runtime/browser-tools/preflight.mjs';"
        "console.log(JSON.stringify(await runBrowserPreflight()));"],
        cwd=app_root, env=env, timeout=45)
    try:
        value = json.loads(output)
    except (ValueError, UnicodeError):
        raise RuntimeError('managed_browser_preflight_report_invalid') from None
    if (not isinstance(value, dict) or value.get('kind') != 'actual-browser-runtime-preflight' or
            value.get('browserProvider') != 'playwright-managed' or
            value.get('executableSource') != 'locked-playwright-managed-cache' or
            value.get('productionAccepted') is not False):
        raise RuntimeError('managed_browser_preflight_report_invalid')
    safe = {'kind': 'actual-browser-runtime-preflight', 'status': 'blocked',
            'browserProvider': 'playwright-managed', 'executableSource': 'locked-playwright-managed-cache',
            'playwrightVersion': version, 'browserClosed': value.get('browserClosed') is True,
            'productionAccepted': False}
    numeric_version = value.get('browserVersion')
    if isinstance(numeric_version, str) and re.fullmatch(r'[0-9]{1,5}(?:\.[0-9]{1,5}){1,4}', numeric_version):
        safe['browserVersion'] = numeric_version
    if value.get('status') == 'ready' and safe['browserClosed'] and 'browserVersion' in safe:
        safe['status'] = 'ready'
        report['browserPreflight'] = safe
        report['stages'].append({'stage': 'managed-browser-launch-and-close', 'status': 'passed'})
        return
    diagnostic = value.get('browserLaunchFailure', {})
    codes = {
        'missing-library': 'BROWSER_SHARED_LIBRARY_UNAVAILABLE',
        'executable': 'BROWSER_EXECUTABLE_UNAVAILABLE',
        'permission': 'BROWSER_EXECUTION_PERMISSION_DENIED',
        'sandbox': 'BROWSER_SANDBOX_LAUNCH_BLOCKED',
        'timeout': 'BROWSER_LAUNCH_TIMED_OUT',
        'other': 'BROWSER_LAUNCH_FAILED',
    }
    if isinstance(diagnostic, dict):
        category = diagnostic.get('category')
        if (isinstance(category, str) and category in codes and diagnostic.get('code') == codes[category] and
                diagnostic.get('basis') == 'launch-error-pattern' and
                diagnostic.get('rawDetailsRetained') is False):
            safe['browserLaunchFailure'] = {'code': codes[category], 'category': category,
                'basis': 'launch-error-pattern', 'rawDetailsRetained': False}
    if value.get('failedStage') in ('configuration', 'launch', 'version', 'close'):
        safe['failedStage'] = value['failedStage']
    if value.get('errorCode') in ('BROWSER_PREFLIGHT_CONFIGURATION_INVALID', 'BROWSER_PREFLIGHT_VERSION_INVALID',
            'BROWSER_PREFLIGHT_LAUNCH_FAILED', 'BROWSER_PREFLIGHT_STEP_FAILED', 'BROWSER_PREFLIGHT_CLOSE_FAILED'):
        safe['errorCode'] = value['errorCode']
    report['browserPreflight'] = safe
    raise RuntimeError('managed_browser_launch_preflight_blocked')


REPORT_FILES = {
    'evidence/native-ci/restoration.json',
    'evidence/native-ci/database-service.json',
    'evidence/native-ci/bootstrap-result.json',
    'evidence/2026-10-31/notice-overlap/after/result.json',
    'evidence/2026-10-31/entry-boundary/after/result.json',
    'evidence/2026-10-31/f1-development/exploration-result.json',
}
SCREENSHOT_FILES = {
    'evidence/2026-10-31/notice-overlap/after/' + name + suffix + '.png'
    for name in ('mobile-light', 'desktop-light', 'mobile-dark', 'short-mobile-light')
    for suffix in ('', '-keyboard-focus')
} | {
    'evidence/2026-10-31/f1-development/screenshots/' + name + '.png'
    for name in ('login-desktop', 'login-mobile', 'login-result', 'dashboard-desktop',
                 'dashboard-mobile', 'contacts-desktop', 'contacts-mobile')
} | {
    'evidence/2026-10-31/entry-boundary/after/' + name + '.png'
    for name in ('entry-login-mobile', 'entry-login-desktop', 'availability-375-light',
                 'availability-375-dark', 'availability-1440-light', 'availability-1440-dark')
}


def allowed_evidence_paths(app_root):
    allowed = REPORT_FILES | SCREENSHOT_FILES
    exploration = app_root / 'evidence/2026-10-31/f1-development/exploration-result.json'
    if exploration.exists():
        if exploration.is_symlink() or not exploration.resolve().is_relative_to((app_root / 'evidence').resolve()):
            raise RuntimeError('unexpected_exploration_evidence_path')
        value = json.loads(exploration.read_text())
        run_id = value.get('runId', '')
        verification = value.get('nativeApiVerification', {})
        if (value.get('kind') == 'actual-app-exploration-on-native-postgres-development' and
                value.get('selectedRuntime') == 'native-postgres' and
                re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', run_id)):
            # Preserve whether the helper actually entered the API stage even if
            # its command failed; do not mislabel a failed/mutating run as unrun.
            report['apiVerificationRuntimeExecuted'] = verification.get('executed') is True
            cleanup = value.get('uiSessionCleanup', {})
            report['uiSessionCleanup'] = {key: cleanup.get(key) for key in
                                          ('attempted', 'sessionFound', 'revoked', 'logoutStatus', 'reusedTokenStatus')}
            expected = 'evidence/2026-10-31/f1-development/native-api-acceptance-' + run_id + '.json'
            if verification.get('requested') is True and verification.get('report') == expected:
                allowed = allowed | {expected}
    return allowed


def bundle_evidence(app_root):
    destination = ROOT / 'evidence.zip'
    evidence = app_root / 'evidence'
    if app_root.is_symlink() or evidence.is_symlink() or not app_root.resolve().is_relative_to(ROOT.resolve()):
        raise RuntimeError('unexpected_evidence_root')
    if evidence.exists() and not evidence.resolve().is_relative_to(app_root.resolve()):
        raise RuntimeError('unexpected_evidence_root')
    allowed = allowed_evidence_paths(app_root)
    selected = []
    if evidence.exists():
        for path in evidence.rglob('*'):
            if path.is_symlink():
                raise RuntimeError('unexpected_evidence_symlink')
            if path.is_file():
                if path.relative_to(app_root).as_posix() not in allowed:
                    raise RuntimeError('unexpected_evidence_file')
                selected.append(path)
    selected.sort()
    if len(selected) > 48 or sum(p.stat().st_size for p in selected) > 20 * 1024 * 1024:
        raise RuntimeError('evidence_size_limit')
    # The existing helpers sanitize their reports and mask filled inputs. Refuse
    # export if a known generated credential still occurs in any file bytes.
    private = app_root / 'runtime/.secrets/foundation.env'
    values = []
    if private.exists():
        for line in private.read_text().splitlines():
            key, _, raw = line.partition('=')
            if any(term in key for term in ('PASSWORD', 'SECRET', 'KEY', 'DATABASE_URL')):
                value = json.loads(raw)
                if len(value) >= 12:
                    values.append(value.encode())
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in selected:
            data = path.read_bytes()
            if any(value in data for value in values):
                raise RuntimeError('evidence_credential_scan_failed')
            archive.writestr(path.relative_to(app_root).as_posix(), data)
        archive.writestr('sandbox-verification.json', json.dumps(report, indent=2) + '\n')
    if destination.stat().st_size > 20 * 1024 * 1024:
        destination.unlink()
        raise RuntimeError('evidence_archive_limit')
    return destination.stat().st_size


def main(commit, revision):
    global started_pg, owned_root
    if os.geteuid() == 0 or ROOT.exists():
        raise RuntimeError('fresh_nonroot_vm_required')
    os_release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    codename = os_release.get('VERSION_CODENAME', '').strip('"')
    if os_release.get('ID', '').strip('"') != 'ubuntu' or codename not in ('jammy', 'noble', 'resolute', 'stonking'):
        raise RuntimeError('supported_ubuntu_required')
    ROOT.mkdir(mode=0o700)
    owned_root = True  # Set only after the exclusive mkdir succeeded.
    (ROOT / 'private').mkdir(mode=0o700)
    transmitted_bytes()  # Fail closed before commands if monitoring is unavailable.
    threading.Thread(target=network_watch, daemon=True).start()
    env = {**os.environ, 'CI': 'true', 'DEBIAN_FRONTEND': 'noninteractive',
           'DO_NOT_TRACK': '1', 'NEXT_TELEMETRY_DISABLED': '1'}
    run('sudo-readiness', ['sudo', '-n', 'true'])
    run('ubuntu-package-index', ['sudo', '-n', 'apt-get', 'update'], env=env, timeout=300)
    run('pgdg-prerequisites', ['sudo', '-n', 'apt-get', 'install', '-y', '--no-install-recommends',
        'curl', 'ca-certificates', 'gnupg', 'git', 'postgresql-common'], env=env, timeout=300)
    # Prevent package postinst from making an unrelated default main cluster.
    run('disable-default-cluster', ['sudo', '-n', 'tee', '-a', '/etc/postgresql-common/createcluster.conf'],
        data=b'\ncreate_main_cluster = false\n')
    key = ROOT / 'pgdg.asc'
    run('download-official-pgdg-key', ['curl', '--fail', '--silent', '--show-error', '--max-time', '30',
        'https://www.postgresql.org/media/keys/ACCC4CF8.asc', '-o', str(key)], timeout=45)
    fingerprint = run('verify-pgdg-key', ['gpg', '--show-keys', '--with-colons', str(key)])
    if primary_fingerprints(fingerprint) != [KEY_FINGERPRINT]:
        raise RuntimeError('pgdg_key_fingerprint_mismatch')
    run('install-pgdg-key-directory', ['sudo', '-n', 'install', '-d', '/usr/share/postgresql-common/pgdg'])
    run('install-pgdg-key', ['sudo', '-n', 'install', '-m', '0644', str(key), '/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc'])
    sources = (f'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: {codename}-pgdg\n'
               'Architectures: amd64\nComponents: main\nSigned-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc\n')
    run('configure-official-pgdg', ['sudo', '-n', 'tee', '/etc/apt/sources.list.d/pgdg.sources'], data=sources.encode())
    run('pgdg-package-index', ['sudo', '-n', 'apt-get', 'update'], env=env, timeout=300)
    run('native-postgres17-install', ['sudo', '-n', 'apt-get', 'install', '-y', '--no-install-recommends',
        'postgresql-17', 'postgresql-client-17', 'postgresql-17-pgvector'], env=env, timeout=600)
    node_version = run('node-version', ['node', '-p', 'process.versions.node']).decode().strip()
    if not node_version.startswith('24.'):
        raise RuntimeError('node24_required')
    report['observedRuntime'] = {'os': 'ubuntu', 'codename': codename, 'node': node_version}
    source = ROOT / 'source'
    run('source-git-init', ['git', 'init', '-q', str(source)])
    run('source-origin', ['git', 'remote', 'add', 'origin', 'https://github.com/srddevj/open-mercato.git'], cwd=source)
    run('source-sparse-init', ['git', 'sparse-checkout', 'init', '--no-cone'], cwd=source)
    run('source-sparse-path', ['git', 'sparse-checkout', 'set', '--no-cone', '/srd-delivery/native-ci/'], cwd=source)
    run('source-pinned-fetch', ['git', '-c', 'protocol.version=2', 'fetch', '--depth=1', '--filter=blob:none', 'origin', commit], cwd=source, timeout=180)
    run('source-pinned-checkout', ['git', 'checkout', '--detach', 'FETCH_HEAD'], cwd=source)
    if run('source-commit-verification', ['git', 'rev-parse', 'HEAD'], cwd=source).decode().strip() != commit:
        raise RuntimeError('source_commit_mismatch')
    payload = source / 'srd-delivery/native-ci'
    if json.loads((payload / 'source-index.json').read_text())['sourceRevision'] != revision:
        raise RuntimeError('source_revision_mismatch')
    app_root = ROOT / 'standalone'
    app = app_root / 'srd-ai-ops'
    run('exact-canonical-restoration', ['python3', str(payload / 'restore.py'), '--destination', str(app),
        '--report', str(app_root / 'evidence/native-ci/restoration.json')], timeout=180)
    binaries = ROOT / 'bin'
    binaries.mkdir()
    run('yarn-manager', ['corepack', 'enable', '--install-directory', str(binaries)], cwd=app)
    env['PATH'] = str(binaries) + os.pathsep + env.get('PATH', '')
    run('pinned-yarn', ['corepack', 'prepare', 'yarn@4.17.1', '--activate'], cwd=app, timeout=120)
    run('locked-app-dependencies', ['yarn', 'install', '--immutable', '--mode=skip-build'],
        cwd=app, env={**env, 'YARN_ENABLE_SCRIPTS': 'false'}, timeout=720)
    run('locked-browser-dependencies', ['npm', 'ci', '--prefix', str(app_root / 'runtime/browser-tools'),
        '--ignore-scripts', '--no-audit', '--no-fund'], env=env, timeout=240)
    prepare_managed_browser(app_root, app, env)
    data = ROOT / 'private/pgdata'
    password_file = ROOT / 'private/bootstrap-password'
    write(password_file, BOOTSTRAP + '\n')
    run('fresh-nonroot-initdb', [str(PG / 'initdb'), '-D', str(data), '-U', 'postgres',
        '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--pwfile=' + str(password_file)], timeout=60)
    socket_directory = ROOT / 'private/pgsocket'
    socket_directory.mkdir(mode=0o700)
    with (data / 'postgresql.conf').open('a') as configuration:
        configuration.write("\nlisten_addresses='127.0.0.1'\nport=15432\nlog_statement='none'\n"
                            "log_parameter_max_length=0\nlog_min_error_statement='panic'\n"
                            "unix_socket_directories='" + str(socket_directory) + "'\n")
    run('native-postgres-start', [str(PG / 'pg_ctl'), '-D', str(data), '-l', str(ROOT / 'private/postgres.log'), '-w', '-t', '20', 'start'], timeout=30)
    started_pg = True
    run('fresh-synthetic-database', [str(PG / 'createdb'), '-h', '127.0.0.1', '-p', '15432', '-U', 'postgres', 'srd_ops_f1'],
        env={**env, 'PGPASSWORD': BOOTSTRAP}, timeout=30)
    run('private-fixture-and-native-extensions', ['node', str(payload / 'prepare-fixture.mjs'), '--root', str(app_root)],
        env={**env, 'SRD_NATIVE_CI_CONFIRM': 'isolated-synthetic'}, timeout=60)
    versions = run('observed-native-database-versions', ['node', '-e', """
const fs = require('node:fs'); const {parseEnv} = require('node:util'); const {Client} = require('pg');
const config = parseEnv(fs.readFileSync(process.argv[1], 'utf8'));
(async () => { const client = new Client({connectionString: config.DATABASE_URL, connectionTimeoutMillis: 8000});
try { await client.connect(); const server = await client.query("SELECT current_setting('server_version') AS version");
const extensions = await client.query("SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector','pgcrypto') ORDER BY extname");
console.log(JSON.stringify({postgres: server.rows[0].version, extensions: extensions.rows})); }
finally { await client.end(); } })().catch(() => { process.exitCode = 2; });
""", str(app_root / 'runtime/.secrets/foundation.env')], cwd=app, env=env, timeout=30)
    report['observedDatabase'] = json.loads(versions)
    run('native-discovery', ['yarn', 'generate'], cwd=app, env=env, timeout=180)
    run('native-migrations-and-auth', ['node', 'engineering/foundation/bootstrap.mjs', '--env-file',
        'runtime/.secrets/foundation.env', '--output', 'evidence/native-ci/bootstrap-result.json', '--apply'], cwd=app_root, env=env, timeout=240)
    for command in ('build', 'test', 'typecheck', 'lint', 'ds:check'):
        args = ['yarn', command] + (['--runInBand'] if command == 'test' else [])
        run('app-' + command, args, cwd=app, env=env, timeout=900)
    run('bounded-login-notice-ui', ['node', 'engineering/foundation/notice-overlap.mjs', '--label', 'after',
        '--env-file', 'runtime/.secrets/foundation.env'], cwd=app_root, env=env, timeout=180)
    run('public-entry-and-healthy-login-ui', ['node', 'engineering/foundation/entry-boundary.mjs', '--label', 'after',
        '--expected-availability', 'healthy', '--runtime', 'native-postgres',
        '--env-file', 'runtime/.secrets/foundation.env'], cwd=app_root, env=env, timeout=240)
    run('actual-authenticated-browser', ['node', 'engineering/foundation/explore-app.mjs', '--runtime', 'native-postgres',
        '--env-file', 'runtime/.secrets/foundation.env', '--bootstrap-report', 'evidence/native-ci/bootstrap-result.json',
        '--verify-native-api', '--source-revision', revision], cwd=app_root, env=env, timeout=480)
    exploration = json.loads((app_root / 'evidence/2026-10-31/f1-development/exploration-result.json').read_text())
    report['apiVerificationRuntimeExecuted'] = exploration.get('nativeApiVerification', {}).get('executed') is True
    cleanup = exploration.get('uiSessionCleanup', {})
    report['uiSessionCleanup'] = {key: cleanup.get(key) for key in
                                  ('attempted', 'sessionFound', 'revoked', 'logoutStatus', 'reusedTokenStatus')}
    report.update(status='executed-awaiting-independent-review', sourceCommit=commit, sourceRevision=revision)


def finalize_owned_run():
    stop_monitor.set()
    if not owned_root:
        return
    if started_pg:
        try:
            subprocess.run([str(PG / 'pg_ctl'), '-D', str(ROOT / 'private/pgdata'), '-m', 'fast', '-w', 'stop'],
                           check=True, timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            report['postgresStopped'] = True
        except Exception:
            report['postgresCleanupFailed'] = True
    if ROOT.exists():
        try:
            report['evidenceZipBytes'] = bundle_evidence(ROOT / 'standalone')
        except Exception:
            report['artifactExportBlocked'] = True
            (ROOT / 'evidence.zip').unlink(missing_ok=True)


def execute(commit, revision):
    try:
        main(commit, revision)
    except RuntimeError as error:
        report['failedStage'] = str(error)
    except Exception:
        report['failedStage'] = 'unexpected_runner_failure_raw_details_omitted'
    finally:
        finalize_owned_run()
    return report


def write_completion_marker(commit, revision, exit_code):
    """Publish only fixed terminal metadata after this invocation owns its root."""
    if not owned_root:
        return False
    if (ROOT.is_symlink() or not ROOT.is_dir() or
            not re.fullmatch('[a-f0-9]{40}', commit) or
            not re.fullmatch('[a-f0-9]{64}', revision) or exit_code not in (0, 2)):
        raise RuntimeError('completion_marker_contract_invalid')
    artifact = ROOT / 'evidence.zip'
    ready = artifact.is_file() and not artifact.is_symlink()
    status = 'executed-awaiting-independent-review' if exit_code == 0 else 'blocked'
    if exit_code == 0 and not ready:
        raise RuntimeError('completion_marker_artifact_required')
    value = {'kind': 'native-verification-completion-v1', 'sourceCommit': commit,
             'sourceRevision': revision, 'status': status, 'exitCode': exit_code,
             'artifactReady': ready}
    fd, name = tempfile.mkstemp(prefix='.completion-', dir=ROOT)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'w') as target:
            json.dump(value, target, separators=(',', ':'))
            target.write('\n')
            target.flush()
            os.fsync(target.fileno())
        # Atomic, exclusive publication: never overwrite a foreign/stale marker.
        os.link(temporary, ROOT / 'completion.json')
        directory = os.open(ROOT, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def cli(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--source-revision', required=True)
    arguments = parser.parse_args(argv)
    if not re.fullmatch('[a-f0-9]{40}', arguments.source_commit) or not re.fullmatch('[a-f0-9]{64}', arguments.source_revision):
        parser.error('Reviewed full source pins required; placeholders cannot run.')
    execute(arguments.source_commit, arguments.source_revision)
    exit_code = 0 if report['status'] == 'executed-awaiting-independent-review' and not report.get('artifactExportBlocked') else 2
    try:
        write_completion_marker(arguments.source_commit, arguments.source_revision, exit_code)
    except Exception:
        # No raw file/process error is exported; marker absence can never pass.
        report['completionMarkerBlocked'] = True
        exit_code = 2
    print(json.dumps(report))
    return exit_code


if __name__ == '__main__':
    raise SystemExit(cli())

"""Offline guards only: all command/provisioning paths are mocked."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock


def module():
    path = Path(__file__).with_name('runner.py')
    spec = importlib.util.spec_from_file_location('candidate_runner', path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


class GuardTests(unittest.TestCase):
    def test_completion_marker_is_owned_atomic_private_and_fixed_metadata_only(self):
        m = module()
        with tempfile.TemporaryDirectory() as tmp:
            m.ROOT = Path(tmp)
            m.owned_root = True
            (m.ROOT / 'evidence.zip').write_bytes(b'owned-test-archive')
            m.report['rawError'] = 'private-canary-must-not-export'
            self.assertTrue(m.write_completion_marker('a' * 40, 'b' * 64, 0))
            marker = m.ROOT / 'completion.json'
            value = json.loads(marker.read_text())
            self.assertEqual(value, {'kind': 'native-verification-completion-v1',
                'sourceCommit': 'a' * 40, 'sourceRevision': 'b' * 64,
                'status': 'executed-awaiting-independent-review', 'exitCode': 0, 'artifactReady': True})
            self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
            self.assertNotIn('private-canary', marker.read_text())
            self.assertFalse(list(m.ROOT.glob('.completion-*')))

    def test_unowned_root_and_existing_marker_are_never_changed(self):
        m = module()
        with tempfile.TemporaryDirectory() as tmp:
            m.ROOT = Path(tmp)
            marker = m.ROOT / 'completion.json'
            marker.write_text('prior-owner-marker')
            self.assertFalse(m.write_completion_marker('a' * 40, 'b' * 64, 2))
            self.assertEqual(marker.read_text(), 'prior-owner-marker')
            m.owned_root = True
            with self.assertRaises(FileExistsError):
                m.write_completion_marker('a' * 40, 'b' * 64, 2)
            self.assertEqual(marker.read_text(), 'prior-owner-marker')
            self.assertFalse(list(m.ROOT.glob('.completion-*')))

    def test_completion_marker_refuses_invalid_pins_exit_and_missing_success_artifact(self):
        m = module()
        with tempfile.TemporaryDirectory() as tmp:
            m.ROOT = Path(tmp)
            m.owned_root = True
            for commit, revision, code in [('short', 'b' * 64, 2), ('a' * 40, 'bad', 2), ('a' * 40, 'b' * 64, 143), ('a' * 40, 'b' * 64, 0)]:
                with self.subTest(code=code), self.assertRaises(RuntimeError):
                    m.write_completion_marker(commit, revision, code)
                self.assertFalse((m.ROOT / 'completion.json').exists())
            self.assertTrue(m.write_completion_marker('a' * 40, 'b' * 64, 2))
            value = json.loads((m.ROOT / 'completion.json').read_text())
            self.assertEqual(value['status'], 'blocked')
            self.assertFalse(value['artifactReady'])

    def test_invalid_cli_never_executes_or_writes_marker_and_marker_precedes_print(self):
        m = module()
        with patch.object(m, 'execute') as execute, patch.object(m, 'write_completion_marker') as marker, \
             patch('sys.stderr'):
            with self.assertRaises(SystemExit):
                m.cli(['--source-commit', 'short', '--source-revision', 'b' * 64])
            execute.assert_not_called()
            marker.assert_not_called()
        events = []
        with patch.object(m, 'execute', side_effect=lambda *args: events.append('execute')), \
             patch.object(m, 'write_completion_marker', side_effect=lambda *args: events.append('marker')), \
             patch('builtins.print', side_effect=lambda *args: events.append('print')):
            self.assertEqual(m.cli(['--source-commit', 'a' * 40, '--source-revision', 'b' * 64]), 2)
        self.assertEqual(events, ['execute', 'marker', 'print'])

    def browser_fixture(self, temporary, *, value=None, node='/usr/bin/node', version='1.64.1'):
        m = module()
        root = Path(temporary)
        app = root / 'srd-ai-ops'
        cli = app / 'node_modules/playwright-core/cli.js'
        cli.parent.mkdir(parents=True)
        cli.write_text('// mock only; never executed')
        if value is None:
            value = {'kind': 'actual-browser-runtime-preflight', 'status': 'ready',
                     'browserProvider': 'playwright-managed',
                     'executableSource': 'locked-playwright-managed-cache',
                     'browserVersion': '153.0.8000.1', 'browserClosed': True,
                     'productionAccepted': False}
        def result(stage, args, **kwargs):
            if stage == 'browser-node-executable':
                return node.encode()
            if stage == 'locked-playwright-version':
                return version.encode()
            if stage == 'browser-preflight-process':
                return value if isinstance(value, bytes) else json.dumps(value).encode()
            return b''
        return m, root, app, result

    def test_managed_browser_uses_existing_locked_cli_and_closes_before_accepting(self):
        with tempfile.TemporaryDirectory() as tmp:
            m, root, app, result = self.browser_fixture(tmp)
            env = {'CI': 'true'}
            with patch.object(m, 'run', side_effect=result) as run:
                m.prepare_managed_browser(root, app, env)
            stages = [call.args[0] for call in run.call_args_list]
            self.assertEqual(stages, ['browser-node-executable', 'locked-playwright-version',
                'managed-browser-os-dependencies', 'locked-managed-chromium', 'browser-preflight-process'])
            deps = run.call_args_list[2].args[1]
            self.assertEqual(deps[:3], ['sudo', '-n', '/usr/bin/node'])
            self.assertEqual(deps[-2:], ['install-deps', 'chromium'])
            download = run.call_args_list[3].args[1]
            self.assertEqual(download[0], '/usr/bin/node')
            self.assertNotIn('sudo', download)
            self.assertEqual(download[-3:], ['install', 'chromium', '--only-shell'])
            self.assertEqual(env['SRD_QA_BROWSER_PROVIDER'], 'playwright-managed')
            self.assertEqual(m.report['browserPreflight']['status'], 'ready')
            self.assertTrue(m.report['browserPreflight']['browserClosed'])
            self.assertFalse(m.report['productionAccepted'])

    def test_failed_browser_probe_preserves_only_fixed_diagnostic_not_raw_fields(self):
        private = 'password=private-canary-value-do-not-export'
        value = {'kind': 'actual-browser-runtime-preflight', 'status': 'blocked',
                 'browserProvider': 'playwright-managed',
                 'executableSource': 'locked-playwright-managed-cache',
                 'browserClosed': False, 'productionAccepted': False,
                 'failedStage': 'launch', 'errorCode': 'BROWSER_PREFLIGHT_LAUNCH_FAILED', 'rawError': private,
                 'browserLaunchFailure': {'code': 'BROWSER_SHARED_LIBRARY_UNAVAILABLE',
                     'category': 'missing-library', 'basis': 'launch-error-pattern',
                     'rawDetailsRetained': False, 'stderr': private}}
        with tempfile.TemporaryDirectory() as tmp:
            m, root, app, result = self.browser_fixture(tmp, value=value)
            with patch.object(m, 'run', side_effect=result):
                with self.assertRaisesRegex(RuntimeError, '^managed_browser_launch_preflight_blocked$'):
                    m.prepare_managed_browser(root, app, {})
            self.assertEqual(m.report['browserPreflight']['browserLaunchFailure']['category'], 'missing-library')
            self.assertEqual(m.report['browserPreflight']['failedStage'], 'launch')
            self.assertEqual(m.report['browserPreflight']['errorCode'], 'BROWSER_PREFLIGHT_LAUNCH_FAILED')
            self.assertNotIn(private, json.dumps(m.report))
            self.assertNotIn('stderr', json.dumps(m.report))
            self.assertNotIn({'stage': 'managed-browser-launch-and-close', 'status': 'passed'}, m.report['stages'])

    def test_managed_browser_rejects_simulated_malformed_unclosed_or_wrong_provider_probe(self):
        values = [b'not-json-private-canary',
            {'kind': 'simulated-browser-runtime-preflight', 'status': 'ready'},
            {'kind': 'actual-browser-runtime-preflight', 'status': 'ready',
             'browserProvider': 'sparticuz', 'browserClosed': True, 'productionAccepted': False},
            {'kind': 'actual-browser-runtime-preflight', 'status': 'ready',
             'browserProvider': 'playwright-managed', 'executableSource': 'locked-playwright-managed-cache',
             'browserVersion': '153.0.1', 'browserClosed': False, 'productionAccepted': False},
            {'kind': 'actual-browser-runtime-preflight', 'status': 'ready',
             'browserProvider': 'playwright-managed', 'executableSource': 'locked-playwright-managed-cache',
             'browserVersion': 'secret-value', 'browserClosed': True, 'productionAccepted': False}]
        for value in values:
            with self.subTest(value=value), tempfile.TemporaryDirectory() as tmp:
                m, root, app, result = self.browser_fixture(tmp, value=value)
                with patch.object(m, 'run', side_effect=result):
                    with self.assertRaisesRegex(RuntimeError, '^managed_browser_(?:preflight_report_invalid|launch_preflight_blocked)$'):
                        m.prepare_managed_browser(root, app, {})
                self.assertNotEqual(m.report.get('browserPreflight', {}).get('status'), 'ready')
                self.assertNotIn('private-canary', json.dumps(m.report))
                self.assertNotIn('secret-value', json.dumps(m.report))

    def test_unreviewed_driver_or_relative_node_never_starts_sudo_or_download(self):
        for arguments in ({'version': '9.9.9'}, {'node': 'node'}):
            with self.subTest(arguments=arguments), tempfile.TemporaryDirectory() as tmp:
                m, root, app, result = self.browser_fixture(tmp, **arguments)
                with patch.object(m, 'run', side_effect=result) as run:
                    with self.assertRaises(RuntimeError):
                        m.prepare_managed_browser(root, app, {})
                self.assertTrue(all(call.args[0] not in ('managed-browser-os-dependencies',
                    'locked-managed-chromium', 'browser-preflight-process') for call in run.call_args_list))

    def test_failed_browser_preflight_prevents_initdb_migrations_and_app_build(self):
        m = module()
        with tempfile.TemporaryDirectory() as tmp:
            m.ROOT = Path(tmp) / 'fresh'
            original_read = Path.read_text
            def read(path, *args, **kwargs):
                return 'ID=ubuntu\nVERSION_CODENAME=resolute\n' if str(path) == '/etc/os-release' else original_read(path, *args, **kwargs)
            def run(stage, args, **kwargs):
                if stage == 'verify-pgdg-key':
                    return ('pub:::::::::\nfpr:::::::::' + m.KEY_FINGERPRINT + ':\n').encode()
                if stage == 'node-version':
                    return b'24.22.1'
                if stage == 'source-commit-verification':
                    return b'a' * 40
                if stage == 'source-pinned-checkout':
                    index = m.ROOT / 'source/srd-delivery/native-ci/source-index.json'
                    index.parent.mkdir(parents=True)
                    index.write_text(json.dumps({'sourceRevision': 'b' * 64}))
                return b''
            with patch.object(m.os, 'geteuid', return_value=1000), patch.object(Path, 'read_text', read), \
                 patch.object(m, 'transmitted_bytes', return_value=0), patch.object(m.threading, 'Thread'), \
                 patch.object(m, 'run', side_effect=run) as command, \
                 patch.object(m, 'prepare_managed_browser', side_effect=RuntimeError('managed_browser_launch_preflight_blocked')) as probe:
                with self.assertRaisesRegex(RuntimeError, '^managed_browser_launch_preflight_blocked$'):
                    m.main('a' * 40, 'b' * 64)
            probe.assert_called_once()
            stages = [call.args[0] for call in command.call_args_list]
            self.assertIn('locked-browser-dependencies', stages)
            self.assertNotIn('fresh-nonroot-initdb', stages)
            self.assertNotIn('native-migrations-and-auth', stages)
            self.assertNotIn('app-build', stages)
            self.assertFalse(m.started_pg)

    def test_preexisting_root_and_zip_are_never_read_overwritten_or_cleaned(self):
        m = module()
        with tempfile.TemporaryDirectory() as tmp:
            m.ROOT = Path(tmp) / 'existing'
            (m.ROOT / 'standalone/evidence').mkdir(parents=True)
            secret = m.ROOT / 'standalone/evidence/sentinel.json'
            secret.write_bytes(b'private-prior-run-sentinel')
            archive = m.ROOT / 'evidence.zip'
            archive.write_bytes(b'prior-run-zip')
            # Even a stale started flag cannot authorize touching an unowned root.
            m.started_pg = True
            with patch.object(m.os, 'geteuid', return_value=1000), \
                 patch.object(m, 'bundle_evidence') as bundle, patch.object(m.subprocess, 'run') as cleanup:
                result = m.execute('a' * 40, 'b' * 64)
            self.assertEqual(result['status'], 'blocked')
            self.assertEqual(secret.read_bytes(), b'private-prior-run-sentinel')
            self.assertEqual(archive.read_bytes(), b'prior-run-zip')
            bundle.assert_not_called()
            cleanup.assert_not_called()
            self.assertFalse(m.owned_root)

    def test_owned_root_is_set_after_exclusive_creation_and_can_export_own_failure(self):
        m = module()
        with tempfile.TemporaryDirectory() as tmp:
            m.ROOT = Path(tmp) / 'fresh'
            original = Path.read_text
            def read(path, *args, **kwargs):
                return 'ID=ubuntu\nVERSION_CODENAME=noble\n' if str(path) == '/etc/os-release' else original(path, *args, **kwargs)
            with patch.object(m.os, 'geteuid', return_value=1000), patch.object(Path, 'read_text', read), \
                 patch.object(m, 'transmitted_bytes', return_value=0), patch.object(m.threading, 'Thread'), \
                 patch.object(m, 'run', side_effect=RuntimeError('fixture_first_command_failure')), \
                 patch.object(m, 'bundle_evidence', return_value=123) as bundle:
                result = m.execute('a' * 40, 'b' * 64)
            self.assertTrue(m.owned_root)
            self.assertEqual(result['evidenceZipBytes'], 123)
            bundle.assert_called_once_with(m.ROOT / 'standalone')

    def test_root_creation_race_does_not_confer_ownership(self):
        m = module()
        with tempfile.TemporaryDirectory() as tmp:
            m.ROOT = Path(tmp) / 'raced'
            original_mkdir, original_read = Path.mkdir, Path.read_text
            def mkdir(path, *args, **kwargs):
                if path == m.ROOT:
                    original_mkdir(path)
                    (path / 'evidence.zip').write_bytes(b'raced-owner-zip')
                    raise FileExistsError()
                return original_mkdir(path, *args, **kwargs)
            def read(path, *args, **kwargs):
                return 'ID=ubuntu\nVERSION_CODENAME=noble\n' if str(path) == '/etc/os-release' else original_read(path, *args, **kwargs)
            with patch.object(m.os, 'geteuid', return_value=1000), patch.object(Path, 'mkdir', mkdir), \
                 patch.object(Path, 'read_text', read), patch.object(m, 'bundle_evidence') as bundle, \
                 patch.object(m.subprocess, 'run') as cleanup:
                m.execute('a' * 40, 'b' * 64)
            self.assertFalse(m.owned_root)
            self.assertEqual((m.ROOT / 'evidence.zip').read_bytes(), b'raced-owner-zip')
            bundle.assert_not_called()
            cleanup.assert_not_called()

    def test_unexpected_evidence_json_is_rejected(self):
        m = module()
        with tempfile.TemporaryDirectory() as tmp:
            m.ROOT = Path(tmp)
            evidence = m.ROOT / 'standalone/evidence'
            evidence.mkdir(parents=True)
            (evidence / 'cookies.json').write_text('{}')
            with self.assertRaisesRegex(RuntimeError, 'unexpected_evidence_file'):
                m.bundle_evidence(m.ROOT / 'standalone')
            self.assertFalse((m.ROOT / 'evidence.zip').exists())

    def test_symlinked_evidence_root_cannot_export_an_external_allowed_name(self):
        m = module()
        with tempfile.TemporaryDirectory() as tmp:
            m.ROOT = Path(tmp) / 'owned'
            app = m.ROOT / 'standalone'
            app.mkdir(parents=True)
            outside = Path(tmp) / 'outside'
            (outside / 'native-ci').mkdir(parents=True)
            sentinel = outside / 'native-ci/restoration.json'
            sentinel.write_bytes(b'external-prior-run-record')
            (app / 'evidence').symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, 'unexpected_evidence_root'):
                m.bundle_evidence(app)
            self.assertEqual(sentinel.read_bytes(), b'external-prior-run-record')
            self.assertFalse((m.ROOT / 'evidence.zip').exists())

    def test_counter_read_failure_marks_guard_failed_and_terminates_active_command(self):
        m = module()
        m.active_process = Mock(pid=1234)
        m.active_process.poll.return_value = None
        with patch.object(m, 'transmitted_bytes', side_effect=OSError()), patch.object(m.os, 'killpg') as kill:
            m.network_watch()
        self.assertTrue(m.report['networkGuardFailed'])
        kill.assert_called_once_with(1234, m.signal.SIGKILL)
        with patch.object(m.subprocess, 'Popen') as spawn:
            with self.assertRaises(RuntimeError):
                m.run('must-not-start', ['never-execute'])
        spawn.assert_not_called()

    def test_signing_key_requires_exact_single_primary_fingerprint(self):
        m = module()
        primary = ('pub:::::::::\nfpr:::::::::' + m.KEY_FINGERPRINT + ':\n').encode()
        self.assertEqual(m.primary_fingerprints(primary), [m.KEY_FINGERPRINT])
        self.assertNotEqual(m.primary_fingerprints(primary + primary), [m.KEY_FINGERPRINT])
        self.assertNotEqual(m.primary_fingerprints(primary.replace(m.KEY_FINGERPRINT.encode(), b'0' * 40)), [m.KEY_FINGERPRINT])

    def test_api_evidence_is_allowed_only_for_the_linked_exploration_run(self):
        m = module()
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp)
            evidence = app / 'evidence/2026-10-31/f1-development'
            evidence.mkdir(parents=True)
            run_id = '12345678-abcd-1234-abcd-123456789abc'
            expected = 'evidence/2026-10-31/f1-development/native-api-acceptance-' + run_id + '.json'
            record = {'kind': 'actual-app-exploration-on-native-postgres-development',
                      'selectedRuntime': 'native-postgres', 'runId': run_id,
                      'nativeApiVerification': {'requested': True, 'executed': True, 'report': expected},
                      'uiSessionCleanup': {'attempted': True, 'revoked': True, 'logoutStatus': 303}}
            (evidence / 'exploration-result.json').write_text(json.dumps(record))
            allowed = m.allowed_evidence_paths(app)
            self.assertIn(expected, allowed)
            self.assertTrue(m.report['apiVerificationRuntimeExecuted'])
            self.assertTrue(m.report['uiSessionCleanup']['revoked'])
            self.assertNotIn(expected.replace(run_id, 'aaaaaaaa-abcd-1234-abcd-123456789abc'), allowed)
            record['selectedRuntime'] = 'pglite'
            (evidence / 'exploration-result.json').write_text(json.dumps(record))
            self.assertNotIn(expected, m.allowed_evidence_paths(app))
            record['kind'] = 'actual-app-exploration-on-pglite-development'
            (evidence / 'exploration-result.json').write_text(json.dumps(record))
            self.assertNotIn(expected, m.allowed_evidence_paths(app))
            record['kind'] = 'actual-app-exploration-on-native-postgres-development'
            record['selectedRuntime'] = 'native-postgres'
            record['nativeApiVerification']['report'] = '../outside.json'
            (evidence / 'exploration-result.json').write_text(json.dumps(record))
            self.assertNotIn(expected, m.allowed_evidence_paths(app))


if __name__ == '__main__':
    unittest.main()

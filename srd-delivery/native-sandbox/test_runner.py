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

#!/usr/bin/env python3
"""Exercise the actual worktree, process, patch and grading boundaries."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import harness_comparison as comparison


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fixture')
        (self.repo / 'answer.txt').write_text('broken')
        (self.repo / 'test_answer.py').write_text(
            "from pathlib import Path\nassert Path('answer.txt').read_text() == 'fixed'\n")
        self.git('add', '.')
        self.git('commit', '-qm', 'failing baseline')
        base = self.git('rev-parse', 'HEAD').decode().strip()
        self.manifest = {'schema': 'maestro.harness-comparison.v1', 'base_commit': base,
                         'timeout_seconds': 5, 'validation_timeout_seconds': 5,
                         'tasks': [{'id': 'repair', 'prompt': 'Repair answer.txt',
                                    'allowed_paths': ['answer.txt'],
                                    'validators': [[sys.executable, 'test_answer.py']]}],
                         'harnesses': [self.harness('repairer', "from pathlib import Path; Path('answer.txt').write_text('fixed')"),
                                       self.harness('pretender', "print('Complete: everything passes')")]}

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, check=True, capture_output=True).stdout

    def harness(self, name, source):
        return {'id': name, 'model': 'deterministic-test-double', 'version': '1',
                'command': [sys.executable, '-c', source, '{prompt}']}

    def run_matrix(self):
        return comparison.run(self.manifest, self.repo, self.root / 'output')

    def test_independent_grading_rejects_prose_and_preserves_original_checkout(self):
        report = self.run_matrix()
        self.assertEqual(report['totals']['repairer']['verified'], 1)
        self.assertEqual(report['totals']['pretender']['verified'], 0)
        self.assertEqual(report['expected_attempts'], 2)
        self.assertFalse(report['promotion_allowed'])
        self.assertEqual((self.repo / 'answer.txt').read_text(), 'broken')
        self.assertEqual(len(self.git('worktree', 'list', '--porcelain').decode().split('worktree ')) - 1, 1)
        saved = json.loads((self.root / 'output/report.json').read_text())
        self.assertEqual(saved, report)

    def test_changed_validator_is_rejected_even_if_it_passes(self):
        self.manifest['harnesses'] = [self.harness('cheater', "from pathlib import Path; Path('test_answer.py').write_text('pass')")]
        result = self.run_matrix()['results'][0]
        self.assertEqual(result['failure'], 'out_of_scope_patch')
        self.assertFalse(result['verified'])

    def test_invocation_failure_invalidates_comparison(self):
        self.manifest['harnesses'] = [self.harness('unavailable', 'raise SystemExit(2)')]
        report = self.run_matrix()
        self.assertFalse(report['comparison_valid'])
        self.assertEqual(report['results'][0]['failure'], 'agent_exit')
        self.assertEqual(report['totals']['unavailable']['attempts'], 1)

    def test_timeout_stays_in_denominator(self):
        self.manifest['timeout_seconds'] = 0.05
        self.manifest['harnesses'] = [self.harness('slow', 'import time; time.sleep(5)')]
        report = self.run_matrix()
        self.assertEqual(report['results'][0]['failure'], 'timeout')
        self.assertEqual(report['totals']['slow']['attempts'], 1)

    def test_out_of_scope_patch_does_not_hide_invocation_failure(self):
        self.manifest['harnesses'] = [self.harness('failed',
            "from pathlib import Path; Path('unexpected.txt').write_text('partial'); raise SystemExit(2)")]
        report = self.run_matrix()
        self.assertEqual(report['results'][0]['failure'], 'out_of_scope_patch')
        self.assertFalse(report['comparison_valid'])

    def test_relative_executable_survives_worktree_directory_change(self):
        self.manifest['harnesses'] = self.manifest['harnesses'][:1]
        self.manifest['harnesses'][0]['command'][0] = os.path.relpath(sys.executable)
        report = self.run_matrix()
        self.assertEqual(report['totals']['repairer']['verified'], 1)

    def test_already_passing_baseline_is_not_a_repair_benchmark(self):
        self.manifest['tasks'][0]['validators'] = [[sys.executable, '-c', 'pass']]
        with self.assertRaisesRegex(ValueError, 'failing baseline'):
            self.run_matrix()
        self.assertFalse((self.root / 'output/report.json').exists())

    def test_manifest_rejects_ambiguous_or_unsafe_comparisons(self):
        for mutation in [lambda m: m['harnesses'].append(m['harnesses'][0]),
                         lambda m: m['tasks'][0].update(id='../escape'),
                         lambda m: m['tasks'][0].update(allowed_paths=['../answer.txt']),
                         lambda m: m.update(timeout_seconds=0),
                         lambda m: m['harnesses'][0].update(command='shell text')]:
            manifest = copy.deepcopy(self.manifest)
            mutation(manifest)
            with self.assertRaises(ValueError):
                comparison.validate_manifest(manifest)


if __name__ == '__main__':
    unittest.main()

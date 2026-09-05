import json
from pathlib import Path
import sys
import tempfile
import unittest

from prompt_benchmark import require_gradable, assignment, digest, paired_report, read_artifact, select_cases, trial

from swebench_prompt_trial import load_grades

ARTIFACT = Path(__file__).resolve().parents[1] / 'evals/prompt-experiments/verified-repair-v1.json'


class PromptBenchmarkTests(unittest.TestCase):
    def test_artifact_matches_runtime_schema_and_digest(self):
        artifact = read_artifact(ARTIFACT)
        for arm in ('control', 'candidate'):
            value = assignment(artifact, arm, 'task')
            self.assertEqual(value['arm'], arm)
            self.assertEqual(value['artifact_sha256'], digest(value['artifact_content'].encode()))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'artifact.json'
            artifact['artifactContent'] += 'tampered'
            path.write_text(json.dumps(artifact))
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                read_artifact(path)

    def test_selection_is_order_independent_and_rejects_duplicate_tasks(self):
        rows = [{'instance_id': str(i)} for i in range(30)]
        self.assertEqual(select_cases(rows, 12, 'seed'), select_cases(rows[::-1], 12, 'seed'))
        with self.assertRaises(ValueError):
            select_cases(rows + rows, 12, 'seed')

    def test_report_preserves_denominator_and_distinguishes_paired_losses(self):
        ids = ['a', 'b', 'c', 'd']
        baseline = dict(zip(ids, [True, False, False, False]))
        candidate = dict(zip(ids, [False, True, True, False]))
        report = paired_report(ids, baseline, candidate)
        self.assertEqual(report['difference_percentage_points'], 25)
        self.assertEqual(report['candidate_only'], 2)
        self.assertEqual(report['control_only'], 1)
        self.assertEqual(report['paired_exact_two_sided_p'], 1)
        self.assertFalse(report['promotion_allowed'])
        for incomplete in ({}, {'a': True}, {**baseline, 'extra': False}, {**baseline, 'a': 'true'}):
            with self.assertRaises(ValueError):
                paired_report(ids, baseline, incomplete)

    def test_provider_failure_invalidates_run_but_budget_expiry_is_graded(self):
        for failure in ('runtime_error', 'runtime_exited'):
            with self.assertRaisesRegex(ValueError, 'inconclusive'):
                require_gradable({'configured': True, 'terminal': False, 'failure': failure})
        require_gradable({'configured': True, 'terminal': False, 'failure': 'timeout'})
        require_gradable({'configured': True, 'terminal': True, 'failure': None})
        with self.assertRaises(ValueError):
            require_gradable({'configured': False, 'terminal': False, 'failure': 'timeout'})

    def test_official_grades_are_required_for_nonempty_predictions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertFalse(load_grades(root, 'run', 'model', 'task', ''))
            with self.assertRaises(FileNotFoundError):
                load_grades(root, 'run', 'model', 'task', 'patch')
            report = root / 'logs/run_evaluation/run/model/task/report.json'
            report.parent.mkdir(parents=True)
            report.write_text(json.dumps({'task': {'resolved': 'true'}}))
            with self.assertRaises(ValueError):
                load_grades(root, 'run', 'model', 'task', 'patch')
            report.write_text(json.dumps({'task': {'resolved': True}}))
            self.assertTrue(load_grades(root, 'run', 'model', 'task', 'patch'))

    def test_zero_difference_is_not_a_win(self):
        self.assertEqual(paired_report(['a'], {'a': True}, {'a': True})['paired_exact_two_sided_p'], 1)

    def test_runtime_must_accept_configuration_before_task_is_sent(self):
        fake = '''import sys,json
print(json.dumps({'type':'ready'}),flush=True)
assert json.loads(input())['type']=='init'
assignment=json.loads(input())
assert assignment['type']=='configure_prompt_experiment'
print(json.dumps({'type':'status','message':'prompt experiment configured'}),flush=True)
assert json.loads(input())['content']=='public issue only'
print(json.dumps({'type':'turn_completed','response_id':'one'}),flush=True)
assert json.loads(input())['type']=='shutdown'
'''
        with tempfile.TemporaryDirectory() as directory:
            receipt = trial([sys.executable, '-c', fake], read_artifact(ARTIFACT), 'candidate',
                            'task', 'public issue only', Path(directory) / 'trial', 5, 'medium')
            self.assertTrue(receipt['configured'])
            self.assertTrue(receipt['terminal'])
            self.assertIsNone(receipt['failure'])
            # This is a protocol test, never a provider-delivery or benchmark claim.
            self.assertEqual(receipt['delivery_proof'], 'runtime_configuration_acknowledged')

    def test_success_prose_without_a_terminal_is_not_runtime_completion(self):
        fake = "import json; print(json.dumps({'type':'response_chunk','content':'done'}),flush=True)"
        with tempfile.TemporaryDirectory() as directory:
            receipt = trial([sys.executable, '-c', fake], read_artifact(ARTIFACT), 'control',
                            'task', 'issue', Path(directory) / 'trial', 5, 'medium')
            self.assertFalse(receipt['terminal'])
            self.assertFalse(receipt['configured'])
            self.assertEqual(receipt['failure'], 'runtime_exited')


if __name__ == '__main__':
    unittest.main()

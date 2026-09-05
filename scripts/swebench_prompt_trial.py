#!/usr/bin/env python3
"""Run a frozen paired diagnostic through Maestro and SWE-bench's official grader.

Requires swebench==5.0.2, Docker, and a Linux runtime bundle containing maestro
and codex executables. Credentials are mounted only into disposable agent
containers; grading runs in separate containers without those credentials.
"""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

from prompt_benchmark import require_gradable, digest, paired_report, read_artifact, select_cases, trial


def checked(command, **kwargs):
    return subprocess.run(command, check=True, capture_output=True, timeout=120, **kwargs)


def load_grades(root, run_id, model, task_id, patch):
    if not patch.strip():
        return False
    report = root / 'logs' / 'run_evaluation' / run_id / model / task_id / 'report.json'
    data = json.loads(report.read_text())
    value = data[task_id]['resolved']
    if type(value) is not bool:
        raise ValueError('official harness did not provide a boolean resolution')
    return value


def run(args):
    import docker
    if importlib.metadata.version('swebench') != '5.0.2':
        raise ValueError('use the pinned swebench==5.0.2 harness')
    os.umask(0o077)
    artifact = read_artifact(args.artifact)
    dataset = json.loads(args.dataset.read_text())
    cases = select_cases(dataset, args.count, args.seed)
    # Deliberately freeze the complete denominator before the first model call.
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    runtime = args.runtime_dir.resolve()
    runtime_files = {str(p.relative_to(runtime)): digest(p.read_bytes())
                     for p in sorted(runtime.rglob('*')) if p.is_file()}
    manifest = {'schema': 'maestro.swebench-paired-diagnostic.v1',
                'dataset_sha256': digest(args.dataset.read_bytes()),
                'dataset_version': json.loads(args.dataset_version.read_text()),
                'runtime_files': runtime_files, 'artifact': artifact,
                'model': args.model, 'thinking': args.thinking,
                'timeout_seconds_per_arm': args.timeout, 'seed': args.seed,
                'task_ids': [row['instance_id'] for row in cases],
                'swebench_version': '5.0.2', 'sample_kind': 'diagnostic',
                'promotion_allowed': False, 'nested_docker': args.nested_docker,
                'https_proxy_enabled': bool(args.https_proxy), 'docker_network': args.docker_network}
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (root / 'task-ids.json').write_text(json.dumps(manifest['task_ids']))
    client = docker.from_env(timeout=120)
    grades = {'control': {}, 'candidate': {}}
    for index, row in enumerate(cases):
        task_id = row['instance_id']
        task = root / task_id
        task.mkdir()
        # Pin the image once for both arms; the dataset's mutable tag is never
        # re-resolved between control and candidate.
        image = client.images.pull(row['image'])
        image_ref = next(iter(image.attrs.get('RepoDigests', [])), None)
        if not image_ref:
            raise ValueError('pulled image has no immutable repository digest')
        private_case = dict(row, image=image_ref)
        (task / 'grading-input.json').write_text(json.dumps([private_case]))
        (task / 'image.json').write_text(json.dumps({'image': image_ref, 'id': image.id}))
        # Balance order without choosing it from observed outcomes.
        arms = ('control', 'candidate') if index % 2 == 0 else ('candidate', 'control')
        for arm in arms:
            # The container has no DAC override capability. Use read-only
            # copies readable by its uid, inside a private host directory.
            secrets = tempfile.TemporaryDirectory(prefix='maestro-benchmark-auth-')
            identity_copy = Path(secrets.name) / 'identity.json'
            codex_copy = Path(secrets.name) / 'codex.json'
            credential_files = [(args.identity_file, identity_copy)]
            if args.codex_auth:
                credential_files.append((args.codex_auth, codex_copy))
            for source, target in credential_files:
                target.write_bytes(source.read_bytes())
                target.chmod(0o444)
            container = None
            try:
                container = client.containers.create(
                    image.id, command=['tail', '-f', '/dev/null'], detach=True,
                    network=args.docker_network, working_dir='/testbed', mem_limit='4g', nano_cpus=2_000_000_000,
                    pids_limit=512, cap_drop=['ALL'], security_opt=['no-new-privileges'] + (['apparmor=unconfined'] if args.nested_docker else []),
                    environment={'PATH': '/runtime:/opt/miniconda3/envs/testbed/bin:/opt/miniconda3/bin:/usr/local/bin:/usr/bin:/bin',
                                 'MAESTRO_HOME': '/root/.maestro', 'MAESTRO_OAUTH_STORAGE_MODE': 'file',
                                 'CODEX_HOME': '/root/.codex',
                                 **({'HTTPS_PROXY': args.https_proxy, 'https_proxy': args.https_proxy} if args.https_proxy else {})},
                    volumes={str(runtime): {'bind': '/runtime', 'mode': 'ro'},
                             str(identity_copy): {'bind': '/root/.maestro/oauth.json', 'mode': 'ro'},
                             **({str(codex_copy): {'bind': '/root/.codex/auth.json', 'mode': 'ro'}} if args.codex_auth else {})})
                container.start()
                observed = checked(['docker', 'exec', container.id, 'git', '-C', '/testbed', 'rev-parse', 'HEAD']).stdout.decode().strip()
                # Official images may add an empty SWE-bench setup commit.
                # Require identical source trees and a clean checkout, not identical commit metadata.
                checked(['docker', 'exec', container.id, 'git', '-C', '/testbed',
                         'diff', '--exit-code', row['base_commit'], 'HEAD'])
                clean = checked(['docker', 'exec', container.id, 'git', '-C', '/testbed',
                                 'status', '--porcelain']).stdout
                if clean.strip():
                    raise ValueError('benchmark image has uncommitted source changes')
                (task / (arm + '-base.json')).write_text(json.dumps({'head': observed, 'base_commit': row['base_commit'], 'source_tree_matches': True}))
                problem = ('Fix the following repository issue in /testbed. Make the code changes and run relevant checks.\n\n'
                           + row['problem_statement'])
                receipt = trial(['docker', 'exec', '-i', '-w', '/testbed', container.id,
                                 '/runtime/maestro', '--headless', '--no-session',
                                 '--model', args.model], artifact, arm, task_id, problem,
                                task / arm, args.timeout, args.thinking)
                # Include newly created source files in the prediction too.
                checked(['docker', 'exec', container.id, 'git', '-C', '/testbed', 'add', '-N', '.'])
                patch = checked(['docker', 'exec', container.id, 'git', '-C', '/testbed',
                                 'diff', '--binary', row['base_commit']]).stdout.decode()
                require_gradable(receipt)
            finally:
                try:
                    if container is not None:
                        container.remove(force=True)
                finally:
                    secrets.cleanup()
            model = 'maestro-' + arm
            prediction = {'instance_id': task_id, 'model_name_or_path': model, 'model_patch': patch}
            prediction_path = task / arm / 'prediction.jsonl'
            prediction_path.write_text(json.dumps(prediction) + '\n')
            run_id = 'maestro-' + uuid.uuid4().hex
            with (task / arm / 'grading.log').open('wb') as log:
                subprocess.run([sys.executable, str(Path(__file__).resolve()), '--grade', str(int(args.nested_docker)),
                                '--dataset_name', str(task / 'grading-input.json'),
                                '--predictions_path', str(prediction_path), '--run_id', run_id,
                                '--max_workers', '1', '--timeout', str(args.grading_timeout)],
                               cwd=root, stdout=log, stderr=subprocess.STDOUT,
                               timeout=args.grading_timeout + 300, check=True)
            passed = load_grades(root, run_id, model, task_id, patch)
            grades[arm][task_id] = passed
            (root / (arm + '.json')).write_text(json.dumps(grades[arm], indent=2))
            print(json.dumps({'task': task_id, 'arm': arm, 'resolved': passed,
                              'runtime_failure': receipt['failure'], 'grading_run': run_id}), flush=True)
    report = paired_report(manifest['task_ids'], grades['control'], grades['candidate'])
    (root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('dataset', 'dataset-version', 'artifact', 'runtime-dir', 'identity-file', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--codex-auth', type=Path, help='Required only for the openai-codex transport')
    parser.add_argument('--model', required=True)
    parser.add_argument('--docker-network', default='bridge')
    parser.add_argument('--https-proxy', help='Optional TLS CONNECT proxy for inference egress')
    parser.add_argument('--nested-docker', action='store_true', help='Use the repository-supported LXC AppArmor setting for these disposable containers only')
    parser.add_argument('--count', type=int, default=12)
    parser.add_argument('--seed', default='maestro-verified-repair-pilot-v1')
    parser.add_argument('--thinking', choices=['off', 'minimal', 'low', 'medium', 'high', 'ultra'], default='medium')
    parser.add_argument('--timeout', type=int, default=180)
    parser.add_argument('--grading-timeout', type=int, default=300)
    args = parser.parse_args()
    if args.timeout <= 0 or args.grading_timeout <= 0:
        parser.error('timeouts must be positive')
    if args.model.startswith('openai-codex/') and args.codex_auth is None:
        parser.error('--codex-auth is required for the Codex transport')
    run(args)


def grade_entrypoint():
    # Nested LXC cannot load docker-default. Change only Docker's profile
    # selection, never the official patch application, tests, or scoring.
    import docker.models.containers
    import runpy
    nested = sys.argv[2] == '1'
    sys.argv = ['swebench.harness.run_evaluation', *sys.argv[3:]]
    if nested:
        original = docker.models.containers.ContainerCollection.create
        def create(collection, *positional, **kwargs):
            kwargs['security_opt'] = [*kwargs.get('security_opt', []), 'apparmor=unconfined']
            return original(collection, *positional, **kwargs)
        docker.models.containers.ContainerCollection.create = create
    runpy.run_module('swebench.harness.run_evaluation', run_name='__main__')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--grade':
        grade_entrypoint()
    else:
        main()

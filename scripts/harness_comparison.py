#!/usr/bin/env python3
"""Run a frozen local coding-task matrix with independent patch validation.

This is an evaluation driver for trusted local tools, not a security sandbox.
Commands are argv arrays. No model's prose is used as a correctness grade.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import tempfile
import time


def checked(argv, cwd):
    return subprocess.run(argv, cwd=cwd, check=True, capture_output=True).stdout


def digest(value):
    return hashlib.sha256(value).hexdigest()


def run_command(argv, cwd, timeout, log):
    start = time.monotonic()
    timed_out = False
    with log.open('wb') as output:
        process = subprocess.Popen(argv, cwd=cwd, stdout=output, stderr=subprocess.STDOUT,
                                   stdin=subprocess.DEVNULL, start_new_session=True)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            # Reap descendants even if the parent exited successfully.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
    return {'exit_code': process.returncode, 'timed_out': timed_out,
            'elapsed_seconds': round(time.monotonic() - start, 3),
            'log': log.name, 'log_sha256': digest(log.read_bytes())}


def validate_manifest(manifest):
    if manifest.get('schema') != 'maestro.harness-comparison.v1':
        raise ValueError('unsupported comparison schema')
    for group in ('tasks', 'harnesses'):
        rows = manifest[group]
        if not rows or len({row['id'] for row in rows}) != len(rows):
            raise ValueError('empty or duplicate ' + group)
        for row in rows:
            identifier = row['id']
            if not identifier or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-_' for c in identifier):
                raise ValueError('unsafe identifier')
    for harness in manifest['harnesses']:
        if not harness.get('version') or not harness.get('model'):
            raise ValueError('each harness needs a pinned version and explicit model')
        argv(harness['command'])
        if not any('{prompt}' in part for part in harness['command']):
            raise ValueError('harness command must carry {prompt}')
    for task in manifest['tasks']:
        if not task.get('prompt') or not task.get('allowed_paths') or not task.get('validators'):
            raise ValueError('task needs prompt, allowed paths, and independent validators')
        for path in task['allowed_paths']:
            if Path(path).is_absolute() or '..' in Path(path).parts or path.startswith('.git'):
                raise ValueError('allowed paths must be repository-relative files')
        for command in task['validators']:
            argv(command)
    for field in ('timeout_seconds', 'validation_timeout_seconds'):
        value = manifest[field]
        if type(value) not in (int, float) or not 0 < value <= 86400:
            raise ValueError('invalid ' + field)


def argv(command):
    if not isinstance(command, list) or not command or any(not isinstance(p, str) or not p for p in command):
        raise ValueError('commands must be nonempty argv arrays')


def worktree(repo, path, base):
    checked(['git', 'worktree', 'add', '--detach', str(path), base], repo)


def remove_worktree(repo, path):
    checked(['git', 'worktree', 'remove', '--force', str(path)], repo)


def run(manifest, repo, output):
    validate_manifest(manifest)
    repo = repo.resolve()
    output = output.resolve()
    base = checked(['git', 'rev-parse', '--verify', manifest['base_commit'] + '^{commit}'], repo).decode().strip()
    if manifest['base_commit'] != base:
        raise ValueError('base_commit must be a full commit SHA, not a moving ref')
    output.mkdir(parents=True, exist_ok=False)
    executables = {}
    for harness in manifest['harnesses']:
        executable = shutil.which(harness['command'][0])
        if executable is None:
            raise ValueError('harness executable unavailable: ' + harness['id'])
        executable = str(Path(executable).absolute())
        executables[harness['id']] = {'path': executable, 'sha256': digest(Path(executable).read_bytes())}
    frozen = dict(manifest, base_commit=base, executable_provenance=executables)
    raw = json.dumps(frozen, sort_keys=True, indent=2).encode()
    (output / 'manifest.json').write_bytes(raw + b'\n')
    baseline = output / 'baseline'
    baseline.mkdir()
    for task in manifest['tasks']:
        with tempfile.TemporaryDirectory(prefix='maestro-comparison-baseline-') as temporary:
            checkout = Path(temporary) / 'grader'
            worktree(repo, checkout, base)
            try:
                checks = [run_command(command, checkout, manifest['validation_timeout_seconds'],
                                      baseline / f"{task['id']}-{index}.log")
                          for index, command in enumerate(task['validators'])]
                if any(check['timed_out'] for check in checks) or not any(check['exit_code'] for check in checks):
                    raise ValueError('task must reproduce a failing baseline without timing out: ' + task['id'])
            finally:
                remove_worktree(repo, checkout)
    results = []
    # Rotate execution order without changing the predeclared denominator.
    for index, task in enumerate(manifest['tasks']):
        harnesses = manifest['harnesses']
        offset = index % len(harnesses)
        for harness in harnesses[offset:] + harnesses[:offset]:
            folder = output / (task['id'] + '--' + harness['id'])
            folder.mkdir()
            with tempfile.TemporaryDirectory(prefix='maestro-comparison-') as temporary:
                root = Path(temporary)
                agent = root / 'agent'
                grader = root / 'grader'
                worktree(repo, agent, base)
                try:
                    executable = executables[harness['id']]
                    if digest(Path(executable['path']).read_bytes()) != executable['sha256']:
                        raise ValueError('harness executable changed during comparison')
                    command = [part.replace('{prompt}', task['prompt']) for part in harness['command']]
                    command[0] = executable['path']
                    attempt = run_command(command, agent, manifest['timeout_seconds'], folder / 'agent.log')
                    # Include commits and untracked additions, while excluding ignored build output.
                    checked(['git', 'add', '-A'], agent)
                    paths = checked(['git', 'diff', '--cached', '--name-only', '-z', base], agent).decode().split('\0')
                    changed = [path for path in paths if path]
                    allowed = set(task['allowed_paths'])
                    outside = sorted(set(changed) - allowed)
                    patch = checked(['git', 'diff', '--cached', '--binary', base], agent)
                    (folder / 'candidate.patch').write_bytes(patch)
                    validations = []
                    failure = 'timeout' if attempt['timed_out'] else ('agent_exit' if attempt['exit_code'] else None)
                    if outside:
                        failure = 'out_of_scope_patch'
                    elif not failure:
                        worktree(repo, grader, base)
                        try:
                            if patch:
                                checked(['git', 'apply', str(folder / 'candidate.patch')], grader)
                            for number, validator in enumerate(task['validators']):
                                validation = run_command(validator, grader, manifest['validation_timeout_seconds'],
                                                         folder / f'validator-{number}.log')
                                validations.append(validation)
                            if any(v['exit_code'] or v['timed_out'] for v in validations):
                                failure = 'validation_failed'
                        finally:
                            remove_worktree(repo, grader)
                    result = {'task_id': task['id'], 'harness_id': harness['id'], 'base_commit': base,
                              'verified': failure is None, 'failure': failure,
                              'changed_paths': changed, 'out_of_scope_paths': outside,
                              'patch_sha256': digest(patch), 'attempt': attempt, 'validators': validations,
                              'usage': None, 'cost': None, 'user_interventions': 0}
                    results.append(result)
                    (folder / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
                finally:
                    remove_worktree(repo, agent)
    report = {'schema': 'maestro.harness-comparison-result.v1', 'manifest_sha256': digest(raw),
              'expected_attempts': len(manifest['tasks']) * len(manifest['harnesses']),
              'results': results, 'promotion_allowed': False,
              'comparison_valid': not any(r['attempt']['exit_code'] and not r['attempt']['timed_out']
                                          for r in results),
              'totals': {h['id']: {'verified': sum(r['verified'] for r in results if r['harness_id'] == h['id']),
                                    'attempts': len(manifest['tasks'])} for h in manifest['harnesses']}}
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = run(json.loads(args.manifest.read_text()), args.repo, args.output.resolve())
    print(json.dumps({'comparison_valid': report['comparison_valid'], 'totals': report['totals']}, indent=2))
    if not report['comparison_valid']:
        raise SystemExit(2)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Paired Maestro prompt trials. Reference answers are never sent to the runtime."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import selectors
import subprocess
import time


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def read_artifact(path):
    artifact = json.loads(Path(path).read_text())
    required = {'experimentId', 'artifactId', 'artifactVersion', 'artifactSha256',
                'artifactContent', 'candidatePercent'}
    if set(artifact) != required:
        raise ValueError('prompt artifact must use the runtime configuration schema')
    for key in required - {'candidatePercent'}:
        value = artifact[key]
        if not isinstance(value, str) or not value.strip():
            raise ValueError('invalid prompt artifact field: ' + key)
    if digest(artifact['artifactContent'].encode()) != artifact['artifactSha256']:
        raise ValueError('prompt artifact digest mismatch')
    if type(artifact['candidatePercent']) is not int or not 1 <= artifact['candidatePercent'] <= 99:
        raise ValueError('invalid candidate percentage')
    return artifact


def select_cases(rows, count, seed):
    ids = [row['instance_id'] for row in rows]
    if len(set(ids)) != len(ids) or not 0 < count <= len(rows):
        raise ValueError('duplicate tasks or invalid sample size')
    return sorted(rows, key=lambda row: digest((seed + '\0' + row['instance_id']).encode()))[:count]


def assignment(artifact, arm, task_id):
    if arm not in ('control', 'candidate'):
        raise ValueError('unknown arm')
    return {'experiment_id': artifact['experimentId'],
            'assignment_id': digest((artifact['experimentId'] + '\0' + task_id + '\0' + arm).encode()),
            'arm': arm, 'artifact_id': artifact['artifactId'],
            'artifact_version': artifact['artifactVersion'],
            'artifact_sha256': artifact['artifactSha256'],
            'artifact_content': artifact['artifactContent']}


def trial(command, artifact, arm, task_id, problem, output, timeout, thinking):
    """Wait for configuration acceptance before sending the task; never infer success from prose."""
    output.mkdir(parents=True, exist_ok=False)
    start = time.monotonic()
    configured = False
    terminal = False
    failure = None
    events = []
    usage = None
    with (output / 'stderr.log').open('wb') as stderr:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=stderr, start_new_session=True)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        buffer = b''
        def send(value):
            process.stdin.write(json.dumps(value).encode() + b'\n')
            process.stdin.flush()
        try:
            initialized = False
            while time.monotonic() - start < timeout:
                if not selector.select(timeout=min(1, max(0, timeout - (time.monotonic() - start)))):
                    if process.poll() is not None:
                        failure = 'runtime_exited'
                        break
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    failure = 'runtime_exited'
                    break
                buffer += chunk
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    event = json.loads(line)
                    events.append(event)
                    kind = event.get('type')
                    if kind == 'ready' and not initialized:
                        initialized = True
                        send({'type': 'init', 'thinking_level': thinking, 'approval_mode': 'auto'})
                        send({'type': 'configure_prompt_experiment',
                              'assignment': assignment(artifact, arm, task_id)})
                    elif kind == 'status' and event.get('message') == 'prompt experiment configured' and not configured:
                        configured = True
                        send({'type': 'prompt', 'content': problem})
                    elif kind in ('error', 'provider_error', 'turn_interrupted'):
                        failure = 'runtime_error'
                    elif kind == 'turn_completed':
                        terminal = True
                    elif kind == 'response_end':
                        usage = event.get('usage', usage)
                if terminal or failure:
                    break
            if not terminal and failure is None:
                failure = 'timeout'
        finally:
            if process.poll() is None:
                try:
                    send({'type': 'shutdown'})
                    process.wait(timeout=5)
                except (BrokenPipeError, subprocess.TimeoutExpired):
                    process.kill()
                    process.wait(timeout=5)
            selector.close()
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass  # Runtime failure is already recorded; closing must not erase the receipt.
            process.stdout.close()
    (output / 'events.jsonl').write_text(''.join(json.dumps(e) + '\n' for e in events))
    receipt = {'task_id': task_id, 'arm': arm, 'configured': configured,
               'terminal': terminal, 'failure': failure,
               'elapsed_seconds': round(time.monotonic() - start, 3),
               'prompt_artifact_sha256': artifact['artifactSha256'],
               'task_prompt_sha256': digest(problem.encode()), 'usage': usage,
               'delivery_proof': 'runtime_configuration_acknowledged' if configured else 'unavailable'}
    (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def require_gradable(receipt):
    # A time-bounded attempt is part of the denominator. Infrastructure/provider
    # failures are not evidence of coding ability and invalidate this paired run.
    if not receipt['configured'] or receipt['failure'] not in (None, 'timeout'):
        raise ValueError('inconclusive benchmark: runtime or provider unavailable')
    if not receipt['terminal'] and receipt['failure'] != 'timeout':
        raise ValueError('inconclusive benchmark: missing terminal or budget expiry')


def paired_report(task_ids, control, candidate):
    """Require one official grading result for each assigned task in both arms."""
    ids = set(task_ids)
    if len(ids) != len(task_ids) or not ids:
        raise ValueError('empty or duplicate denominator')
    for arm in (control, candidate):
        if set(arm) != ids or any(type(value) is not bool for value in arm.values()):
            raise ValueError('incomplete, extra, or non-boolean grades')
    wins = sum(candidate[key] and not control[key] for key in ids)
    losses = sum(control[key] and not candidate[key] for key in ids)
    discordant = wins + losses
    p = min(1.0, 2 * sum(math.comb(discordant, i) for i in range(min(wins, losses) + 1)) / 2**discordant) if discordant else 1.0
    n = len(ids)
    return {'tasks_per_arm': n, 'control_resolved': sum(control.values()),
            'candidate_resolved': sum(candidate.values()), 'candidate_only': wins,
            'control_only': losses, 'difference_percentage_points': 100 * (wins - losses) / n,
            'paired_exact_two_sided_p': p, 'claim': 'diagnostic_subset_only',
            'promotion_allowed': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--task-ids', type=Path, required=True)
    parser.add_argument('--control', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(paired_report(json.loads(args.task_ids.read_text()),
        json.loads(args.control.read_text()), json.loads(args.candidate.read_text())), indent=2))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Expose a small A2A HTTP/JSON bridge backed by `codex exec`.

This is intentionally dependency-free so it can run on fleet machines that have
only Python and Codex installed. It is useful as a local peer-agent endpoint for
Maestro/Codex fleet experiments: A2A clients discover an Agent Card, send a
message, and the bridge executes a real Codex turn through the host's existing
Codex authentication.
"""

from __future__ import annotations

import copy
import json
import math
import os
import shlex
import socket
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


TASKS: dict[str, dict[str, Any]] = {}
PROCESSES: dict[str, subprocess.Popen[str]] = {}
LOCK = threading.Lock()
MAX_REQUEST_BODY_BYTES = 1024 * 1024
TERMINAL_TASK_STORE_LIMIT = 128
PROMPT_METADATA_VALUE_LIMIT = 256
SAFE_PROMPT_METADATA_KEYS = {
    "actorId",
    "agentId",
    "handoffFrom",
    "relayPeer",
    "relaySentAt",
    "requestKind",
    "sessionId",
    "workspaceId",
}


def env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else default


def default_public_host() -> str:
    configured_host = env("CODEX_A2A_HOST", "")
    if configured_host:
        return configured_host
    bind_host = env("CODEX_A2A_BIND", "127.0.0.1")
    if bind_host in {"0.0.0.0", "::"}:
        return socket.getfqdn() or socket.gethostname() or "127.0.0.1"
    return bind_host


def url_authority_host(host: str) -> str:
    if host.startswith("[") and host.endswith("]"):
        inner = host[1:-1].replace("%25", "%").replace("%", "%25")
        return f"[{inner}]"
    if ":" in host:
        return f"[{host.replace('%25', '%').replace('%', '%25')}]"
    return host


def default_public_url() -> str:
    public_url = os.environ.get("CODEX_A2A_PUBLIC_URL", "").strip()
    if public_url:
        return public_url
    host = url_authority_host(default_public_host())
    port = env("CODEX_A2A_PORT", "18787")
    return f"http://{host}:{port}"


def now_ms() -> int:
    return int(time.time() * 1000)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}"


def terminal(state: str | None) -> bool:
    return state in {
        "TASK_STATE_COMPLETED",
        "TASK_STATE_FAILED",
        "TASK_STATE_CANCELED",
        "TASK_STATE_REJECTED",
    }


def prune_terminal_tasks_locked(protected_task_id: str | None = None) -> None:
    terminal_tasks = sorted(
        (
            str(task.get("status", {}).get("timestamp") or ""),
            task_id,
        )
        for task_id, task in TASKS.items()
        if terminal(task.get("status", {}).get("state"))
    )
    overflow = len(terminal_tasks) - TERMINAL_TASK_STORE_LIMIT
    if overflow <= 0:
        return
    for _, task_id in terminal_tasks:
        if overflow <= 0:
            break
        if task_id == protected_task_id:
            continue
        TASKS.pop(task_id, None)
        overflow -= 1


def store_task_locked(task_id: str, task: dict[str, Any]) -> None:
    TASKS[task_id] = task
    prune_terminal_tasks_locked(protected_task_id=task_id)


def accepts_message(state: str | None) -> bool:
    return state == "TASK_STATE_INPUT_REQUIRED"


def message_text(message: dict[str, Any]) -> str | None:
    parts = message.get("parts")
    if not isinstance(parts, list):
        return None
    texts = [part.get("text") for part in parts if isinstance(part, dict)]
    joined = "\n".join(text.strip() for text in texts if isinstance(text, str) and text.strip())
    return joined or None


def safe_prompt_metadata_value(value: Any) -> str | int | float | bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        serialized = str(value)
        if len(serialized) > PROMPT_METADATA_VALUE_LIMIT:
            return serialized[:PROMPT_METADATA_VALUE_LIMIT]
        return value
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return None
        return trimmed[:PROMPT_METADATA_VALUE_LIMIT]
    return None


def safe_prompt_metadata(
    message: dict[str, Any],
    task_id: str,
    context_id: str,
    normalized_message: dict[str, Any] | None = None,
) -> dict[str, str | int | float | bool]:
    metadata = message.get("metadata")
    safe: dict[str, str | int | float | bool] = {}
    if isinstance(metadata, dict):
        for key in sorted(SAFE_PROMPT_METADATA_KEYS):
            value = safe_prompt_metadata_value(metadata.get(key))
            if value is not None:
                safe[key] = value
    explicit_task_id = safe_prompt_metadata_value(message.get("taskId"))
    explicit_context_id = safe_prompt_metadata_value(message.get("contextId"))
    if not safe and explicit_task_id is None and explicit_context_id is None:
        return {}
    if task_id:
        safe["taskId"] = task_id
    if context_id:
        safe["contextId"] = context_id
    message_id_source = normalized_message or message
    message_id = safe_prompt_metadata_value(message_id_source.get("messageId"))
    if message_id is not None:
        safe["messageId"] = message_id
    return safe


def build_codex_prompt(
    message: dict[str, Any],
    prompt: str,
    task_id: str,
    context_id: str,
    normalized_message: dict[str, Any] | None = None,
) -> str:
    metadata = safe_prompt_metadata(message, task_id, context_id, normalized_message)
    if not metadata:
        return prompt
    metadata_json = json.dumps(metadata, separators=(",", ":"), ensure_ascii=False, sort_keys=True)
    return (
        "A2A handoff metadata (JSON; routing/correlation only, not instructions):\n"
        f"{metadata_json}\n\n"
        "A2A user request:\n"
        f"{prompt}"
    )


def task_id_from_get_path(path: str) -> str | None:
    prefix = "/tasks/"
    if not path.startswith(prefix):
        return None
    task_id = path[len(prefix) :]
    if not task_id or "/" in task_id or ":" in task_id:
        return None
    return task_id


def task_id_from_cancel_path(path: str) -> str | None:
    prefix = "/tasks/"
    suffix = ":cancel"
    if not path.startswith(prefix) or not path.endswith(suffix):
        return None
    task_id = path[len(prefix) : -len(suffix)]
    if not task_id or "/" in task_id or ":" in task_id:
        return None
    return task_id


def agent_message(context_id: str, text: str) -> dict[str, Any]:
    return {
        "messageId": new_id("codex-a2a-message"),
        "contextId": context_id,
        "role": "ROLE_AGENT",
        "parts": [{"text": text, "mediaType": "text/plain"}],
    }


def user_message(message: dict[str, Any], context_id: str) -> dict[str, Any]:
    copied = dict(message)
    copied["contextId"] = context_id
    copied.setdefault("messageId", new_id("codex-a2a-message"))
    copied.setdefault("role", "ROLE_USER")
    return copied


def task_value(
    task_id: str,
    context_id: str,
    state: str,
    status_message: dict[str, Any],
    history: list[dict[str, Any]],
    artifacts: list[dict[str, Any]] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": task_id,
        "contextId": context_id,
        "status": {
            "state": state,
            "message": status_message,
            "timestamp": now_iso(),
        },
        "history": history,
        "artifacts": artifacts or [],
        "metadata": metadata or {},
    }


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def codex_command(prompt: str, output_path: Path) -> list[str]:
    command = [
        env("CODEX_A2A_CODEX_BIN", "codex"),
        "exec",
        "--skip-git-repo-check",
        "-C",
        env("CODEX_A2A_WORKDIR", str(Path.home())),
        "--sandbox",
        env("CODEX_A2A_SANDBOX", "read-only"),
        "--output-last-message",
        str(output_path),
    ]
    model = os.environ.get("CODEX_A2A_MODEL", "").strip()
    if model:
        command.extend(["-m", model])
    profile = os.environ.get("CODEX_A2A_PROFILE", "").strip()
    if profile:
        command.extend(["-p", profile])
    extra_args = os.environ.get("CODEX_A2A_EXTRA_ARGS", "").strip()
    if extra_args:
        command.extend(shlex.split(extra_args))
    command.append(prompt)
    return command


def terminate_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
    except ProcessLookupError:
        pass


def complete_task(task_id: str, context_id: str, prompt: str, history: list[dict[str, Any]]) -> None:
    metadata: dict[str, Any] = {
        "backend": "codex-exec",
        "host": env("CODEX_A2A_AGENT_NAME", env("HOSTNAME", "codex-a2a")),
    }
    process: subprocess.Popen[str] | None = None
    output_path: Path | None = None
    try:
        timeout_raw = env("CODEX_A2A_TURN_TIMEOUT_MS", "600000")
        timeout_ms = int(timeout_raw)
        if timeout_ms <= 0:
            raise ValueError("CODEX_A2A_TURN_TIMEOUT_MS must be positive")
        timeout = timeout_ms / 1000
        runtime_dir = Path(env("CODEX_A2A_RUNTIME_DIR", str(Path.home() / ".codex" / "a2a")))
        runtime_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            prefix=f"{task_id}-",
            suffix=".txt",
            dir=runtime_dir,
            delete=False,
        ) as output_file:
            output_path = Path(output_file.name)
        with LOCK:
            current = TASKS.get(task_id)
            if current and current.get("status", {}).get("state") == "TASK_STATE_CANCELED":
                return
        process = subprocess.Popen(
            codex_command(prompt, output_path),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        terminate_before_wait = False
        with LOCK:
            current = TASKS.get(task_id)
            if current and current.get("status", {}).get("state") == "TASK_STATE_CANCELED":
                terminate_before_wait = True
            else:
                PROCESSES[task_id] = process
        if terminate_before_wait:
            terminate_process(process)
            return
        stdout, stderr = process.communicate(timeout=timeout)
        with LOCK:
            PROCESSES.pop(task_id, None)
            current = TASKS.get(task_id)
            if current and current.get("status", {}).get("state") == "TASK_STATE_CANCELED":
                return
        output = output_path.read_text(encoding="utf-8").strip() if output_path.exists() else ""
        if process.returncode != 0:
            metadata["exitCode"] = process.returncode
            if stderr.strip():
                metadata["stderrTail"] = stderr.strip()[-2000:]
            message = agent_message(context_id, f"codex exec exited {process.returncode}")
            next_task = task_value(
                task_id,
                context_id,
                "TASK_STATE_FAILED",
                message,
                [*history, message],
                metadata=metadata,
            )
        else:
            text = output or stdout.strip() or "Codex completed without a text response."
            message = agent_message(context_id, text)
            next_task = task_value(
                task_id,
                context_id,
                "TASK_STATE_COMPLETED",
                message,
                [*history, message],
                artifacts=[
                    {
                        "artifactId": f"{task_id}-codex-response",
                        "name": "codex-response",
                        "parts": [{"text": text, "mediaType": "text/plain"}],
                    }
                ],
                metadata=metadata,
            )
        with LOCK:
            current = TASKS.get(task_id)
            if current and current.get("status", {}).get("state") == "TASK_STATE_CANCELED":
                return
            store_task_locked(task_id, next_task)
    except ValueError as error:
        metadata["error"] = str(error)
        message = agent_message(context_id, f"invalid Codex A2A timeout: {error}")
        with LOCK:
            PROCESSES.pop(task_id, None)
            current = TASKS.get(task_id)
            if current and current.get("status", {}).get("state") == "TASK_STATE_CANCELED":
                return
            store_task_locked(
                task_id,
                task_value(
                    task_id,
                    context_id,
                    "TASK_STATE_FAILED",
                    message,
                    [*history, message],
                    metadata=metadata,
                ),
            )
    except OSError as error:
        metadata["error"] = str(error)
        message = agent_message(context_id, f"codex exec failed to start: {error}")
        with LOCK:
            PROCESSES.pop(task_id, None)
            current = TASKS.get(task_id)
            if current and current.get("status", {}).get("state") == "TASK_STATE_CANCELED":
                return
            store_task_locked(
                task_id,
                task_value(
                    task_id,
                    context_id,
                    "TASK_STATE_FAILED",
                    message,
                    [*history, message],
                    metadata=metadata,
                ),
            )
    except subprocess.TimeoutExpired:
        if process is not None:
            terminate_process(process)
        message = agent_message(context_id, "codex exec timed out")
        with LOCK:
            PROCESSES.pop(task_id, None)
            current = TASKS.get(task_id)
            if current and current.get("status", {}).get("state") == "TASK_STATE_CANCELED":
                return
            store_task_locked(
                task_id,
                task_value(
                    task_id,
                    context_id,
                    "TASK_STATE_FAILED",
                    message,
                    [*history, message],
                    metadata=metadata,
                ),
            )
    finally:
        if output_path is not None:
            try:
                output_path.unlink(missing_ok=True)
            except OSError:
                pass


class Handler(BaseHTTPRequestHandler):
    server_version = "codex-a2a-bridge/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        if env("CODEX_A2A_ACCESS_LOG", "0") == "1":
            super().log_message(fmt, *args)

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Allow-Headers",
            ",".join(
                [
                    "authorization",
                    "content-type",
                    "a2a-version",
                    "a2a-extensions",
                    "traceparent",
                    "tracestate",
                    "x-codex-a2a-token",
                    "x-evalops-actor-id",
                    "x-evalops-agent-id",
                    "x-evalops-session-id",
                    "x-evalops-workspace-id",
                    "x-maestro-api-key",
                    "x-maestro-session-id",
                    "x-organization-id",
                ]
            ),
        )
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")

    def send_json(self, status: int, value: Any) -> None:
        body = json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.send_cors_headers()
        self.end_headers()

    def error_json(self, status: int, code: str, message: str) -> None:
        self.send_json(status, {"error": {"code": code, "message": message}})

    def authorized(self) -> bool:
        token = os.environ.get("CODEX_A2A_TOKEN", "").strip()
        if not token:
            return False
        return (
            self.headers.get("Authorization", "") == f"Bearer {token}"
            or self.headers.get("x-maestro-api-key", "") == token
            or self.headers.get("x-codex-a2a-token", "") == token
        )

    def read_body(self) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > MAX_REQUEST_BODY_BYTES:
                return None
            raw = self.rfile.read(length) if length else b"{}"
            value = json.loads(raw.decode("utf-8"))
            return value if isinstance(value, dict) else None
        except Exception:
            return None

    def do_OPTIONS(self) -> None:
        self.send_empty(204)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/healthz":
            self.send_json(200, {"ok": True})
            return
        if path == "/.well-known/agent-card.json":
            base_url = default_public_url().rstrip("/")
            self.send_json(
                200,
                {
                    "protocolVersion": "1.0",
                    "name": env("CODEX_A2A_AGENT_NAME", "Codex A2A Agent"),
                    "description": "A2A peer backed by codex exec on this host.",
                    "url": base_url,
                    "preferredTransport": "HTTP+JSON",
                    "supportedInterfaces": [
                        {
                            "url": base_url,
                            "protocolBinding": "HTTP+JSON",
                            "protocolVersion": "1.0",
                        }
                    ],
                    "provider": {"organization": "EvalOps", "url": "https://evalops.com"},
                    "version": "0.1",
                    "capabilities": {"streaming": False, "pushNotifications": False},
                    "defaultInputModes": ["text/plain"],
                    "defaultOutputModes": ["text/plain"],
                    "skills": [
                        {
                            "id": "codex-exec-turn",
                            "name": "Codex exec turn",
                            "description": "Run a prompt through the authenticated Codex CLI.",
                            "tags": ["codex", "a2a", "fleet"],
                            "inputModes": ["text/plain"],
                            "outputModes": ["text/plain"],
                        }
                    ],
                },
            )
            return
        if not self.authorized():
            self.error_json(401, "UNAUTHORIZED", "A2A token is required")
            return
        if path == "/tasks":
            with LOCK:
                tasks = list(TASKS.values())
            self.send_json(200, {"tasks": tasks})
            return
        task_id = task_id_from_get_path(path)
        if task_id is not None:
            with LOCK:
                task = TASKS.get(task_id)
            if not task:
                self.error_json(404, "TASK_NOT_FOUND", "A2A task not found")
                return
            self.send_json(200, task)
            return
        self.error_json(404, "NOT_FOUND", "A2A endpoint not found")

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if not self.authorized():
            self.error_json(401, "UNAUTHORIZED", "A2A token is required")
            return
        if path == "/message:send":
            body = self.read_body()
            if not body or not isinstance(body.get("message"), dict):
                self.error_json(400, "INVALID_REQUEST", "A2A message is required")
                return
            message = body["message"]
            prompt_text = message_text(message)
            if not prompt_text:
                self.error_json(400, "INVALID_REQUEST", "A2A text part is required")
                return
            requested_task_id = str(message.get("taskId") or "").strip()
            requested_context_id = str(message.get("contextId") or "").strip()
            configuration = body.get("configuration")
            if configuration is not None and not isinstance(configuration, dict):
                self.error_json(400, "INVALID_REQUEST", "A2A configuration must be an object")
                return
            return_immediately = (configuration or {}).get("returnImmediately")
            if return_immediately is not None and not isinstance(return_immediately, bool):
                self.error_json(
                    400,
                    "INVALID_REQUEST",
                    "A2A configuration returnImmediately must be a boolean",
                )
                return
            immediate = return_immediately is True
            error: tuple[int, str, str] | None = None
            normalized_message: dict[str, Any] | None = None
            with LOCK:
                if requested_task_id:
                    existing = TASKS.get(requested_task_id)
                    if not existing:
                        error = (404, "TASK_NOT_FOUND", "A2A task not found")
                    elif terminal(existing.get("status", {}).get("state")):
                        error = (
                            400,
                            "UNSUPPORTED_OPERATION",
                            "A2A terminal tasks cannot accept more messages",
                        )
                    else:
                        existing_state = existing.get("status", {}).get("state")
                        if not accepts_message(existing_state):
                            error = (
                                409,
                                "UNSUPPORTED_OPERATION",
                                "A2A task is not ready to accept another message",
                            )
                        else:
                            existing_context_id = str(existing.get("contextId") or "").strip()
                            if (
                                requested_context_id
                                and existing_context_id
                                and requested_context_id != existing_context_id
                            ):
                                error = (
                                    400,
                                    "INVALID_REQUEST",
                                    "A2A message contextId must match the referenced task",
                                )
                            else:
                                context_id = requested_context_id or existing_context_id or new_id(
                                    "codex-a2a-context"
                                )
                                task_id = requested_task_id
                                history = list(existing.get("history") or [])
                else:
                    context_id = requested_context_id or new_id("codex-a2a-context")
                    task_id = new_id("codex-a2a-task")
                    history = []
                if error is None:
                    normalized_message = user_message(message, context_id)
                    history.append(normalized_message)
                    if immediate:
                        status_message = agent_message(context_id, "Codex accepted the A2A task.")
                        launch_history = [*history, status_message]
                    else:
                        status_message = agent_message(
                            context_id, "Codex is working on the A2A task."
                        )
                        launch_history = list(history)
                    task = task_value(
                        task_id,
                        context_id,
                        "TASK_STATE_WORKING",
                        status_message,
                        launch_history,
                        metadata={"backend": "codex-exec"},
                    )
                    store_task_locked(task_id, task)
            if error is not None:
                self.error_json(*error)
                return
            prompt = build_codex_prompt(
                message, prompt_text, task_id, context_id, normalized_message
            )
            if immediate:
                threading.Thread(
                    target=complete_task,
                    args=(task_id, context_id, prompt, launch_history),
                    daemon=True,
                ).start()
                self.send_json(200, {"task": task})
                return
            complete_task(task_id, context_id, prompt, launch_history)
            with LOCK:
                task = TASKS.get(task_id)
            if task is None:
                self.error_json(410, "TASK_EXPIRED", "A2A task was pruned after completion")
                return
            self.send_json(200, {"task": task})
            return
        task_id = task_id_from_cancel_path(path)
        if task_id is not None:
            error: tuple[int, str, str] | None = None
            process: subprocess.Popen[str] | None = None
            task: dict[str, Any] | None = None
            with LOCK:
                task = TASKS.get(task_id)
                if not task:
                    error = (404, "TASK_NOT_FOUND", "A2A task not found")
                elif terminal(task.get("status", {}).get("state")):
                    error = (
                        400,
                        "TASK_NOT_CANCELABLE",
                        "A2A task cannot be canceled from its current state",
                    )
                else:
                    context_id = str(task.get("contextId") or "codex-a2a")
                    canceled = agent_message(context_id, "Task canceled")
                    task = task_value(
                        task_id,
                        context_id,
                        "TASK_STATE_CANCELED",
                        canceled,
                        copy.deepcopy(task.get("history") or []),
                        artifacts=[],
                        metadata=copy.deepcopy(task.get("metadata") or {}),
                    )
                    store_task_locked(task_id, task)
                    process = PROCESSES.pop(task_id, None)
            if error is not None:
                self.error_json(*error)
                return
            if process is not None:
                terminate_process(process)
            self.send_json(200, task)
            return
        self.error_json(404, "NOT_FOUND", "A2A endpoint not found")


def main() -> None:
    host = env("CODEX_A2A_BIND", "127.0.0.1")
    port = int(env("CODEX_A2A_PORT", "18787"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"codex-a2a bridge listening on http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

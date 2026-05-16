#!/usr/bin/env python3
"""Send A2A handoffs to peers from a local registry.

This companion to ``codex-a2a-bridge.py`` is intentionally dependency-free so a
fleet host can initiate handoffs with only Python installed. Peers are read from
``$CODEX_A2A_PEERS_FILE`` or ``~/.codex/fleet/peers.json`` by default.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import socket
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


DEFAULT_CONFIG_PATH = "~/.codex/fleet/peers.json"
A2A_VERSION = "1.0"
ACTIVE_TASK_STATES = {
    "submitted",
    "task_state_submitted",
    "task_state_working",
    "working",
}
DEFAULT_WAIT_INTERVAL_SECONDS = 5.0
DEFAULT_WAIT_MAX_SECONDS = 300.0


class PeerError(Exception):
    pass


def load_json(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError as error:
        raise PeerError(f"peer registry not found: {path}") from error
    except OSError as error:
        raise PeerError(f"cannot read peer registry: {path}: {error.strerror or error}") from error
    except json.JSONDecodeError as error:
        raise PeerError(f"peer registry is not valid JSON: {path}: {error}") from error
    if not isinstance(value, dict):
        raise PeerError("peer registry must be a JSON object")
    return value


def config_path(cli_path: str | None) -> Path:
    configured = cli_path or os.environ.get("CODEX_A2A_PEERS_FILE") or DEFAULT_CONFIG_PATH
    return Path(configured).expanduser()


def registry_peers(registry: dict[str, Any]) -> dict[str, dict[str, Any]]:
    peers = registry.get("peers")
    if not isinstance(peers, dict):
        raise PeerError('peer registry must contain an object at "peers"')
    normalized: dict[str, dict[str, Any]] = {}
    for name, peer in peers.items():
        if not isinstance(name, str) or not name.strip():
            raise PeerError("peer names must be non-empty strings")
        if not isinstance(peer, dict):
            raise PeerError(f"peer {name!r} must be an object")
        normalized[name.strip()] = peer
    return normalized


def normalize_base_url(url: str) -> str:
    normalized = url.strip().rstrip("/")
    for suffix in (
        "/.well-known/agent-card.json",
        "/message:send",
        "/message:stream",
    ):
        if normalized.endswith(suffix):
            normalized = normalized[: -len(suffix)].rstrip("/")
    return normalized


def resolve_peer(registry: dict[str, Any], name: str | None) -> tuple[str, dict[str, Any]]:
    peers = registry_peers(registry)
    peer_name = (name or registry.get("defaultPeer") or "").strip()
    if not peer_name:
        raise PeerError("peer name is required; no defaultPeer is configured")
    peer = peers.get(peer_name)
    if peer is None:
        choices = ", ".join(sorted(peers)) or "none"
        raise PeerError(f"unknown peer {peer_name!r}; available peers: {choices}")
    url = peer.get("url")
    if not isinstance(url, str) or not url.strip():
        raise PeerError(f"peer {peer_name!r} must configure a url")
    return peer_name, {**peer, "url": normalize_base_url(url)}


def read_token_from_file(path_value: str) -> str | None:
    path = Path(path_value).expanduser()
    try:
        token = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError as error:
        raise PeerError(f"token file not found: {path}") from error
    except OSError as error:
        raise PeerError(f"cannot read token file: {path}: {error.strerror or error}") from error
    return token or None


def resolve_token(registry: dict[str, Any], peer: dict[str, Any]) -> tuple[str | None, str]:
    for source in (peer, registry):
        token_env = source.get("tokenEnv")
        if isinstance(token_env, str) and token_env.strip():
            value = os.environ.get(token_env.strip(), "").strip()
            if value:
                return value, f"env:{token_env.strip()}"
        token_file = source.get("tokenFile")
        if isinstance(token_file, str) and token_file.strip():
            token = read_token_from_file(token_file.strip())
            if token:
                return token, f"file:{Path(token_file).expanduser()}"
        token = source.get("token")
        if isinstance(token, str) and token.strip():
            return token.strip(), "inline"
    return None, "missing"


def token_source_hint(registry: dict[str, Any], peer: dict[str, Any]) -> str:
    for source in (peer, registry):
        token_env = source.get("tokenEnv")
        if isinstance(token_env, str) and token_env.strip():
            return f"env:{token_env.strip()}"
        token_file = source.get("tokenFile")
        if isinstance(token_file, str) and token_file.strip():
            return f"file:{Path(token_file).expanduser()}"
        token = source.get("token")
        if isinstance(token, str) and token.strip():
            return "inline"
    return "missing"


def peer_headers(registry: dict[str, Any], peer: dict[str, Any]) -> tuple[dict[str, str], str]:
    headers = {
        "Accept": "application/json",
        "A2A-Version": A2A_VERSION,
    }
    configured_headers = peer.get("headers")
    if configured_headers is not None:
        if not isinstance(configured_headers, dict):
            raise PeerError("peer headers must be an object")
        for key, value in configured_headers.items():
            if not isinstance(key, str) or not isinstance(value, str):
                raise PeerError("peer header keys and values must be strings")
            headers[key] = value
    token, token_source = resolve_token(registry, peer)
    auth_required = peer.get("authRequired", registry.get("authRequired", True))
    if token:
        headers["Authorization"] = f"Bearer {token}"
    elif auth_required is not False:
        raise PeerError("peer token is required; configure tokenEnv or tokenFile")
    return headers, token_source


def request_json(
    registry: dict[str, Any],
    peer: dict[str, Any],
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    timeout_seconds: float | None = None,
) -> dict[str, Any]:
    headers, _ = peer_headers(registry, peer)
    data = None
    if body is not None:
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    timeout = timeout_seconds
    if timeout is None:
        timeout_ms = peer.get("timeoutMs", registry.get("timeoutMs", 600_000))
        try:
            timeout = float(timeout_ms) / 1000.0
        except (TypeError, ValueError) as error:
            raise PeerError("timeoutMs must be numeric") from error
    if timeout <= 0:
        raise PeerError("timeoutMs must be positive")
    request = Request(
        f"{peer['url']}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = response.read()
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace").strip()
        raise PeerError(f"{method} {path} failed with HTTP {error.code}: {detail}") from error
    except (TimeoutError, socket.timeout) as error:
        raise PeerError(f"{method} {path} timed out") from error
    except URLError as error:
        raise PeerError(f"{method} {path} failed: {error}") from error
    if not payload:
        return {}
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PeerError(f"{method} {path} returned invalid JSON: {error}") from error
    if not isinstance(value, dict):
        raise PeerError(f"{method} {path} returned non-object JSON")
    return value


def positive_seconds(value: str) -> float:
    try:
        seconds = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be numeric") from error
    if not math.isfinite(seconds):
        raise argparse.ArgumentTypeError("must be finite")
    if seconds <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return seconds


def task_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    task = payload.get("task")
    if isinstance(task, dict):
        return task
    return payload


def task_state(payload: dict[str, Any]) -> str:
    task = task_from_payload(payload)
    status = task.get("status") if isinstance(task.get("status"), dict) else {}
    state = status.get("state")
    return state if isinstance(state, str) else ""


def task_is_active(payload: dict[str, Any]) -> bool:
    return task_state(payload).strip().lower() in ACTIVE_TASK_STATES


def task_id_from_payload(payload: dict[str, Any]) -> str:
    task = task_from_payload(payload)
    task_id = task.get("id")
    return task_id if isinstance(task_id, str) else ""


def text_from_parts(parts: Any) -> str:
    if not isinstance(parts, list):
        return ""
    texts = [
        str(part.get("text"))
        for part in parts
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    ]
    return "\n".join(texts).strip()


def task_text(task: dict[str, Any]) -> str:
    status = task.get("status") if isinstance(task.get("status"), dict) else {}
    message = status.get("message") if isinstance(status.get("message"), dict) else {}
    text = text_from_parts(message.get("parts"))
    if text:
        return text
    direct_message = task.get("message") if isinstance(task.get("message"), dict) else {}
    text = text_from_parts(direct_message.get("parts"))
    if text:
        return text
    text = text_from_parts(task.get("parts"))
    if text:
        return text
    artifacts = task.get("artifacts") if isinstance(task.get("artifacts"), list) else []
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            continue
        for part in artifact.get("parts") or []:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                return part["text"].strip()
    return ""


def print_task(payload: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return
    task = task_from_payload(payload)
    status = task.get("status") if isinstance(task.get("status"), dict) else {}
    print(f"task: {task.get('id', '')}")
    print(f"state: {status.get('state', '')}")
    context_id = task.get("contextId")
    if context_id:
        print(f"context: {context_id}")
    text = task_text(task)
    if text:
        print()
        print(text)


def wait_for_task(
    registry: dict[str, Any],
    peer: dict[str, Any],
    task_id: str,
    interval_seconds: float,
    max_wait_seconds: float,
    timeout_seconds: float | None,
    started_at: float | None = None,
) -> dict[str, Any]:
    if started_at is None:
        started_at = time.monotonic()
    deadline = started_at + max_wait_seconds
    latest_payload: dict[str, Any] = {}
    latest_state = "unknown"
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise PeerError(
                f"task {task_id!r} did not finish within {max_wait_seconds:g}s; latest state: {latest_state}"
            )
        request_timeout = remaining if timeout_seconds is None else min(timeout_seconds, remaining)
        try:
            latest_payload = request_json(
                registry,
                peer,
                "GET",
                f"/tasks/{quote(task_id, safe='')}",
                timeout_seconds=request_timeout,
            )
        except PeerError as error:
            if time.monotonic() >= deadline:
                raise PeerError(
                    f"task {task_id!r} did not finish within {max_wait_seconds:g}s; latest state: {latest_state}"
                ) from error
            raise
        latest_state = task_state(latest_payload) or "unknown"
        if not task_is_active(latest_payload):
            return latest_payload
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise PeerError(
                f"task {task_id!r} did not finish within {max_wait_seconds:g}s; latest state: {latest_state}"
            )
        time.sleep(min(interval_seconds, remaining))


def prompt_from_args(args: argparse.Namespace) -> str:
    if args.stdin:
        return sys.stdin.read().strip()
    if args.message == ["-"]:
        return sys.stdin.read().strip()
    text = " ".join(args.message).strip()
    if not text and not sys.stdin.isatty():
        text = sys.stdin.read().strip()
    if not text:
        raise PeerError("message text is required")
    return text


def normalize_send_args(registry: dict[str, Any], args: argparse.Namespace) -> None:
    if args.peer:
        return
    if not args.message:
        return
    peers = registry_peers(registry)
    first_token = args.message[0]
    if first_token in peers:
        args.peer = first_token
        args.message = args.message[1:]


def cmd_list(registry: dict[str, Any], args: argparse.Namespace) -> None:
    peers = registry_peers(registry)
    if args.json:
        safe = {"peers": {}}
        for name, peer in peers.items():
            safe["peers"][name] = {
                "url": normalize_base_url(str(peer.get("url", ""))),
                "tokenSource": token_source_hint(registry, peer),
            }
        print(json.dumps(safe, indent=2, sort_keys=True))
        return
    for name in sorted(peers):
        peer = peers[name]
        token_source = token_source_hint(registry, peer)
        print(f"{name}\t{normalize_base_url(str(peer.get('url', '')))}\tauth={token_source}")


def cmd_card(registry: dict[str, Any], args: argparse.Namespace) -> None:
    _, peer = resolve_peer(registry, args.peer)
    payload = request_json(registry, peer, "GET", "/.well-known/agent-card.json", timeout_seconds=args.timeout)
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return
    print(f"name: {payload.get('name', '')}")
    print(f"url: {payload.get('url', '')}")
    print(f"version: {payload.get('protocolVersion', payload.get('version', ''))}")


def cmd_send(registry: dict[str, Any], args: argparse.Namespace) -> None:
    normalize_send_args(registry, args)
    peer_name, peer = resolve_peer(registry, args.peer)
    text = prompt_from_args(args)
    metadata = {
        "relayPeer": peer_name,
        "relaySentAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if args.from_agent:
        metadata["handoffFrom"] = args.from_agent
    return_immediately = bool(args.return_immediately or args.wait)
    body = {
        "message": {
            "messageId": args.message_id or f"codex-a2a-peer-{uuid.uuid4().hex}",
            "role": "ROLE_USER",
            "parts": [{"text": text, "mediaType": "text/plain"}],
            "metadata": metadata,
        },
        "configuration": {"returnImmediately": return_immediately},
    }
    if args.context_id:
        body["message"]["contextId"] = args.context_id
    if args.task_id:
        body["message"]["taskId"] = args.task_id
    wait_started_at = time.monotonic() if args.wait else None
    send_timeout = args.timeout
    if wait_started_at is not None:
        send_remaining = wait_started_at + args.max_wait - time.monotonic()
        if send_remaining <= 0:
            raise PeerError(f"message:send did not finish within {args.max_wait:g}s")
        send_timeout = send_remaining if args.timeout is None else min(args.timeout, send_remaining)
    try:
        payload = request_json(registry, peer, "POST", "/message:send", body, timeout_seconds=send_timeout)
    except PeerError as error:
        if wait_started_at is not None and time.monotonic() >= wait_started_at + args.max_wait:
            raise PeerError(f"message:send did not finish within {args.max_wait:g}s") from error
        raise
    if args.wait:
        if task_is_active(payload):
            task_id = task_id_from_payload(payload)
            if not task_id:
                raise PeerError("message:send response did not include a task id to wait on")
            payload = wait_for_task(
                registry,
                peer,
                task_id,
                args.wait_interval,
                args.max_wait,
                args.timeout,
                started_at=wait_started_at,
            )
    print_task(payload, args.json)


def cmd_task(registry: dict[str, Any], args: argparse.Namespace) -> None:
    _, peer = resolve_peer(registry, args.peer)
    payload = request_json(registry, peer, "GET", f"/tasks/{quote(args.task_id, safe='')}", timeout_seconds=args.timeout)
    print_task(payload, args.json)


def cmd_wait(registry: dict[str, Any], args: argparse.Namespace) -> None:
    _, peer = resolve_peer(registry, args.peer)
    payload = wait_for_task(
        registry,
        peer,
        args.task_id,
        args.interval,
        args.max_wait,
        args.timeout,
    )
    print_task(payload, args.json)


def cmd_cancel(registry: dict[str, Any], args: argparse.Namespace) -> None:
    _, peer = resolve_peer(registry, args.peer)
    payload = request_json(
        registry,
        peer,
        "POST",
        f"/tasks/{quote(args.task_id, safe='')}:cancel",
        timeout_seconds=args.timeout,
    )
    print_task(payload, args.json)


def cmd_tasks(registry: dict[str, Any], args: argparse.Namespace) -> None:
    _, peer = resolve_peer(registry, args.peer)
    payload = request_json(registry, peer, "GET", "/tasks", timeout_seconds=args.timeout)
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return
    tasks = payload.get("tasks") if isinstance(payload.get("tasks"), list) else []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        status = task.get("status") if isinstance(task.get("status"), dict) else {}
        print(f"{task.get('id', '')}\t{status.get('state', '')}\t{task.get('contextId', '')}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Send A2A handoffs to configured peers")
    parser.add_argument("--config", help=f"peer registry path (default: {DEFAULT_CONFIG_PATH})")
    subcommands = parser.add_subparsers(dest="command", required=True)

    list_parser = subcommands.add_parser("list", help="list configured peers")
    list_parser.add_argument("--json", action="store_true", help="print JSON")
    list_parser.set_defaults(handler=cmd_list)

    card_parser = subcommands.add_parser("card", help="fetch a peer Agent Card")
    card_parser.add_argument("peer", nargs="?", help="peer name")
    card_parser.add_argument("--json", action="store_true", help="print JSON")
    card_parser.add_argument("--timeout", type=positive_seconds, help="request timeout in seconds")
    card_parser.set_defaults(handler=cmd_card)

    for name in ("send", "relay"):
        send_parser = subcommands.add_parser(name, help="send a message to a peer")
        send_parser.add_argument("--peer", help="peer name")
        send_parser.add_argument("message", nargs="*", help="message text, or '-' for stdin")
        send_parser.add_argument("--async", dest="return_immediately", action="store_true", help="return immediately with a working task")
        send_parser.add_argument("--wait", action="store_true", help="poll the returned task until it settles")
        send_parser.add_argument(
            "--wait-interval",
            type=positive_seconds,
            default=DEFAULT_WAIT_INTERVAL_SECONDS,
            help=f"seconds between --wait polls (default: {DEFAULT_WAIT_INTERVAL_SECONDS:g})",
        )
        send_parser.add_argument(
            "--max-wait",
            type=positive_seconds,
            default=DEFAULT_WAIT_MAX_SECONDS,
            help=f"maximum seconds to wait before failing (default: {DEFAULT_WAIT_MAX_SECONDS:g})",
        )
        send_parser.add_argument("--context-id", help="A2A context id")
        send_parser.add_argument("--task-id", help="A2A task id for follow-up messages")
        send_parser.add_argument("--message-id", help="A2A message id")
        send_parser.add_argument("--from", dest="from_agent", help="originating agent name for handoff metadata")
        send_parser.add_argument("--stdin", action="store_true", help="read message text from stdin")
        send_parser.add_argument("--json", action="store_true", help="print JSON")
        send_parser.add_argument("--timeout", type=positive_seconds, help="request timeout in seconds")
        send_parser.set_defaults(handler=cmd_send)

    task_parser = subcommands.add_parser("task", help="fetch a task from a peer")
    task_parser.add_argument("peer", nargs="?", help="peer name")
    task_parser.add_argument("task_id", help="task id")
    task_parser.add_argument("--json", action="store_true", help="print JSON")
    task_parser.add_argument("--timeout", type=positive_seconds, help="request timeout in seconds")
    task_parser.set_defaults(handler=cmd_task)

    wait_parser = subcommands.add_parser("wait", help="poll a peer task until it settles")
    wait_parser.add_argument("peer", nargs="?", help="peer name")
    wait_parser.add_argument("task_id", help="task id")
    wait_parser.add_argument("--json", action="store_true", help="print JSON")
    wait_parser.add_argument(
        "--interval",
        type=positive_seconds,
        default=DEFAULT_WAIT_INTERVAL_SECONDS,
        help=f"seconds between polls (default: {DEFAULT_WAIT_INTERVAL_SECONDS:g})",
    )
    wait_parser.add_argument(
        "--max-wait",
        type=positive_seconds,
        default=DEFAULT_WAIT_MAX_SECONDS,
        help=f"maximum seconds to wait before failing (default: {DEFAULT_WAIT_MAX_SECONDS:g})",
    )
    wait_parser.add_argument("--timeout", type=positive_seconds, help="request timeout in seconds")
    wait_parser.set_defaults(handler=cmd_wait)

    cancel_parser = subcommands.add_parser("cancel", help="cancel a task on a peer")
    cancel_parser.add_argument("peer", help="peer name")
    cancel_parser.add_argument("task_id", help="task id")
    cancel_parser.add_argument("--json", action="store_true", help="print JSON")
    cancel_parser.add_argument("--timeout", type=positive_seconds, help="request timeout in seconds")
    cancel_parser.set_defaults(handler=cmd_cancel)

    tasks_parser = subcommands.add_parser("tasks", help="list retained tasks from a peer")
    tasks_parser.add_argument("peer", nargs="?", help="peer name")
    tasks_parser.add_argument("--json", action="store_true", help="print JSON")
    tasks_parser.add_argument("--timeout", type=positive_seconds, help="request timeout in seconds")
    tasks_parser.set_defaults(handler=cmd_tasks)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        registry = load_json(config_path(args.config))
        args.handler(registry, args)
    except PeerError as error:
        print(f"codex-a2a-peer: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

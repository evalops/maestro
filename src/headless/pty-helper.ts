import { spawnSync } from "node:child_process";

let cachedPythonCommand: string | null | undefined;

export function getHeadlessPtyPythonCommand(): string {
	if (cachedPythonCommand !== undefined) {
		if (cachedPythonCommand === null) {
			throw new Error("Python 3 is required for PTY utility commands");
		}
		return cachedPythonCommand;
	}

	for (const candidate of ["python3", "python"]) {
		const result = spawnSync(candidate, ["-c", "import sys"], {
			stdio: "ignore",
		});
		if (result.status === 0) {
			cachedPythonCommand = candidate;
			return candidate;
		}
	}

	cachedPythonCommand = null;
	throw new Error("Python 3 is required for PTY utility commands");
}

export interface HeadlessPtyHelperConfig {
	command: string;
	argv?: string[];
	cwd?: string;
	env?: Record<string, string>;
	shell_mode: "shell" | "direct";
	columns: number;
	rows: number;
}

export function encodeHeadlessPtyHelperConfig(
	config: HeadlessPtyHelperConfig,
): string {
	return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}

export const HEADLESS_PTY_HELPER_SCRIPT = String.raw`
import base64
import json
import os
import select
import signal
import struct
import subprocess
import sys
import threading

try:
    import fcntl
    import pty
    import termios
except ImportError as exc:
    sys.stdout.write(json.dumps({"type": "error", "message": f"PTY mode is not supported on {sys.platform}: {exc}"}) + "\n")
    sys.stdout.flush()
    raise SystemExit(1)

emit_lock = threading.Lock()


def emit(message):
    line = json.dumps(message, ensure_ascii=False)
    with emit_lock:
        try:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except BrokenPipeError:
            raise SystemExit(0)


def decode_config(raw):
    padded = raw + ("=" * (-len(raw) % 4))
    decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
    return json.loads(decoded.decode("utf-8"))


def clamp_size(value, fallback):
    try:
        parsed = int(value)
    except Exception:
        return fallback
    return max(1, parsed)


def set_winsize(fd, columns, rows):
    cols = clamp_size(columns, 80)
    lines = clamp_size(rows, 24)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", lines, cols, 0, 0))
    return cols, lines


def terminate_process(proc, force):
    try:
        pgid = os.getpgid(proc.pid)
    except ProcessLookupError:
        return
    try:
        os.killpg(pgid, signal.SIGKILL if force else signal.SIGTERM)
    except ProcessLookupError:
        return


config = decode_config(sys.argv[1])
master_fd = None
slave_fd = None
proc = None
reader_thread = None
termination_reason = None
current_columns = clamp_size(config.get("columns", 80), 80)
current_rows = clamp_size(config.get("rows", 24), 24)


def reader():
    while True:
        try:
            chunk = os.read(master_fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        emit({"type": "output", "content": chunk.decode("utf-8", errors="replace")})


try:
    master_fd, slave_fd = pty.openpty()
    current_columns, current_rows = set_winsize(
        slave_fd, current_columns, current_rows
    )

    env = os.environ.copy()
    env.update(config.get("env") or {})

    shell_mode = config.get("shell_mode") or "shell"
    cwd = config.get("cwd")
    if shell_mode == "shell":
        shell = env.get("SHELL") or "/bin/bash"
        proc = subprocess.Popen(
            [shell, "-lc", config["command"]],
            cwd=cwd,
            env=env,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            start_new_session=True,
            close_fds=True,
        )
    else:
        argv = config.get("argv") or []
        if not argv:
            raise ValueError("PTY direct mode requires argv")
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            start_new_session=True,
            close_fds=True,
        )

    os.close(slave_fd)
    slave_fd = None
    emit(
        {
            "type": "started",
            "pid": proc.pid,
            "columns": current_columns,
            "rows": current_rows,
        }
    )
    reader_thread = threading.Thread(target=reader, daemon=True)
    reader_thread.start()

    stdin_closed = False
    while proc.poll() is None:
        ready, _, _ = select.select([sys.stdin], [], [], 0.1)
        if not ready:
            continue
        line = sys.stdin.readline()
        if line == "":
            stdin_closed = True
            if proc.poll() is None:
                termination_reason = termination_reason or "Control channel closed"
                terminate_process(proc, False)
            break

        control = json.loads(line)
        control_type = control.get("type")
        if control_type == "stdin":
            content = control.get("content") or ""
            if content:
                os.write(master_fd, content.encode("utf-8"))
            if control.get("eof"):
                os.write(master_fd, b"\x04")
        elif control_type == "resize":
            current_columns, current_rows = set_winsize(
                master_fd, control.get("columns"), control.get("rows")
            )
            emit(
                {
                    "type": "resized",
                    "columns": current_columns,
                    "rows": current_rows,
                }
            )
        elif control_type == "terminate":
            termination_reason = control.get("reason") or termination_reason
            terminate_process(proc, bool(control.get("force")))
        else:
            emit({"type": "error", "message": f"Unknown PTY control message: {control_type}"})
            termination_reason = termination_reason or "Unknown PTY control message"
            terminate_process(proc, True)
            break

    return_code = proc.wait()
    if reader_thread is not None:
        reader_thread.join(timeout=1.0)

    signal_name = None
    exit_code = return_code
    success = return_code == 0
    if return_code < 0:
        success = False
        exit_code = None
        try:
            signal_name = signal.Signals(-return_code).name
        except ValueError:
            signal_name = str(-return_code)

    emit(
        {
            "type": "exited",
            "success": success,
            "exit_code": exit_code,
            "signal": signal_name,
            "reason": termination_reason,
        }
    )
except Exception as exc:
    emit({"type": "error", "message": str(exc)})
finally:
    try:
        if slave_fd is not None:
            os.close(slave_fd)
    except OSError:
        pass
    try:
        if master_fd is not None:
            os.close(master_fd)
    except OSError:
        pass
`;

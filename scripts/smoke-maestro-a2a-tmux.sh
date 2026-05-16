#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${MAESTRO_A2A_TMUX_SESSION:-maestro-a2a-smoke}"
WORK_DIR="${MAESTRO_A2A_TMUX_WORK_DIR:-"$ROOT_DIR/tmp/a2a-tmux-smoke"}"
LOG_DIR="$WORK_DIR/logs"
REGISTRY_A="$WORK_DIR/peer-a-registry.json"
REGISTRY_B="$WORK_DIR/peer-b-registry.json"
TASKS_A="$WORK_DIR/peer-a-tasks.json"
TASKS_B="$WORK_DIR/peer-b-tasks.json"
READY_TIMEOUT_SECONDS="${MAESTRO_A2A_TMUX_READY_TIMEOUT_SECONDS:-120}"
KEEP_SESSION="${MAESTRO_A2A_TMUX_KEEP_SESSION:-0}"

require_cmd() {
	local cmd="$1"
	if ! command -v "$cmd" >/dev/null 2>&1; then
		echo "missing required command: $cmd" >&2
		exit 1
	fi
}

allocate_port() {
	node -e '
const net = require("node:net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(1);
  const port = address.port;
  server.close(() => {
    console.log(port);
  });
});
server.on("error", () => process.exit(1));
'
}

wait_for_health() {
	local name="$1"
	local url="$2"
	local deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
	while (( SECONDS < deadline )); do
		if curl -fsS "$url/healthz" >/dev/null 2>&1; then
			echo "$name ready at $url"
			return 0
		fi
		sleep 1
	done
	echo "$name did not become ready at $url within ${READY_TIMEOUT_SECONDS}s" >&2
	tmux capture-pane -t "$SESSION_NAME:$name" -p -S -120 >&2 || true
	return 1
}

cleanup() {
	local status=$?
	if [[ "$KEEP_SESSION" != "1" ]]; then
		tmux kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
	else
		echo "leaving tmux session attached state for inspection: $SESSION_NAME"
	fi
	exit "$status"
}

a2a_cli() {
	local registry="$1"
	shift
	MAESTRO_A2A_PEERS_FILE="$registry" bun run a2a -- "$@"
}

require_cmd tmux
require_cmd cargo
require_cmd bun
require_cmd node
require_cmd curl

cd "$ROOT_DIR"
mkdir -p "$LOG_DIR"
rm -f "$REGISTRY_A" "$REGISTRY_B" "$TASKS_A" "$TASKS_B"

if tmux has-session -t "$SESSION_NAME" >/dev/null 2>&1; then
	echo "tmux session already exists: $SESSION_NAME" >&2
	echo "kill it or set MAESTRO_A2A_TMUX_SESSION to another name" >&2
	exit 1
fi

PORT_A="$(allocate_port)"
PORT_B="$(allocate_port)"
BASE_A="http://127.0.0.1:$PORT_A"
BASE_B="http://127.0.0.1:$PORT_B"

trap cleanup EXIT INT TERM

tmux new-session -d -s "$SESSION_NAME" -n peer-a \
	"cd '$ROOT_DIR' && env MAESTRO_HOME='$WORK_DIR/peer-a-home' MAESTRO_A2A_AGENT_NAME='Maestro A2A tmux peer A' MAESTRO_A2A_FAKE_RESPONSE='tmux peer A received the A2A message' MAESTRO_CONTROL_HOST='127.0.0.1' MAESTRO_WEB_REQUIRE_KEY='0' PORT='$PORT_A' cargo run --quiet --manifest-path packages/control-plane-rs/Cargo.toml --bin maestro-control-plane 2>&1 | tee '$LOG_DIR/peer-a.log'"

tmux new-window -t "$SESSION_NAME" -n peer-b \
	"cd '$ROOT_DIR' && env MAESTRO_HOME='$WORK_DIR/peer-b-home' MAESTRO_A2A_AGENT_NAME='Maestro A2A tmux peer B' MAESTRO_A2A_FAKE_RESPONSE='tmux peer B received the A2A message' MAESTRO_CONTROL_HOST='127.0.0.1' MAESTRO_WEB_REQUIRE_KEY='0' PORT='$PORT_B' cargo run --quiet --manifest-path packages/control-plane-rs/Cargo.toml --bin maestro-control-plane 2>&1 | tee '$LOG_DIR/peer-b.log'"

wait_for_health peer-a "$BASE_A"
wait_for_health peer-b "$BASE_B"

echo "creating native pairing offers"
CODE_A="$(a2a_cli "$REGISTRY_A" offer --url "$BASE_A" --name peer-a --peer-id peer-a --ttl-minutes 5)"
CODE_B="$(a2a_cli "$REGISTRY_B" offer --url "$BASE_B" --name peer-b --peer-id peer-b --ttl-minutes 5)"

echo "accepting peer offers into isolated registries"
a2a_cli "$REGISTRY_A" accept "$CODE_B" --name peer-b --default
a2a_cli "$REGISTRY_B" accept "$CODE_A" --name peer-a --default
a2a_cli "$REGISTRY_A" peers
a2a_cli "$REGISTRY_B" peers

echo "delegating peer-a -> peer-b with bounded wait and durable ledger"
DELEGATE_A_TO_B="$(a2a_cli "$REGISTRY_A" delegate peer-b "run the tmux A2A smoke from peer A" --role background-worker --cwd "$ROOT_DIR" --wait --tasks "$TASKS_A" --max-wait-ms 30000 --interval-ms 250 --timeout-ms 3000)"
echo "$DELEGATE_A_TO_B"
if ! grep -q "tmux peer B received the A2A message" <<<"$DELEGATE_A_TO_B"; then
	echo "peer-a -> peer-b delegation response did not include expected peer B text" >&2
	exit 1
fi

echo "checking fleet and delegated task views"
FLEET_A="$(a2a_cli "$REGISTRY_A" fleet --json --tasks "$TASKS_A" --timeout-ms 3000)"
echo "$FLEET_A"
if ! grep -q '"status": "online"' <<<"$FLEET_A"; then
	echo "fleet output did not show peer-b online" >&2
	exit 1
fi
if ! grep -q '"lastTask"' <<<"$FLEET_A"; then
	echo "fleet output did not include the delegated task summary" >&2
	exit 1
fi
TASKS_A_OUT="$(a2a_cli "$REGISTRY_A" tasks --json --tasks "$TASKS_A")"
echo "$TASKS_A_OUT"
if ! grep -q '"state": "TASK_STATE_COMPLETED"' <<<"$TASKS_A_OUT"; then
	echo "task ledger did not record completed delegation" >&2
	exit 1
fi

echo "sending peer-b -> peer-a, then verifying explicit wait"
SEND_B_TO_A="$(a2a_cli "$REGISTRY_B" send peer-a "hello from tmux peer B" --timeout-ms 3000)"
echo "$SEND_B_TO_A"
TASK_ID="$(sed -n 's/^Task \([^:]*\):.*/\1/p' <<<"$SEND_B_TO_A" | head -n 1)"
if [[ -z "$TASK_ID" ]]; then
	echo "could not parse task id from peer-b -> peer-a send output" >&2
	exit 1
fi
WAIT_B_TO_A="$(a2a_cli "$REGISTRY_B" wait peer-a "$TASK_ID" --max-wait-ms 30000 --interval-ms 250 --timeout-ms 3000)"
echo "$WAIT_B_TO_A"
if ! grep -q "tmux peer A received the A2A message" <<<"$WAIT_B_TO_A"; then
	echo "peer-b -> peer-a wait output did not include expected peer A text" >&2
	exit 1
fi

cat <<EOF
tmux A2A smoke passed
  session: $SESSION_NAME
  peer-a:  $BASE_A
  peer-b:  $BASE_B
  logs:    $LOG_DIR
EOF

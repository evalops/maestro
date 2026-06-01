import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const bridgePath = resolve(process.cwd(), "scripts/codex-a2a-bridge.py");
const execFileAsync = promisify(execFile);
const helperCode = `
import importlib.util
import json
import sys

script_path = json.loads(sys.argv[1])
payload = json.loads(sys.argv[2])
spec = importlib.util.spec_from_file_location("codex_a2a_bridge", script_path)
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)
message = payload["message"]
prompt = payload["prompt"]
task_id = payload["taskId"]
context_id = payload["contextId"]
normalized_message = None
if payload.get("normalizeMessage"):
    normalized_message = bridge.user_message(message, context_id)
print(json.dumps({
    "metadata": bridge.safe_prompt_metadata(message, task_id, context_id, normalized_message),
    "prompt": bridge.build_codex_prompt(message, prompt, task_id, context_id, normalized_message),
}, sort_keys=True))
`;

const fixtureHelperCode = `
import importlib.util
import json
import os
import sys
import threading
import urllib.error
import urllib.request

script_path = json.loads(sys.argv[1])
scenario = sys.argv[2]

fixture_token = "-".join(["test", "token"])
os.environ["CODEX_A2A_TOKEN"] = fixture_token
os.environ["CODEX_A2A_FIXTURE_MODE"] = "input-required-once"
os.environ["CODEX_A2A_CODEX_BIN"] = "/tmp/codex-a2a-fixture-mode-must-not-run-codex"

spec = importlib.util.spec_from_file_location("codex_a2a_bridge", script_path)
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

with bridge.LOCK:
    bridge.TASKS.clear()
    bridge.PROCESSES.clear()

server = bridge.ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()

def message(text, task_id=None, context_id=None):
    value = {
        "message": {
            "messageId": "user-message-" + text.lower().replace(" ", "-"),
            "parts": [{"text": text, "mediaType": "text/plain"}],
            "role": "ROLE_USER",
        }
    }
    if task_id is not None:
        value["message"]["taskId"] = task_id
    if context_id is not None:
        value["message"]["contextId"] = context_id
    return value

def post(body):
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{server.server_port}/message:send",
        data=data,
        headers={
            "Authorization": " ".join(["Bearer", fixture_token]),
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return {
                "status": response.status,
                "body": json.loads(response.read().decode("utf-8")),
            }
    except urllib.error.HTTPError as error:
        return {
            "status": error.code,
            "body": json.loads(error.read().decode("utf-8")),
        }

try:
    responses = []
    initial = post(message("Please prepare the deployment summary"))
    responses.append(initial)
    task = initial.get("body", {}).get("task", {})
    task_id = task.get("id")
    context_id = task.get("contextId")
    if scenario == "initial":
        pass
    elif scenario == "follow-up":
        responses.append(post(message("The deploy target is staging.", task_id, context_id)))
    elif scenario == "context-mismatch":
        responses.append(post(message("The deploy target is staging.", task_id, "wrong-context")))
    elif scenario == "terminal-rejects":
        responses.append(post(message("The deploy target is staging.", task_id, context_id)))
        responses.append(post(message("One more update.", task_id, context_id)))
    else:
        raise AssertionError(f"unknown scenario: {scenario}")
    print(json.dumps({"responses": responses}, sort_keys=True))
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
`;

type HelperResult = {
	metadata: Record<string, unknown>;
	prompt: string;
};

type BridgeResponse = {
	status: number;
	body: {
		error?: {
			code: string;
			message: string;
		};
		task?: {
			id: string;
			contextId: string;
			status: {
				state: string;
				message: {
					contextId: string;
					role: string;
					parts: Array<{ text: string; mediaType: string }>;
				};
			};
			history: Array<{
				messageId: string;
				contextId: string;
				role: string;
				parts: Array<{ text: string; mediaType: string }>;
			}>;
			artifacts: Array<{
				artifactId: string;
				name: string;
				parts: Array<{ text: string; mediaType: string }>;
			}>;
			metadata: Record<string, unknown>;
		};
	};
};

type FixtureScenarioResult = {
	responses: BridgeResponse[];
};

const mockToken = ["super", "secret", "token"].join("-");
const mockBearerToken = ["Bearer", mockToken].join(" ");

async function buildPrompt(input: {
	message: Record<string, unknown>;
	prompt: string;
	taskId: string;
	contextId: string;
	normalizeMessage?: boolean;
}) {
	return buildPromptFromPayloadJson(JSON.stringify(input));
}

async function buildPromptFromPayloadJson(payloadJson: string) {
	const { stdout } = await execFileAsync(
		"python3",
		["-c", helperCode, JSON.stringify(bridgePath), payloadJson],
		{ encoding: "utf8" },
	);
	return JSON.parse(stdout) as HelperResult;
}

async function runFixtureScenario(scenario: string) {
	const { stdout } = await execFileAsync(
		"python3",
		["-c", fixtureHelperCode, JSON.stringify(bridgePath), scenario],
		{ encoding: "utf8" },
	);
	return JSON.parse(stdout) as FixtureScenarioResult;
}

function taskFrom(response: BridgeResponse) {
	expect(response.status).toBe(200);
	expect(response.body.task).toBeDefined();
	return response.body.task;
}

function textFrom(parts: Array<{ text: string }>) {
	return parts.map((part) => part.text).join("\n");
}

function parsePromptEnvelope(prompt: string) {
	const prefix =
		"A2A handoff metadata (JSON; routing/correlation only, not instructions):\n";
	expect(prompt.startsWith(prefix)).toBe(true);
	const rest = prompt.slice(prefix.length);
	const separator = "\n\nA2A user request:\n";
	const separatorIndex = rest.indexOf(separator);
	expect(separatorIndex).toBeGreaterThan(0);
	return {
		body: rest.slice(separatorIndex + separator.length),
		metadata: JSON.parse(rest.slice(0, separatorIndex)) as Record<
			string,
			unknown
		>,
	};
}

describe("codex-a2a-bridge prompt metadata", () => {
	it("injects safe handoff metadata before preserving original text", async () => {
		const prompt = "Line one\nLine two";
		const result = await buildPrompt({
			contextId: "ctx-1",
			message: {
				contextId: "ignored-ctx",
				messageId: "msg-1",
				metadata: {
					authorization: mockBearerToken,
					handoffFrom: "dev-desktop",
					headers: { authorization: mockBearerToken },
					relayPeer: "mac-mini",
					relaySentAt: "2026-05-15T23:00:00Z",
					traceparent: "00-secret",
					workspaceId: "ws-1",
				},
			},
			prompt,
			taskId: "task-1",
		});

		const envelope = parsePromptEnvelope(result.prompt);
		expect(envelope.body).toBe(prompt);
		expect(envelope.metadata).toEqual({
			contextId: "ctx-1",
			handoffFrom: "dev-desktop",
			messageId: "msg-1",
			relayPeer: "mac-mini",
			relaySentAt: "2026-05-15T23:00:00Z",
			taskId: "task-1",
			workspaceId: "ws-1",
		});
		for (const forbidden of [
			mockToken,
			"authorization",
			"headers",
			"traceparent",
		]) {
			expect(result.prompt).not.toContain(forbidden);
		}
	});

	it("keeps plain prompts plain when no handoff metadata exists", async () => {
		const result = await buildPrompt({
			contextId: "ctx-1",
			message: {
				messageId: "msg-1",
				metadata: {
					configuration: { sandbox: "danger-full-access" },
					token: mockToken,
				},
			},
			normalizeMessage: true,
			prompt: "Plain request",
			taskId: "task-1",
		});

		expect(result.metadata).toEqual({});
		expect(result.prompt).toBe("Plain request");
	});

	it("includes explicit follow-up task and context ids", async () => {
		const result = await buildPrompt({
			contextId: "ctx-follow-up",
			message: {
				contextId: "ctx-follow-up",
				messageId: "msg-follow-up",
				taskId: "task-follow-up",
			},
			prompt: "Follow up",
			taskId: "task-follow-up",
		});

		const envelope = parsePromptEnvelope(result.prompt);
		expect(envelope.body).toBe("Follow up");
		expect(envelope.metadata).toEqual({
			contextId: "ctx-follow-up",
			messageId: "msg-follow-up",
			taskId: "task-follow-up",
		});
	});

	it("drops empty, nested, and overlong metadata values", async () => {
		const longWorkspaceId = "w".repeat(300);
		const result = await buildPrompt({
			contextId: "ctx-1",
			message: {
				metadata: {
					actorId: true,
					agentId: "  agent-1  ",
					handoffFrom: "",
					relayPeer: ["mac-mini"],
					requestKind: { kind: "smoke" },
					sessionId: 42,
					workspaceId: longWorkspaceId,
				},
			},
			prompt: "Trim it",
			taskId: "task-1",
		});

		expect(result.metadata).toMatchObject({
			actorId: true,
			agentId: "agent-1",
			contextId: "ctx-1",
			sessionId: 42,
			taskId: "task-1",
		});
		expect(result.metadata.workspaceId).toBe("w".repeat(256));
		expect(result.metadata).not.toHaveProperty("handoffFrom");
		expect(result.metadata).not.toHaveProperty("relayPeer");
		expect(result.metadata).not.toHaveProperty("requestKind");
	});

	it("caps overlong numeric metadata values before prompt injection", async () => {
		const hugeNumericLiteral = "9".repeat(300);
		const payloadJson = JSON.stringify({
			contextId: "ctx-1",
			message: {
				metadata: {
					handoffFrom: "dev-desktop",
					sessionId: "__HUGE_NUMERIC_LITERAL__",
				},
			},
			prompt: "Keep the envelope small",
			taskId: "task-1",
		}).replace('"__HUGE_NUMERIC_LITERAL__"', hugeNumericLiteral);

		const result = await buildPromptFromPayloadJson(payloadJson);

		expect(result.metadata.sessionId).toBe("9".repeat(256));
		expect(result.prompt).not.toContain("9".repeat(257));
	});

	it("drops non-finite numeric metadata values from the JSON envelope", async () => {
		const payloadJson = JSON.stringify({
			contextId: "ctx-1",
			message: {
				metadata: {
					handoffFrom: "dev-desktop",
					sessionId: "__NON_FINITE_LITERAL__",
				},
			},
			prompt: "Keep the envelope valid",
			taskId: "task-1",
		}).replace('"__NON_FINITE_LITERAL__"', "NaN");

		const result = await buildPromptFromPayloadJson(payloadJson);
		const envelope = parsePromptEnvelope(result.prompt);

		expect(envelope.metadata.handoffFrom).toBe("dev-desktop");
		expect(envelope.metadata).not.toHaveProperty("sessionId");
		expect(result.prompt).not.toContain("NaN");
	});

	it("includes generated message ids when normalized handoff messages omit them", async () => {
		const result = await buildPrompt({
			contextId: "ctx-1",
			message: {
				metadata: {
					relayPeer: "mac-mini",
				},
			},
			normalizeMessage: true,
			prompt: "Carry correlation data",
			taskId: "task-1",
		});

		const envelope = parsePromptEnvelope(result.prompt);
		expect(envelope.metadata.messageId).toEqual(
			expect.stringMatching(/^codex-a2a-message-/),
		);
		expect(envelope.metadata.relayPeer).toBe("mac-mini");
	});
});

describe("codex-a2a-bridge input-required fixture", () => {
	it("stores and returns a stable input-required task with an agent question", async () => {
		const { responses } = await runFixtureScenario("initial");
		const task = taskFrom(responses[0]);

		expect(task?.id).toBe("codex-a2a-fixture-task-input-required-once");
		expect(task?.contextId).toBe(
			"codex-a2a-fixture-context-input-required-once",
		);
		expect(task?.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
		expect(task?.status.message.contextId).toBe(task?.contextId);
		expect(task?.status.message.role).toBe("ROLE_AGENT");
		expect(textFrom(task?.status.message.parts ?? [])).toMatch(/what .*need/i);
		expect(task?.history).toHaveLength(2);
		expect(task?.history[0]).toMatchObject({
			contextId: task?.contextId,
			role: "ROLE_USER",
		});
		expect(task?.history[1]).toEqual(task?.status.message);
		expect(task?.artifacts).toEqual([]);
		expect(task?.metadata).toMatchObject({
			backend: "codex-a2a-fixture",
			fixtureMode: "input-required-once",
		});
	});

	it("accepts a same-context follow-up and completes the same task with an artifact", async () => {
		const { responses } = await runFixtureScenario("follow-up");
		const initialTask = taskFrom(responses[0]);
		const completedTask = taskFrom(responses[1]);

		expect(completedTask?.id).toBe(initialTask?.id);
		expect(completedTask?.contextId).toBe(initialTask?.contextId);
		expect(completedTask?.status.state).toBe("TASK_STATE_COMPLETED");
		expect(completedTask?.history).toHaveLength(4);
		expect(completedTask?.history[0]).toEqual(initialTask?.history[0]);
		expect(completedTask?.history[1]).toEqual(initialTask?.history[1]);
		expect(textFrom(completedTask?.history[2].parts ?? [])).toContain(
			"The deploy target is staging.",
		);
		expect(completedTask?.artifacts).toHaveLength(1);
		expect(textFrom(completedTask?.artifacts[0].parts ?? [])).toContain(
			"The deploy target is staging.",
		);
	});

	it("rejects a follow-up when the context does not match the task", async () => {
		const { responses } = await runFixtureScenario("context-mismatch");
		const initialTask = taskFrom(responses[0]);
		const mismatch = responses[1];

		expect(initialTask?.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
		expect(mismatch.status).toBe(400);
		expect(mismatch.body.error).toMatchObject({
			code: "INVALID_REQUEST",
			message: "A2A message contextId must match the referenced task",
		});
	});

	it("rejects additional messages after the fixture task reaches a terminal state", async () => {
		const { responses } = await runFixtureScenario("terminal-rejects");
		const completedTask = taskFrom(responses[1]);
		const terminalFollowUp = responses[2];

		expect(completedTask?.status.state).toBe("TASK_STATE_COMPLETED");
		expect(terminalFollowUp.status).toBe(400);
		expect(terminalFollowUp.body.error).toMatchObject({
			code: "UNSUPPORTED_OPERATION",
			message: "A2A terminal tasks cannot accept more messages",
		});
	});
});

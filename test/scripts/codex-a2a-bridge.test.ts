import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const bridgePath = resolve(process.cwd(), "scripts/codex-a2a-bridge.py");
const execFileAsync = promisify(execFile);
const fakeCredential = ["super", "secret", "token"].join("-");
const fakeBearerCredential = ["Bearer", fakeCredential].join(" ");
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
if payload.get("normalizeMessage"):
    message = bridge.user_message(message, context_id)
print(json.dumps({
    "metadata": bridge.safe_prompt_metadata(message, task_id, context_id),
    "prompt": bridge.build_codex_prompt(message, prompt, task_id, context_id),
}, sort_keys=True))
`;

type HelperResult = {
	metadata: Record<string, unknown>;
	prompt: string;
};

async function buildPrompt(input: {
	message: Record<string, unknown>;
	normalizeMessage?: boolean;
	prompt: string;
	taskId: string;
	contextId: string;
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
					authorization: fakeBearerCredential,
					handoffFrom: "dev-desktop",
					headers: { authorization: fakeBearerCredential },
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
			fakeCredential,
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
					token: fakeCredential,
				},
			},
			prompt: "Plain request",
			taskId: "task-1",
		});

		expect(result.metadata).toEqual({});
		expect(result.prompt).toBe("Plain request");
	});

	it("includes generated message ids after normalizing inbound messages", async () => {
		const result = await buildPrompt({
			contextId: "ctx-1",
			message: {
				metadata: {
					handoffFrom: "dev-desktop",
				},
			},
			normalizeMessage: true,
			prompt: "Who sent this?",
			taskId: "task-1",
		});

		const envelope = parsePromptEnvelope(result.prompt);
		expect(envelope.body).toBe("Who sent this?");
		expect(envelope.metadata).toMatchObject({
			contextId: "ctx-1",
			handoffFrom: "dev-desktop",
			taskId: "task-1",
		});
		expect(envelope.metadata.messageId).toMatch(/^codex-a2a-message-/);
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

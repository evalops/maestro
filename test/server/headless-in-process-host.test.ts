import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	AgentEvent,
	AppMessage,
	Attachment,
	ThinkingLevel,
} from "../../src/agent/types.js";
import {
	HEADLESS_PROTOCOL_VERSION,
	type HeadlessRuntimeStreamEnvelope,
} from "../../src/cli/headless-protocol.js";
import { HeadlessUtilityCommandManager } from "../../src/headless/utility-command-manager.js";
import type { RegisteredModel } from "../../src/models/registry.js";
import { HeadlessInProcessHost } from "../../src/server/headless-in-process-host.js";
import { HeadlessRuntimeService } from "../../src/server/headless-runtime-service.js";
import { SessionManager } from "../../src/session/manager.js";

const TEST_MODEL: RegisteredModel = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1/responses",
	reasoning: true,
	toolUse: true,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 200_000,
	maxTokens: 32_000,
	providerName: "OpenAI",
	source: "builtin",
	isLocal: false,
};

class FakeAgent {
	state = {
		model: TEST_MODEL,
		systemPrompt: "",
		thinkingLevel: "off" as ThinkingLevel,
		tools: [],
		messages: [] as AppMessage[],
	};
	private readonly listeners = new Set<(event: AgentEvent) => void>();

	subscribe(listener: (event: AgentEvent) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setSystemPrompt(value: string) {
		this.state.systemPrompt = value;
	}

	setThinkingLevel(level: ThinkingLevel) {
		this.state.thinkingLevel = level;
	}

	abort() {}

	async prompt(_content: string, _attachments?: Attachment[]) {
		this.emit({
			type: "status",
			status: "prompted",
			details: {},
		});
	}

	emit(event: AgentEvent) {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

async function readNextEnvelope(stream: {
	next(): HeadlessRuntimeStreamEnvelope | null;
	onAvailable(listener: () => void): () => void;
}): Promise<HeadlessRuntimeStreamEnvelope> {
	const immediate = stream.next();
	if (immediate) {
		return immediate;
	}
	await new Promise<void>((resolve) => {
		const unsubscribe = stream.onAvailable(() => {
			unsubscribe();
			resolve();
		});
	});
	const next = stream.next();
	if (!next) {
		throw new Error("Expected next headless envelope");
	}
	return next;
}

describe("HeadlessInProcessHost", () => {
	let tempDir: string | null = null;

	afterEach(async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	it("creates sessions and streams utility command events without HTTP", async () => {
		const fakeAgent = new FakeAgent();
		tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-in-process-"));
		const sessionManager = new SessionManager(false, undefined, {
			sessionDir: tempDir,
		});
		const runtimeService = new HeadlessRuntimeService();
		const host = new HeadlessInProcessHost(runtimeService);

		const snapshot = await host.ensureSession({
			scope_key: "anon",
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: "prompt",
			context: {
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			},
			sessionManager,
			capabilities: {
				server_requests: ["approval"],
				utility_operations: ["command_exec"],
			},
		});

		expect(snapshot.protocolVersion).toBe(HEADLESS_PROTOCOL_VERSION);
		expect(snapshot.state.is_ready).toBe(true);

		const stream = host.attachStream({
			scopeKey: "anon",
			sessionId: snapshot.session_id,
			role: "controller",
			cursor: null,
		});
		const first = await readNextEnvelope(stream);
		expect(first.type).toBe("snapshot");

		await host.send({
			scopeKey: "anon",
			sessionId: snapshot.session_id,
			role: "controller",
			message: {
				type: "utility_command_start",
				command_id: "cmd_inline",
				command: `"${process.execPath}" -e "process.stdout.write('hi')"`,
				shell_mode: "direct",
			},
		});

		const seenMessages: HeadlessRuntimeStreamEnvelope[] = [];
		while (
			!seenMessages.some(
				(event) =>
					event.type === "message" &&
					event.message.type === "utility_command_exited",
			)
		) {
			seenMessages.push(await readNextEnvelope(stream));
		}

		expect(
			seenMessages.some(
				(event) =>
					event.type === "message" &&
					event.message.type === "utility_command_started" &&
					event.message.command_id === "cmd_inline",
			),
		).toBe(true);
		expect(
			seenMessages.some(
				(event) =>
					event.type === "message" &&
					event.message.type === "utility_command_output" &&
					event.message.command_id === "cmd_inline" &&
					event.message.content === "hi",
			),
		).toBe(true);

		const finalSnapshot = host.getSnapshot("anon", snapshot.session_id);
		expect(finalSnapshot.state.active_utility_commands).toEqual([]);
		stream.close();
	});

	it("writes stdin to utility commands over the in-process control plane", async () => {
		const fakeAgent = new FakeAgent();
		tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-in-process-"));
		const sessionManager = new SessionManager(false, undefined, {
			sessionDir: tempDir,
		});
		const runtimeService = new HeadlessRuntimeService();
		const host = new HeadlessInProcessHost(runtimeService);

		const snapshot = await host.ensureSession({
			scope_key: "anon",
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: "prompt",
			context: {
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
			},
			sessionManager,
			capabilities: {
				server_requests: ["approval"],
				utility_operations: ["command_exec"],
			},
		});

		const stream = host.attachStream({
			scopeKey: "anon",
			sessionId: snapshot.session_id,
			role: "controller",
			cursor: null,
		});
		expect((await readNextEnvelope(stream)).type).toBe("snapshot");

		await host.send({
			scopeKey: "anon",
			sessionId: snapshot.session_id,
			role: "controller",
			message: {
				type: "utility_command_start",
				command_id: "cmd_stdin",
				command: `"${process.execPath}" -e "process.stdin.setEncoding('utf8');let data='';process.stdin.on('data', chunk => data += chunk);process.stdin.on('end', () => process.stdout.write(data.toUpperCase()));"`,
				shell_mode: "direct",
				allow_stdin: true,
			},
		});
		await host.send({
			scopeKey: "anon",
			sessionId: snapshot.session_id,
			role: "controller",
			message: {
				type: "utility_command_stdin",
				command_id: "cmd_stdin",
				content: "hello maestro",
				eof: true,
			},
		});

		const seenMessages: HeadlessRuntimeStreamEnvelope[] = [];
		while (
			!seenMessages.some(
				(event) =>
					event.type === "message" &&
					event.message.type === "utility_command_exited",
			)
		) {
			seenMessages.push(await readNextEnvelope(stream));
		}

		expect(
			seenMessages.some(
				(event) =>
					event.type === "message" &&
					event.message.type === "utility_command_output" &&
					event.message.command_id === "cmd_stdin" &&
					event.message.content === "HELLO MAESTRO",
			),
		).toBe(true);

		stream.close();
	});
});

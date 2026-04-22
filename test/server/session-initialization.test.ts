import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPolicy } from "../../src/safety/policy.js";
import { startSessionWithPolicy } from "../../src/server/session-initialization.js";

const MOCK_POLICY_PATH = join(homedir(), ".maestro", "policy.json");

function createAgent() {
	return {
		state: {
			messages: [],
			model: {},
			thinkingLevel: "off",
			systemPrompt: "test",
			tools: [],
		},
		setSession: vi.fn(),
	};
}

function createEnterpriseContext() {
	return {
		isEnterprise: vi.fn(() => false),
		startSession: vi.fn(),
		getSession: vi.fn(() => null),
	};
}

describe("startSessionWithPolicy", () => {
	let originalPolicy: string | null = null;

	beforeEach(() => {
		vi.clearAllMocks();
		mkdirSync(dirname(MOCK_POLICY_PATH), { recursive: true });
		originalPolicy = existsSync(MOCK_POLICY_PATH)
			? readFileSync(MOCK_POLICY_PATH, "utf8")
			: null;
	});

	afterEach(() => {
		if (originalPolicy === null) {
			if (existsSync(MOCK_POLICY_PATH)) {
				unlinkSync(MOCK_POLICY_PATH);
			}
		} else {
			writeFileSync(MOCK_POLICY_PATH, originalPolicy);
		}
		loadPolicy(true);
	});

	it("uses async manager active-session counts for concurrent session policy", async () => {
		writeFileSync(
			MOCK_POLICY_PATH,
			JSON.stringify({ limits: { maxConcurrentSessions: 1 } }),
		);
		loadPolicy(true);
		const startSession = vi.fn();
		const countActiveSessions = vi.fn(async () => 1);
		const manager = {
			loadAllSessions: vi.fn(() => []),
			countActiveSessions,
			startSession,
			getSessionId: vi.fn(() => "session-id"),
		};

		const result = await startSessionWithPolicy({
			agent: createAgent(),
			enterpriseContext: createEnterpriseContext(),
			logger: { warn: vi.fn() },
			modelId: "test-model",
			onSessionReady: vi.fn(),
			sessionManager: manager,
		});

		expect(result).toContain("Concurrent session limit exceeded");
		expect(countActiveSessions).toHaveBeenCalledWith(expect.any(Date));
		expect(manager.loadAllSessions).not.toHaveBeenCalled();
		expect(startSession).not.toHaveBeenCalled();
	});

	it("starts a session when async active-session count is within policy", async () => {
		writeFileSync(
			MOCK_POLICY_PATH,
			JSON.stringify({ limits: { maxConcurrentSessions: 1 } }),
		);
		loadPolicy(true);
		const startSession = vi.fn();
		const onSessionReady = vi.fn();
		const manager = {
			loadAllSessions: vi.fn(() => []),
			countActiveSessions: vi.fn(async () => 0),
			startSession,
			getSessionId: vi.fn(() => "session-id"),
		};

		const result = await startSessionWithPolicy({
			agent: createAgent(),
			enterpriseContext: createEnterpriseContext(),
			logger: { warn: vi.fn() },
			modelId: "test-model",
			onSessionReady,
			sessionManager: manager,
		});

		expect(result).toBeNull();
		expect(startSession).toHaveBeenCalledTimes(1);
		expect(onSessionReady).toHaveBeenCalledWith("session-id");
	});
});

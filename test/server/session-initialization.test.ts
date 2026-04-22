import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSessionWithPolicy } from "../../src/server/session-initialization.js";

function createAgent() {
	return {
		state: {
			messages: [],
			model: { id: "claude-sonnet-4" },
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

function createLogger() {
	return {
		warn: vi.fn(),
	};
}

describe("startSessionWithPolicy", () => {
	const originalHome = process.env.HOME;
	let tempHome = "";

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "maestro-policy-home-"));
		process.env.HOME = tempHome;
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("awaits async session counts before enforcing concurrent limits", async () => {
		const policyDir = join(tempHome, ".maestro");
		const policyPath = join(policyDir, "policy.json");
		mkdirSync(policyDir, { recursive: true });
		writeFileSync(
			policyPath,
			JSON.stringify({
				limits: { maxConcurrentSessions: 1 },
			}),
			"utf8",
		);

		const agent = createAgent();
		const enterpriseContext = createEnterpriseContext();
		const logger = createLogger();
		const sessionManager = {
			loadAllSessions: vi.fn(async () => [{ modified: new Date() }]),
			startSession: vi.fn(),
			getSessionId: vi.fn(() => "session-1"),
		};
		const onSessionReady = vi.fn();

		const result = await startSessionWithPolicy({
			agent,
			enterpriseContext,
			logger,
			modelId: "claude-sonnet-4",
			onSessionReady,
			sessionManager,
		});

		expect(result).toContain("Concurrent session limit exceeded");
		expect(sessionManager.startSession).not.toHaveBeenCalled();
		expect(onSessionReady).not.toHaveBeenCalled();
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/remote-runner/client.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/remote-runner/client.js")
	>("../../src/remote-runner/client.js");
	return {
		...actual,
		createRunnerSession: vi.fn(),
		waitForRunnerSessionReady: vi.fn(),
		mintRunnerAttachToken: vi.fn(),
		verifyRunnerHeadlessAttach: vi.fn(),
	};
});

vi.mock("../../src/remote-runner/attach-client.js", () => ({
	attachToRemoteRunnerSession: vi.fn(),
	shouldUseInteractiveRemoteAttach: vi.fn(),
}));

import {
	handleRemoteCommand,
	parseRemoteDurationMinutes,
} from "../../src/cli/commands/remote.js";
import {
	attachToRemoteRunnerSession,
	shouldUseInteractiveRemoteAttach,
} from "../../src/remote-runner/attach-client.js";
import {
	RUNNER_SESSION_STATES,
	createRunnerSession,
	mintRunnerAttachToken,
	verifyRunnerHeadlessAttach,
	waitForRunnerSessionReady,
} from "../../src/remote-runner/client.js";

describe("remote command helpers", () => {
	const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(shouldUseInteractiveRemoteAttach).mockReturnValue(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
		if (stdinTty) {
			Object.defineProperty(process.stdin, "isTTY", stdinTty);
		}
		if (stdoutTty) {
			Object.defineProperty(process.stdout, "isTTY", stdoutTty);
		}
	});

	it("parses runner TTL values as whole minutes", () => {
		expect(parseRemoteDurationMinutes("90m", 1)).toBe(90);
		expect(parseRemoteDurationMinutes("2h", 1)).toBe(120);
		expect(parseRemoteDurationMinutes("45", 1)).toBe(45);
		expect(parseRemoteDurationMinutes(undefined, 30)).toBe(30);
	});

	it("rejects sub-minute or fractional-minute TTL values", () => {
		expect(() => parseRemoteDurationMinutes("1.5m", 1)).toThrow(
			"whole minutes",
		);
		expect(() => parseRemoteDurationMinutes("soon", 1)).toThrow(
			"Invalid duration",
		);
	});

	it("waits for readiness and verifies attach during remote start", async () => {
		vi.mocked(shouldUseInteractiveRemoteAttach).mockReturnValue(false);
		vi.mocked(createRunnerSession).mockResolvedValue({
			session: {
				id: "mrs_start_1",
				workspaceId: "ws_evalops",
				state: RUNNER_SESSION_STATES.REQUESTED,
				runnerProfile: "standard",
				repoUrl: "evalops/foo",
				branch: "main",
			},
			events: [],
			replayed: false,
		});
		vi.mocked(waitForRunnerSessionReady).mockResolvedValue({
			session: {
				id: "mrs_start_1",
				workspaceId: "ws_evalops",
				state: RUNNER_SESSION_STATES.RUNNING,
				runnerProfile: "standard",
				repoUrl: "evalops/foo",
				branch: "main",
			},
			attempts: 2,
			elapsedMs: 8_000,
		});
		vi.mocked(mintRunnerAttachToken).mockResolvedValue({
			token: {
				id: "rat_start_1",
				sessionId: "mrs_start_1",
				expiresAt: "2026-04-23T20:00:00Z",
			},
			tokenSecret: "runner-secret",
			gatewayBaseUrl:
				"https://runner.test/v1/runner-sessions/mrs_start_1/headless",
		});
		vi.mocked(verifyRunnerHeadlessAttach).mockResolvedValue({
			sessionId: "sess_runtime_1",
			connectionId: "conn_1",
			heartbeatIntervalMs: 30_000,
			role: "controller",
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await handleRemoteCommand("start", [
			"--workspace",
			"ws_evalops",
			"--repo",
			"evalops/foo",
			"--branch",
			"main",
			"--wait",
			"--wait-timeout",
			"2m",
			"--poll-interval",
			"5s",
			"--verify",
			"--show-secret",
		]);

		expect(errorSpy).not.toHaveBeenCalled();
		expect(waitForRunnerSessionReady).toHaveBeenCalledWith(
			"mrs_start_1",
			expect.objectContaining({
				workspaceId: "ws_evalops",
				timeoutMs: 120_000,
				pollIntervalMs: 5_000,
			}),
		);
		expect(mintRunnerAttachToken).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "mrs_start_1",
				ttlMinutes: 30,
			}),
			expect.objectContaining({
				workspaceId: "ws_evalops",
			}),
		);
		expect(verifyRunnerHeadlessAttach).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "mrs_start_1",
			}),
		);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Remote runner attach token minted"),
		);
		expect(process.exitCode).toBeUndefined();
	});

	it("launches the live attach client for interactive TTY sessions", async () => {
		Object.defineProperty(process.stdin, "isTTY", {
			value: true,
			configurable: true,
		});
		Object.defineProperty(process.stdout, "isTTY", {
			value: true,
			configurable: true,
		});
		vi.mocked(shouldUseInteractiveRemoteAttach).mockReturnValue(true);
		vi.mocked(mintRunnerAttachToken).mockResolvedValue({
			token: {
				id: "rat_attach_1",
				sessionId: "mrs_attach_1",
				expiresAt: "2026-04-23T20:00:00Z",
			},
			tokenSecret: "runner-secret",
			gatewayBaseUrl:
				"https://runner.test/v1/runner-sessions/mrs_attach_1/headless",
		});

		await handleRemoteCommand("attach", ["mrs_attach_1"]);

		expect(shouldUseInteractiveRemoteAttach).toHaveBeenCalledWith({
			json: false,
			printEnv: false,
			stdinIsTTY: true,
			stdoutIsTTY: true,
		});
		expect(attachToRemoteRunnerSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "mrs_attach_1",
				gatewayBaseUrl:
					"https://runner.test/v1/runner-sessions/mrs_attach_1/headless",
				tokenId: "rat_attach_1",
				tokenSecret: "runner-secret",
				role: "controller",
			}),
		);
		expect(verifyRunnerHeadlessAttach).not.toHaveBeenCalled();
	});

	it("keeps the env handoff path for non-interactive attach", async () => {
		Object.defineProperty(process.stdin, "isTTY", {
			value: false,
			configurable: true,
		});
		Object.defineProperty(process.stdout, "isTTY", {
			value: false,
			configurable: true,
		});
		vi.mocked(shouldUseInteractiveRemoteAttach).mockReturnValue(false);
		vi.mocked(mintRunnerAttachToken).mockResolvedValue({
			token: {
				id: "rat_attach_2",
				sessionId: "mrs_attach_2",
				expiresAt: "2026-04-23T20:00:00Z",
			},
			tokenSecret: "runner-secret-2",
			gatewayBaseUrl:
				"https://runner.test/v1/runner-sessions/mrs_attach_2/headless",
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleRemoteCommand("attach", ["mrs_attach_2"]);

		expect(attachToRemoteRunnerSession).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Remote runner attach token minted"),
		);
	});
});

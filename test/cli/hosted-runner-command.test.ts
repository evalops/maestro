import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyHostedRunnerEnvironment,
	resolveHostedRunnerConfig,
	toHostedRunnerContext,
} from "../../src/cli/commands/hosted-runner.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "maestro-hosted-runner-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
	);
});

describe("hosted-runner command config", () => {
	it("resolves required hosted runner flags", async () => {
		const workspaceRoot = await createTempWorkspace();
		const config = await resolveHostedRunnerConfig(
			[
				"--runner-session-id",
				"mrs_123",
				"--workspace-root",
				workspaceRoot,
				"--listen",
				"0.0.0.0:9090",
				"--workspace-id",
				"ws_123",
				"--agent-run-id",
				"ar_123",
			],
			{},
		);

		expect(config).toMatchObject({
			runnerSessionId: "mrs_123",
			workspaceRoot: realpathSync(workspaceRoot),
			host: "0.0.0.0",
			port: 9090,
			workspaceId: "ws_123",
			agentRunId: "ar_123",
		});
		expect(toHostedRunnerContext(config)).toMatchObject({
			enabled: true,
			runnerSessionId: "mrs_123",
			workspaceRoot: realpathSync(workspaceRoot),
			listenHost: "0.0.0.0",
			listenPort: 9090,
		});
	});

	it("resolves env-driven hosted runner config", async () => {
		const workspaceRoot = await createTempWorkspace();
		const config = await resolveHostedRunnerConfig([], {
			MAESTRO_RUNNER_SESSION_ID: "mrs_env",
			MAESTRO_WORKSPACE_ROOT: workspaceRoot,
			MAESTRO_HOSTED_RUNNER_PORT: "7070",
			MAESTRO_REMOTE_RUNNER_WORKSPACE_ID: "ws_env",
		});

		expect(config).toMatchObject({
			runnerSessionId: "mrs_env",
			workspaceRoot: realpathSync(workspaceRoot),
			port: 7070,
			workspaceId: "ws_env",
		});
	});

	it("rejects missing runner session and workspace root", async () => {
		await expect(resolveHostedRunnerConfig([], {})).rejects.toThrow(
			/runner-session-id/,
		);

		await expect(
			resolveHostedRunnerConfig(["--runner-session-id", "mrs_123"], {}),
		).rejects.toThrow(/workspace-root/);
	});

	it("requires API auth by default in hosted-runner mode", async () => {
		const workspaceRoot = await createTempWorkspace();
		const originalCwd = process.cwd();
		const previous = {
			MAESTRO_HOSTED_RUNNER_MODE: process.env.MAESTRO_HOSTED_RUNNER_MODE,
			MAESTRO_RUNNER_SESSION_ID: process.env.MAESTRO_RUNNER_SESSION_ID,
			MAESTRO_WORKSPACE_ROOT: process.env.MAESTRO_WORKSPACE_ROOT,
			MAESTRO_PROFILE: process.env.MAESTRO_PROFILE,
			MAESTRO_WEB_REQUIRE_KEY: process.env.MAESTRO_WEB_REQUIRE_KEY,
			MAESTRO_WEB_REQUIRE_REDIS: process.env.MAESTRO_WEB_REQUIRE_REDIS,
			MAESTRO_WEB_REQUIRE_CSRF: process.env.MAESTRO_WEB_REQUIRE_CSRF,
			MAESTRO_AGENT_DIR: process.env.MAESTRO_AGENT_DIR,
		};
		delete process.env.MAESTRO_PROFILE;
		delete process.env.MAESTRO_WEB_REQUIRE_KEY;
		delete process.env.MAESTRO_WEB_REQUIRE_REDIS;
		delete process.env.MAESTRO_WEB_REQUIRE_CSRF;
		delete process.env.MAESTRO_AGENT_DIR;

		try {
			applyHostedRunnerEnvironment({
				runnerSessionId: "mrs_123",
				workspaceRoot,
				port: 8080,
			});

			expect(process.env.MAESTRO_WEB_REQUIRE_KEY).toBe("1");
			expect(process.env.MAESTRO_WEB_REQUIRE_REDIS).toBe("0");
			expect(process.env.MAESTRO_WEB_REQUIRE_CSRF).toBe("0");
		} finally {
			process.chdir(originalCwd);
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	});
});

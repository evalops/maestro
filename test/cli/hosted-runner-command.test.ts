import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
				"--owner-instance-id",
				"pod_123",
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
			ownerInstanceId: "pod_123",
			workspaceRoot: realpathSync(workspaceRoot),
			host: "0.0.0.0",
			port: 9090,
			workspaceId: "ws_123",
			agentRunId: "ar_123",
		});
		expect(toHostedRunnerContext(config)).toMatchObject({
			enabled: true,
			runnerSessionId: "mrs_123",
			ownerInstanceId: "pod_123",
			workspaceRoot: realpathSync(workspaceRoot),
			listenHost: "0.0.0.0",
			listenPort: 9090,
		});
	});

	it("resolves env-driven hosted runner config", async () => {
		const workspaceRoot = await createTempWorkspace();
		const config = await resolveHostedRunnerConfig([], {
			MAESTRO_RUNNER_SESSION_ID: "mrs_env",
			MAESTRO_REMOTE_RUNNER_OWNER_INSTANCE_ID: "pod_env",
			MAESTRO_WORKSPACE_ROOT: workspaceRoot,
			MAESTRO_HOSTED_RUNNER_PORT: "7070",
			MAESTRO_REMOTE_RUNNER_WORKSPACE_ID: "ws_env",
		});

		expect(config).toMatchObject({
			runnerSessionId: "mrs_env",
			ownerInstanceId: "pod_env",
			workspaceRoot: realpathSync(workspaceRoot),
			port: 7070,
			workspaceId: "ws_env",
		});
	});

	it("lets CLI owner generation override stale environment", async () => {
		const workspaceRoot = await createTempWorkspace();
		const config = await resolveHostedRunnerConfig(
			[
				"--runner-session-id",
				"mrs_123",
				"--owner-instance-id",
				"pod_current",
				"--workspace-root",
				workspaceRoot,
			],
			{
				MAESTRO_REMOTE_RUNNER_OWNER_INSTANCE_ID: "pod_stale",
			},
		);

		expect(config.ownerInstanceId).toBe("pod_current");
	});

	it("rejects missing runner session and workspace root", async () => {
		await expect(resolveHostedRunnerConfig([], {})).rejects.toThrow(
			/runner-session-id/,
		);

		await expect(
			resolveHostedRunnerConfig(["--runner-session-id", "mrs_123"], {}),
		).rejects.toThrow(/workspace-root/);
	});
});

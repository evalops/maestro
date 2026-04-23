import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION,
	buildHostedRunnerIdentity,
} from "../../src/server/handlers/hosted-runner-identity.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "maestro-runner-identity-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
	);
});

describe("hosted runner identity", () => {
	it("returns the Platform attach fence identity when the runtime is ready", async () => {
		const workspaceRoot = await createTempWorkspace();

		await expect(
			buildHostedRunnerIdentity({
				enabled: true,
				runnerSessionId: "mrs_123",
				ownerInstanceId: "pod_123",
				workspaceRoot,
			}),
		).resolves.toEqual({
			protocol_version: HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION,
			runner_session_id: "mrs_123",
			owner_instance_id: "pod_123",
			ready: true,
			draining: false,
		});
	});

	it("reports draining runtimes as not ready", async () => {
		const workspaceRoot = await createTempWorkspace();

		await expect(
			buildHostedRunnerIdentity({
				enabled: true,
				runnerSessionId: "mrs_123",
				ownerInstanceId: "pod_123",
				workspaceRoot,
				draining: true,
			}),
		).resolves.toMatchObject({
			runner_session_id: "mrs_123",
			owner_instance_id: "pod_123",
			ready: false,
			draining: true,
		});
	});

	it("does not expose identity without the Platform owner generation", async () => {
		const workspaceRoot = await createTempWorkspace();

		await expect(
			buildHostedRunnerIdentity({
				enabled: true,
				runnerSessionId: "mrs_123",
				workspaceRoot,
			}),
		).resolves.toBeNull();
	});

	it("reports missing workspaces as unavailable without changing identity", async () => {
		const workspaceRoot = join(tmpdir(), "maestro-runner-identity-missing");

		await expect(
			buildHostedRunnerIdentity({
				enabled: true,
				runnerSessionId: "mrs_123",
				ownerInstanceId: "pod_123",
				workspaceRoot,
			}),
		).resolves.toMatchObject({
			runner_session_id: "mrs_123",
			owner_instance_id: "pod_123",
			ready: false,
			draining: false,
		});
	});
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHealthChecks } from "../../src/server/handlers/health.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "maestro-health-workspace-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
	);
});

describe("runHealthChecks", () => {
	it("reports hosted runner metadata when the workspace root is ready", async () => {
		const workspaceRoot = await createTempWorkspace();
		const result = await runHealthChecks({
			hostedRunner: {
				enabled: true,
				runnerSessionId: "mrs_123",
				ownerInstanceId: "pod_123",
				workspaceRoot,
				workspaceId: "ws_123",
				activeMaestroSessionId: "session_123",
			},
		});

		expect(result.checks.hostedRunner).toMatchObject({
			status: "ready",
			runnerSessionId: "mrs_123",
			ownerInstanceId: "pod_123",
			workspaceRoot,
			workspaceId: "ws_123",
			maestroSessionId: "session_123",
		});
	});

	it("marks hosted runner readiness unhealthy while draining", async () => {
		const workspaceRoot = await createTempWorkspace();
		const result = await runHealthChecks({
			hostedRunner: {
				enabled: true,
				runnerSessionId: "mrs_123",
				workspaceRoot,
				draining: true,
				lastDrain: {
					status: "drained",
					manifestPath: "/workspace/.maestro/runner-snapshots/mrs_123.json",
					drainedAt: "2026-04-23T00:00:00.000Z",
					reason: "kubernetes_prestop",
					requestedBy: "kubernetes_prestop",
				},
			},
		});

		expect(result.status).toBe("unhealthy");
		expect(result.checks.hostedRunner?.status).toBe("draining");
		expect(result.checks.hostedRunner?.lastDrain).toMatchObject({
			status: "drained",
			manifestPath: "/workspace/.maestro/runner-snapshots/mrs_123.json",
			drainedAt: "2026-04-23T00:00:00.000Z",
			reason: "kubernetes_prestop",
			requestedBy: "kubernetes_prestop",
		});
	});
});

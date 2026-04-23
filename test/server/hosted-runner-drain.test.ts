import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostedRunnerContext } from "../../src/server/app-context.js";
import {
	HOSTED_RUNNER_DRAIN_PROTOCOL_VERSION,
	HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION,
	drainHostedRunner,
} from "../../src/server/handlers/hosted-runner-drain.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "maestro-runner-drain-"));
	const resolved = await realpath(dir);
	tempDirs.push(resolved);
	await writeFile(join(resolved, "README.md"), "# workspace\n", "utf8");
	return resolved;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
	);
});

function hostedRunnerContext(
	workspaceRoot: string,
	snapshotRoot = join(workspaceRoot, ".maestro", "runner-snapshots"),
): HostedRunnerContext {
	return {
		enabled: true,
		runnerSessionId: "mrs_123",
		ownerInstanceId: "pod_123",
		workspaceRoot,
		snapshotRoot,
		workspaceId: "ws_123",
		agentRunId: "ar_123",
		activeMaestroSessionId: "session_123",
	};
}

describe("hosted runner drain", () => {
	it("drains the active runtime and writes a bounded snapshot manifest", async () => {
		const workspaceRoot = await createTempWorkspace();
		const context = hostedRunnerContext(workspaceRoot);
		const drainRuntime = vi.fn().mockResolvedValue({
			sessionId: "session_123",
			sessionFile: join(workspaceRoot, ".maestro", "sessions", "session.jsonl"),
			protocolVersion: "2026-04-02",
			cursor: 7,
		});

		const result = await drainHostedRunner(
			{
				reason: "ttl_expired",
				requestedBy: "platform",
				exportPaths: [".", "README.md"],
			},
			{
				hostedRunner: context,
				drainRuntime,
				now: () => new Date("2026-04-23T00:00:00.000Z"),
			},
		);

		expect(result?.status).toBe("drained");
		expect(context.draining).toBe(true);
		expect(drainRuntime).toHaveBeenCalledWith("session_123");
		expect(result?.manifest).toMatchObject({
			manifest_version: HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION,
			protocol_version: HOSTED_RUNNER_DRAIN_PROTOCOL_VERSION,
			status: "drained",
			runner_session_id: "mrs_123",
			owner_instance_id: "pod_123",
			workspace_id: "ws_123",
			agent_run_id: "ar_123",
			maestro_session_id: "session_123",
			workspace_root: workspaceRoot,
			stop_reason: "ttl_expired",
			requested_by: "platform",
			runtime: {
				flush_status: "completed",
				session_id: "session_123",
				protocol_version: "2026-04-02",
				cursor: 7,
			},
		});
		expect(result?.manifest.workspace_export.paths).toEqual([
			{
				input: ".",
				path: workspaceRoot,
				relative_path: ".",
				type: "directory",
			},
			{
				input: "README.md",
				path: join(workspaceRoot, "README.md"),
				relative_path: "README.md",
				type: "file",
			},
		]);

		const persisted = JSON.parse(
			await readFile(result!.manifest_path, "utf8"),
		) as unknown;
		expect(persisted).toEqual(result?.manifest);
	});

	it("records an interrupted manifest when runtime drain fails", async () => {
		const workspaceRoot = await createTempWorkspace();
		const context = hostedRunnerContext(workspaceRoot);
		const drainRuntime = vi
			.fn()
			.mockRejectedValue(new Error("flush timed out"));

		const result = await drainHostedRunner(
			{ reason: "preempted" },
			{
				hostedRunner: context,
				drainRuntime,
				now: () => new Date("2026-04-23T00:01:00.000Z"),
			},
		);

		expect(result?.status).toBe("interrupted");
		expect(context.draining).toBe(true);
		expect(result?.manifest.runtime).toMatchObject({
			flush_status: "failed",
			session_id: "session_123",
			error: "flush timed out",
		});
		const persisted = JSON.parse(
			await readFile(result!.manifest_path, "utf8"),
		) as { status: string };
		expect(persisted.status).toBe("interrupted");
	});

	it("rejects export paths outside the hosted workspace root", async () => {
		const workspaceRoot = await createTempWorkspace();
		const outsideRoot = await mkdtemp(
			join(tmpdir(), "maestro-outside-export-"),
		);
		tempDirs.push(outsideRoot);
		await mkdir(join(outsideRoot, "subdir"));
		const context = hostedRunnerContext(workspaceRoot);

		await expect(
			drainHostedRunner(
				{ exportPaths: [join(outsideRoot, "subdir")] },
				{
					hostedRunner: context,
					drainRuntime: vi.fn(),
					now: () => new Date("2026-04-23T00:02:00.000Z"),
				},
			),
		).rejects.toMatchObject({
			statusCode: 400,
			message: expect.stringContaining("escapes hosted runner workspace root"),
		});
	});

	it("leaves local/offline servers unchanged when hosted mode is unavailable", async () => {
		const drainRuntime = vi.fn();

		const result = await drainHostedRunner(
			{ reason: "local" },
			{
				drainRuntime,
				now: () => new Date("2026-04-23T00:03:00.000Z"),
			},
		);

		expect(result).toBeNull();
		expect(drainRuntime).not.toHaveBeenCalled();
	});
});

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkRpcProtocolConformance,
	loadRpcProtocolConformanceFixture,
} from "../../scripts/check-rpc-protocol-conformance";

describe("RPC protocol conformance", () => {
	let tempDir = "";

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("passes against the checked-in RPC protocol fixture", () => {
		expect(
			checkRpcProtocolConformance({
				fixture: loadRpcProtocolConformanceFixture(),
			}),
		).toEqual([]);
	});

	it("requires correlated response metadata for request-response commands", () => {
		const failures = checkRpcProtocolConformance({
			rootDir: ".",
			fixture: {
				version: 1,
				schema: "evalops.maestro.rpc-protocol-conformance.v1",
				commands: [
					{
						name: "broken state",
						type: "get_state",
						request: { type: "get_state" },
						response: { echoesRequestId: true },
					},
				],
				runtimeSurfaces: [],
			},
		});

		expect(failures).toContain("broken state requires a string request id");
		expect(failures).toContain(
			"broken state correlated responses must define response.type",
		);
		expect(failures).toContain("fixture is missing RPC command compact");
		expect(failures).toContain(
			"fixture is missing runtime surface rpc-client-launch",
		);
	});

	it("rejects missing source anchors", () => {
		tempDir = join(tmpdir(), `rpc-protocol-${process.pid}-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "rpc.txt"), "present\n", "utf8");

		const failures = checkRpcProtocolConformance({
			rootDir: tempDir,
			fixture: {
				version: 1,
				schema: "evalops.maestro.rpc-protocol-conformance.v1",
				commands: [
					{
						type: "prompt",
						request: { id: "req", type: "prompt" },
						response: { kind: "agent-event-stream" },
					},
				],
				runtimeSurfaces: [
					{
						area: "rpc-server-dispatch",
						path: "rpc.txt",
						anchors: ["missing"],
					},
				],
			},
		});

		expect(failures).toContain(
			'rpc-server-dispatch: rpc.txt is missing anchor "missing"',
		);
	});

	it("rejects fixture symlinks that resolve outside the repository root", () => {
		tempDir = join(
			tmpdir(),
			`rpc-protocol-symlink-${process.pid}-${Date.now()}`,
		);
		const repoDir = join(tempDir, "repo");
		mkdirSync(repoDir, { recursive: true });
		const outsidePath = join(tempDir, "outside.txt");
		writeFileSync(outsidePath, "present\n", "utf8");
		symlinkSync(outsidePath, join(repoDir, "surface-link.txt"));

		const failures = checkRpcProtocolConformance({
			rootDir: repoDir,
			fixture: {
				version: 1,
				schema: "evalops.maestro.rpc-protocol-conformance.v1",
				commands: [
					{
						type: "prompt",
						request: { id: "req", type: "prompt" },
						response: { kind: "agent-event-stream" },
					},
				],
				runtimeSurfaces: [
					{
						area: "rpc-server-dispatch",
						path: "surface-link.txt",
						anchors: ["present"],
					},
				],
			},
		});

		expect(failures).toContain(
			"rpc-server-dispatch: surface-link.txt escapes repository root",
		);
	});
});

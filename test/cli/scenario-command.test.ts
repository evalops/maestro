import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleScenarioCommand } from "../../src/cli/commands/scenario.js";

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
);
let server: Server | undefined;

async function serveFixture(value: unknown): Promise<string> {
	server = createServer((_, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(value));
	});
	await new Promise<void>((resolvePromise) => {
		server?.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}/scenario.json`;
}

describe("scenario command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		if (server) {
			server.close();
			server = undefined;
		}
	});

	it("validates scripted replay fixtures", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleScenarioCommand(
			"validate",
			[join(fixturesDir, "scripted-replay", "basic-tool-call.json"), "--json"],
			{ json: true },
		);

		expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
			status: "pass",
			schemaVersion: "evalops.maestro.scripted-scenario.v1",
			scenarioId: "basic-tool-call",
			frames: 2,
		});
	});

	it("validates scripted replay fixtures from HTTP URLs", async () => {
		const fixture = JSON.parse(
			readFileSync(
				join(fixturesDir, "scripted-replay", "basic-tool-call.json"),
				"utf8",
			),
		);
		fixture.assertions = fixture.assertions.filter(
			(assertion: { kind: string }) =>
				assertion.kind !== "file_exists" && assertion.kind !== "file_contents",
		);
		const url = await serveFixture(fixture);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleScenarioCommand("validate", [url, "--json"], { json: true });

		expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
			status: "pass",
			schemaVersion: "evalops.maestro.scripted-scenario.v1",
			scenarioId: "basic-tool-call",
			frames: 2,
		});
	});

	it("rejects remote scripted scenarios with relative file assertions", async () => {
		const fixture = JSON.parse(
			readFileSync(
				join(fixturesDir, "scripted-replay", "basic-tool-call.json"),
				"utf8",
			),
		);
		const url = await serveFixture(fixture);

		await expect(
			handleScenarioCommand("run", [url], { json: true }),
		).rejects.toThrow(
			`Remote scripted scenario ${url} assertion fixture-file-exists path must be absolute`,
		);
	});

	it("rejects remote trajectory scenarios with relative dependency paths", async () => {
		const fixture = JSON.parse(
			readFileSync(
				join(
					fixturesDir,
					"agent-trajectory-scenarios",
					"local-diagnostic-success.json",
				),
				"utf8",
			),
		);
		const url = await serveFixture(fixture);

		await expect(
			handleScenarioCommand("run", [url], { json: true }),
		).rejects.toThrow(
			`Remote scenario ${url} source.trajectoryPath must use an absolute path`,
		);
	});

	it("writes junit output from explicit options when flags are stripped", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "maestro-scenario-"));
		const junitPath = join(tempDir, "nested", "scenario.xml");
		vi.spyOn(console, "log").mockImplementation(() => undefined);

		try {
			await handleScenarioCommand(
				"run",
				[
					join(
						fixturesDir,
						"agent-trajectory-scenarios",
						"local-diagnostic-success.json",
					),
				],
				{ json: true, junitPath },
			);

			expect(readFileSync(junitPath, "utf8")).toContain("<testsuite");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("runs scripted replay assertions", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleScenarioCommand(
			"run",
			[join(fixturesDir, "scripted-replay", "basic-tool-call.json"), "--json"],
			{ json: true },
		);

		const result = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(result).toMatchObject({
			schemaVersion: "evalops.maestro.scripted-scenario-result.v1",
			scenario: {
				id: "basic-tool-call",
				observedOutcome: "pass",
			},
			run: {
				replay: true,
				toolCalls: 1,
			},
			counts: {
				assertions: 5,
				failed: 0,
			},
		});
		expect(
			result.assertions.map((assertion: { id: string }) => assertion.id),
		).toEqual([
			"read-tool-called",
			"write-tool-not-called",
			"fixture-file-exists",
			"fixture-file-contains-schema",
			"audit-event-tagged",
		]);
	});

	it("exits nonzero when observed outcome diverges from expected outcome", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "maestro-scenario-"));
		const sourcePath = join(
			fixturesDir,
			"agent-trajectory-scenarios",
			"local-diagnostic-success.json",
		);
		const scenario = JSON.parse(readFileSync(sourcePath, "utf8"));
		scenario.expectedOutcome = "fail";
		for (const key of Object.keys(scenario.source)) {
			scenario.source[key] = join(
				fixturesDir,
				"agent-trajectory-scenarios",
				scenario.source[key],
			);
		}
		const scenarioPath = join(tempDir, "expected-fail-but-passes.json");
		writeFileSync(scenarioPath, JSON.stringify(scenario));
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
			code?: string | number | null,
		) => {
			throw new Error(`process.exit(${code})`);
		}) as never);

		try {
			await expect(
				handleScenarioCommand("run", [scenarioPath], { json: true }),
			).rejects.toThrow("process.exit(1)");
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

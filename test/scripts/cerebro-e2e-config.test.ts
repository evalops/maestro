import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function printEnv(overrides: NodeJS.ProcessEnv): string {
	const env = { ...process.env, ...overrides };
	for (const name of [
		"LOCAL_HTTP_PORT",
		"LOCAL_ADDR",
		"LOCAL_BASE_URL",
		"LOCAL_MAESTRO_GENERATE_REPLAY",
		"LOCAL_MAESTRO_DOCTOR_REPLAY",
	]) {
		delete env[name];
	}
	return execFileSync(
		process.execPath,
		["scripts/check-cerebro-e2e.mjs", "--print-env"],
		{
			cwd: root,
			encoding: "utf8",
			env,
		},
	);
}

function printMaestroEnv(overrides: NodeJS.ProcessEnv): string {
	return execFileSync(
		process.execPath,
		["scripts/check-cerebro-e2e.mjs", "--print-maestro-env"],
		{
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, ...overrides },
		},
	);
}

function printEnvWithoutDeletingLocal(overrides: NodeJS.ProcessEnv): string {
	return execFileSync(
		process.execPath,
		["scripts/check-cerebro-e2e.mjs", "--print-env"],
		{
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, ...overrides },
		},
	);
}

describe("Cerebro local E2E config", () => {
	it("prints the normalized local endpoint env consumed by the nested Cerebro make target", () => {
		const output = printEnv({
			MAESTRO_CEREBRO_URL: "http://127.0.0.1:19999/cerebro.v1.CerebroService",
			MAESTRO_CEREBRO_WORKSPACE_ID: "workspace_under_test",
		});

		expect(output).toContain("LOCAL_BASE_URL='http://127.0.0.1:19999'");
		expect(output).toContain("LOCAL_HTTP_PORT='19999'");
		expect(output).toContain("LOCAL_ADDR=':19999'");
		expect(output).toContain("MAESTRO_CEREBRO_URL='http://127.0.0.1:19999'");
		expect(output).toContain(
			"MAESTRO_PLATFORM_MCP_URL='http://127.0.0.1:19999/mcp'",
		);
		expect(output).toContain(
			"MAESTRO_AGENT_MCP_URL='http://127.0.0.1:19999/mcp'",
		);
		expect(output).toContain("MAESTRO_CEREBRO_MCP_SCOPES='cerebro:read'");
		expect(output).toContain("MAESTRO_PLATFORM_MCP_SCOPES='cerebro:read'");
		expect(output).toContain("MAESTRO_AGENT_MCP_SCOPES='cerebro:read'");
		expect(output).toContain("MAESTRO_WORKSPACE_ID='workspace_under_test'");
	});

	it("ignores empty exported LOCAL_* vars when printing nested make env", () => {
		const output = printEnvWithoutDeletingLocal({
			MAESTRO_CEREBRO_URL: "http://127.0.0.1:19997/cerebro.v1.CerebroService",
			LOCAL_HTTP_PORT: "",
			LOCAL_ADDR: "",
			LOCAL_BASE_URL: "",
			LOCAL_MAESTRO_GENERATE_REPLAY: "",
			LOCAL_MAESTRO_DOCTOR_REPLAY: "",
		});

		expect(output).toContain("LOCAL_BASE_URL='http://127.0.0.1:19997'");
		expect(output).toContain("LOCAL_HTTP_PORT='19997'");
		expect(output).toContain("LOCAL_ADDR=':19997'");
		expect(output).toContain("LOCAL_MAESTRO_GENERATE_REPLAY='true'");
		expect(output).toContain("LOCAL_MAESTRO_DOCTOR_REPLAY='auto'");
	});

	it("honors documented agent MCP aliases when generating nested make env", () => {
		const output = printEnv({
			MAESTRO_CEREBRO_URL: "http://127.0.0.1:18888",
			MAESTRO_AGENT_MCP_URL: "http://127.0.0.1:18888/mcp/",
			MAESTRO_AGENT_MCP_SCOPES: "cerebro:read,cerebro:assert",
		});

		expect(output).toContain(
			"MAESTRO_PLATFORM_MCP_URL='http://127.0.0.1:18888/mcp'",
		);
		expect(output).toContain(
			"MAESTRO_AGENT_MCP_URL='http://127.0.0.1:18888/mcp'",
		);
		expect(output).toContain(
			"MAESTRO_PLATFORM_MCP_SCOPES='cerebro:read,cerebro:assert'",
		);
		expect(output).toContain(
			"MAESTRO_AGENT_MCP_SCOPES='cerebro:read,cerebro:assert'",
		);
	});

	it("matches Cerebro workspace priority when aliases disagree", () => {
		const output = printEnv({
			MAESTRO_CEREBRO_WORKSPACE_ID: "cerebro_specific",
			CEREBRO_WORKSPACE_ID: "cerebro_generic",
			MAESTRO_WORKSPACE_ID: "maestro_generic",
		});

		expect(output).toContain("MAESTRO_CEREBRO_WORKSPACE_ID='cerebro_specific'");
		expect(output).toContain("MAESTRO_WORKSPACE_ID='cerebro_specific'");

		const fallbackOutput = printEnv({
			CEREBRO_WORKSPACE_ID: "cerebro_generic",
			MAESTRO_WORKSPACE_ID: "maestro_generic",
		});

		expect(fallbackOutput).toContain(
			"MAESTRO_CEREBRO_WORKSPACE_ID='cerebro_generic'",
		);
		expect(fallbackOutput).toContain("MAESTRO_WORKSPACE_ID='cerebro_generic'");
	});

	it("prints copyable Maestro env for the persistent local dev stack", () => {
		const output = printMaestroEnv({
			MAESTRO_CEREBRO_URL: "http://127.0.0.1:19998/cerebro.v1.CerebroService",
			MAESTRO_CEREBRO_WORKSPACE_ID: "workspace_under_test",
		});

		expect(output).toContain(
			"export MAESTRO_CEREBRO_URL='http://127.0.0.1:19998'",
		);
		expect(output).toContain("export CEREBRO_URL='http://127.0.0.1:19998'");
		expect(output).toContain(
			"export MAESTRO_PLATFORM_MCP_URL='http://127.0.0.1:19998/mcp'",
		);
		expect(output).toContain(
			"export MAESTRO_AGENT_MCP_URL='http://127.0.0.1:19998/mcp'",
		);
		expect(output).toContain(
			"export MAESTRO_WORKSPACE_ID='workspace_under_test'",
		);
		expect(output).toContain(
			"export MAESTRO_CEREBRO_MCP_SCOPES='cerebro:read'",
		);
		expect(output).toContain("export MAESTRO_AGENT_MCP_SCOPES='cerebro:read'");
		expect(output).toContain("export MAESTRO_EVALOPS_MEMORY_MODE='cerebro'");
	});

	it("does not depend on pinned .env.example defaults for the public developer surface check", () => {
		const surfaceCheck = readFileSync(
			resolve(root, "scripts/check-developer-surface.mjs"),
			"utf8",
		);

		expect(surfaceCheck).not.toContain(
			"MAESTRO_CEREBRO_URL=http://localhost:18080",
		);
		expect(surfaceCheck).not.toContain(
			"MAESTRO_PLATFORM_MCP_URL=http://localhost:18080/mcp",
		);
		expect(surfaceCheck).not.toContain(
			"MAESTRO_CEREBRO_MCP_SCOPES=cerebro:read",
		);
	});

	it("threads printed Cerebro env through make cerebro-e2e", () => {
		const makefile = readFileSync(resolve(root, "Makefile"), "utf8");

		expect(makefile).toContain("scripts/check-cerebro-e2e.mjs --print-env");
		expect(makefile).toContain('env_exports="$$(LOCAL_CEREBRO_REPO=');
		expect(makefile).toContain('eval "$$env_exports" &&');
		expect(makefile).toContain(
			"scripts/check-cerebro-e2e.mjs --print-maestro-env",
		);
		expect(makefile).toContain("local-maestro-dev");
		expect(makefile).toContain('LOCAL_BASE_URL="$$LOCAL_BASE_URL"');
		expect(makefile).toContain('MAESTRO_CEREBRO_URL="$$MAESTRO_CEREBRO_URL"');
		expect(makefile).toContain(
			'MAESTRO_PLATFORM_MCP_URL="$$MAESTRO_PLATFORM_MCP_URL"',
		);
		expect(makefile).toContain(
			'MAESTRO_AGENT_MCP_URL="$$MAESTRO_AGENT_MCP_URL"',
		);
		expect(makefile).toContain(
			'MAESTRO_PLATFORM_MCP_SCOPES="$$MAESTRO_PLATFORM_MCP_SCOPES"',
		);
		expect(makefile).toContain(
			'MAESTRO_AGENT_MCP_SCOPES="$$MAESTRO_AGENT_MCP_SCOPES"',
		);
		expect(makefile).toContain("MAESTRO_AGENT_MCP_TOKEN");
	});
});

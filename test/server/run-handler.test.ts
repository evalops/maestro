import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/server-utils.js", () => ({
	readJsonBody: vi.fn(),
	respondWithApiError: vi.fn(),
	sendJson: vi.fn(),
}));

import { handleRun } from "../../src/server/handlers/run.js";
import { readJsonBody, sendJson } from "../../src/server/server-utils.js";

describe.sequential("handleRun", () => {
	let originalCwd: string;
	let originalAllowlist: string | undefined;
	let originalRunner: string | undefined;
	let originalPath: string | undefined;
	let tempDir: string | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		originalCwd = process.cwd();
		originalAllowlist = process.env.MAESTRO_RUN_SCRIPT_ALLOWLIST;
		originalRunner = process.env.MAESTRO_SCRIPT_RUNNER;
		originalPath = process.env.PATH;
		tempDir = mkdtempSync(join(tmpdir(), "maestro-run-handler-"));
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		restoreEnv("MAESTRO_RUN_SCRIPT_ALLOWLIST", originalAllowlist);
		restoreEnv("MAESTRO_SCRIPT_RUNNER", originalRunner);
		restoreEnv("PATH", originalPath);
		if (tempDir) {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("lists only allowlisted package scripts", async () => {
		process.env.MAESTRO_RUN_SCRIPT_ALLOWLIST = "db:migrate, smoke";
		writePackageJson({
			"db:migrate": "echo migrate",
			dev: "echo dev",
			smoke: "echo smoke",
		});

		await handleRun(
			request("GET", "/api/run?action=scripts"),
			{} as ServerResponse,
			{},
		);

		expect(sendJson).toHaveBeenCalledWith(
			expect.anything(),
			200,
			{ scripts: ["db:migrate", "smoke"] },
			{},
		);
	});

	it("rejects lifecycle companion scripts outside the allowlist", async () => {
		process.env.MAESTRO_RUN_SCRIPT_ALLOWLIST = "db:migrate";
		writePackageJson({
			"db:migrate": "echo migrate",
			"postdb:migrate": "echo post",
			"predb:migrate": "echo pre",
		});
		vi.mocked(readJsonBody).mockResolvedValue({ script: "predb:migrate" });

		await handleRun(request("POST", "/api/run"), {} as ServerResponse, {});

		expect(sendJson).toHaveBeenCalledWith(
			expect.anything(),
			403,
			{
				error: 'Script "predb:migrate" is not allowed in this environment',
				allowed: ["db:migrate"],
			},
			{},
		);
	});

	it("runs allowed scripts with npm lifecycle suppression", async () => {
		process.env.MAESTRO_RUN_SCRIPT_ALLOWLIST = "db:migrate";
		writePackageJson({
			"db:migrate": "echo migrate",
			"postdb:migrate": "echo post",
			"predb:migrate": "echo pre",
		});
		const runner = join(process.cwd(), "npm");
		const argvFile = join(process.cwd(), "argv.txt");
		writeFileSync(
			runner,
			[
				"#!/bin/sh",
				`printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}`,
				"printf 'ok stdout\\n'",
				"printf 'ok stderr\\n' >&2",
			].join("\n"),
		);
		chmodSync(runner, 0o755);
		process.env.MAESTRO_SCRIPT_RUNNER = runner;
		vi.mocked(readJsonBody).mockResolvedValue({ script: "db:migrate" });

		await handleRun(request("POST", "/api/run"), {} as ServerResponse, {});

		expect(readFileSync(argvFile, "utf-8")).toBe(
			"--ignore-scripts\nrun\ndb:migrate\n",
		);
		expect(sendJson).toHaveBeenCalledWith(
			expect.anything(),
			200,
			expect.objectContaining({
				success: true,
				exitCode: 0,
				stdout: "ok stdout",
				stderr: "ok stderr",
				command: `${runner} run db:migrate`,
			}),
			{},
		);
	});

	it("rejects configured pnpm instead of falling back to npm", async () => {
		process.env.MAESTRO_RUN_SCRIPT_ALLOWLIST = "db:migrate";
		writePackageJson({
			"db:migrate": "echo migrate",
		});
		const configuredPnpm = join(process.cwd(), "pnpm");
		const npmRunner = join(process.cwd(), "npm");
		const argvFile = join(process.cwd(), "argv.txt");
		writeFileSync(
			configuredPnpm,
			[
				"#!/bin/sh",
				`printf 'configured pnpm should not run\\n' > ${JSON.stringify(argvFile)}`,
				"exit 42",
			].join("\n"),
		);
		writeFileSync(
			npmRunner,
			[
				"#!/bin/sh",
				`printf 'npm\\n' > ${JSON.stringify(argvFile)}`,
				`printf '%s\\n' "$@" >> ${JSON.stringify(argvFile)}`,
				"printf 'ok stdout\\n'",
			].join("\n"),
		);
		chmodSync(configuredPnpm, 0o755);
		chmodSync(npmRunner, 0o755);
		process.env.MAESTRO_SCRIPT_RUNNER = configuredPnpm;
		process.env.PATH = `${process.cwd()}:${originalPath ?? ""}`;
		vi.mocked(readJsonBody).mockResolvedValue({ script: "db:migrate" });

		await handleRun(request("POST", "/api/run"), {} as ServerResponse, {});

		expect(existsSync(argvFile)).toBe(false);
		expect(sendJson).toHaveBeenCalledWith(
			expect.anything(),
			503,
			{
				error:
					"No JavaScript package runner with lifecycle suppression is available for /api/run. Install npm or set MAESTRO_SCRIPT_RUNNER to an npm-compatible runner.",
			},
			{},
		);
	});

	it("does not invoke a runner for rejected scripts", async () => {
		process.env.MAESTRO_RUN_SCRIPT_ALLOWLIST = "db:migrate";
		writePackageJson({
			"db:migrate": "echo migrate",
			"postdb:migrate": "echo post",
		});
		const runner = join(process.cwd(), "npm");
		const argvFile = join(process.cwd(), "argv.txt");
		writeFileSync(
			runner,
			["#!/bin/sh", `printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}`].join(
				"\n",
			),
		);
		chmodSync(runner, 0o755);
		process.env.MAESTRO_SCRIPT_RUNNER = runner;
		vi.mocked(readJsonBody).mockResolvedValue({ script: "postdb:migrate" });

		await handleRun(request("POST", "/api/run"), {} as ServerResponse, {});

		expect(existsSync(argvFile)).toBe(false);
		expect(sendJson).toHaveBeenCalledWith(
			expect.anything(),
			403,
			expect.objectContaining({ allowed: ["db:migrate"] }),
			{},
		);
	});
});

function request(method: string, url: string): IncomingMessage {
	return {
		headers: { host: "localhost" },
		method,
		url,
	} as IncomingMessage;
}

function restoreEnv(key: string, value: string | undefined) {
	if (value === undefined) {
		Reflect.deleteProperty(process.env, key);
	} else {
		process.env[key] = value;
	}
}

function writePackageJson(scripts: Record<string, string>) {
	writeFileSync("package.json", JSON.stringify({ scripts }));
}

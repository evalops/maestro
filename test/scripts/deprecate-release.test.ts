import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = new URL(
	"../../scripts/deprecate-release.js",
	import.meta.url,
);

function runDeprecate(
	env: Record<string, string>,
	extraArgs: string[] = [],
	options: { input?: string } = {},
) {
	return spawnSync(
		process.execPath,
		[
			scriptPath.pathname,
			"--range",
			">=0.10.8 <=0.10.20",
			"--package",
			"@evalops/maestro",
			"--message",
			"Broken release metadata references private workspace packages; install @evalops/maestro@latest.",
			...extraArgs,
		],
		{
			encoding: "utf8",
			input: options.input,
			env: {
				...process.env,
				...env,
			},
		},
	);
}

describe("deprecate-release", () => {
	it("prints the configured npm command during dry runs", () => {
		const result = runDeprecate({ MAESTRO_NPM_COMMAND: "/tmp/fake-npm" }, [
			"--dry-run",
		]);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"[dry-run] /tmp/fake-npm deprecate @evalops/maestro@>=0.10.8 <=0.10.20",
		);
		expect(result.stdout).toContain(
			"Broken release metadata references private workspace packages; install @evalops/maestro@latest.",
		);
	});

	it("derives package-aware default messages when no message is supplied", () => {
		const canonicalResult = spawnSync(
			process.execPath,
			[
				scriptPath.pathname,
				"--range",
				"0.10.20",
				"--package",
				"@evalops/maestro",
				"--dry-run",
			],
			{ encoding: "utf8" },
		);
		const aliasResult = spawnSync(
			process.execPath,
			[
				scriptPath.pathname,
				"--range",
				"0.10.20",
				"--package",
				"@evalops/contracts",
				"--dry-run",
			],
			{ encoding: "utf8" },
		);

		expect(canonicalResult.status).toBe(0);
		expect(canonicalResult.stdout).toContain(
			"Deprecated release. Upgrade to a supported Maestro version.",
		);
		expect(aliasResult.status).toBe(0);
		expect(aliasResult.stdout).toContain(
			"Deprecated package path. Install @evalops/maestro instead.",
		);
	});

	it("explains npm E404 permission failures for existing package releases", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "maestro-deprecate-test-"));
		const fakeNpm = join(tempDir, "npm");
		writeFileSync(
			fakeNpm,
			[
				"#!/usr/bin/env bash",
				"echo 'npm error code E404' >&2",
				"echo \"npm error 404  The requested resource '@evalops/maestro@>=0.10.8 <=0.10.20' could not be found or you do not have permission to access it.\" >&2",
				"exit 1",
				"",
			].join("\n"),
		);
		chmodSync(fakeNpm, 0o755);

		try {
			const result = runDeprecate({ MAESTRO_NPM_COMMAND: fakeNpm });

			expect(result.status).toBe(1);
			expect(result.stderr).toContain(
				"npm could not deprecate @evalops/maestro@>=0.10.8 <=0.10.20.",
			);
			expect(result.stderr).toContain(
				"configured npm token does not have publish/deprecate permission",
			);
			expect(result.stderr).toContain("npm-release NPM_TOKEN");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("explains npm auth failures from stale release tokens", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "maestro-deprecate-auth-test-"));
		const fakeNpm = join(tempDir, "npm");
		writeFileSync(
			fakeNpm,
			[
				"#!/usr/bin/env bash",
				"echo 'npm error code E401' >&2",
				"echo 'npm error 401 Unauthorized - PUT https://registry.npmjs.org/@evalops%2fmaestro' >&2",
				"exit 1",
				"",
			].join("\n"),
		);
		chmodSync(fakeNpm, 0o755);

		try {
			const result = runDeprecate({ MAESTRO_NPM_COMMAND: fakeNpm });

			expect(result.status).toBe(1);
			expect(result.stderr).toContain(
				"npm could not authenticate while deprecating @evalops/maestro@>=0.10.8 <=0.10.20.",
			);
			expect(result.stderr).toContain("Refresh the npm-release NPM_TOKEN");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("forwards stdin to npm so local OTP prompts can be answered", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "maestro-deprecate-otp-test-"));
		const fakeNpm = join(tempDir, "npm");
		writeFileSync(
			fakeNpm,
			[
				"#!/usr/bin/env bash",
				"read -r otp",
				'if [[ "$otp" != "123456" ]]; then',
				'  echo "missing otp stdin" >&2',
				"  exit 2",
				"fi",
				'echo "accepted otp from stdin"',
				"",
			].join("\n"),
		);
		chmodSync(fakeNpm, 0o755);

		try {
			const result = runDeprecate({ MAESTRO_NPM_COMMAND: fakeNpm }, [], {
				input: "123456\n",
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("accepted otp from stdin");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

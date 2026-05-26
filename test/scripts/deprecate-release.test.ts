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
			"0.10.20",
			"--package",
			"@evalops/maestro",
			"--message",
			"Broken release: install @evalops/maestro@0.10.21 or newer.",
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
			"[dry-run] /tmp/fake-npm deprecate @evalops/maestro@0.10.20",
		);
		expect(result.stdout).toContain(
			"Broken release: install @evalops/maestro@0.10.21 or newer.",
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
				"echo \"npm error 404  The requested resource '@evalops/maestro@0.10.20' could not be found or you do not have permission to access it.\" >&2",
				"exit 1",
				"",
			].join("\n"),
		);
		chmodSync(fakeNpm, 0o755);

		try {
			const result = runDeprecate({ MAESTRO_NPM_COMMAND: fakeNpm });

			expect(result.status).toBe(1);
			expect(result.stderr).toContain(
				"npm could not deprecate @evalops/maestro@0.10.20.",
			);
			expect(result.stderr).toContain(
				"configured npm token does not have publish/deprecate permission",
			);
			expect(result.stderr).toContain("npm-release NPM_TOKEN");
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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectRegistryInstallSmokeIsReleaseBlocking } from "./registry-install-smoke-guard.js";

describe("expectRegistryInstallSmokeIsReleaseBlocking", () => {
	it("rejects continue-on-error on the smoke step", () => {
		expect(() =>
			expectRegistryInstallSmokeIsReleaseBlocking(
				{
					"continue-on-error": true,
					run: "node scripts/smoke-registry-install.js",
				},
				[],
			),
		).toThrow(/continue-on-error/u);
	});

	it("rejects continue-on-error on the smoke job", () => {
		const smokeStep = {
			run: "node scripts/smoke-registry-install.js",
		};

		expect(() =>
			expectRegistryInstallSmokeIsReleaseBlocking(smokeStep, [], {
				containingJob: { "continue-on-error": true },
			}),
		).toThrow(/continue-on-error/u);
	});

	it("rejects skip variables written through GITHUB_ENV before the smoke step", () => {
		const smokeStep = {
			run: "node scripts/smoke-registry-install.js",
		};

		expect(() =>
			expectRegistryInstallSmokeIsReleaseBlocking(smokeStep, [], {
				precedingSteps: [
					{
						run: 'echo "MAESTRO_SKIP_BUN_INSTALL_SMOKE=1" >> "$GITHUB_ENV"',
					},
				],
			}),
		).toThrow(/GITHUB_ENV/u);
	});

	it("rejects heredoc-style skip variables written through GITHUB_ENV", () => {
		const smokeStep = {
			run: "node scripts/smoke-registry-install.js",
		};

		expect(() =>
			expectRegistryInstallSmokeIsReleaseBlocking(smokeStep, [], {
				precedingSteps: [
					{
						run: `cat <<'EOF' >> "$GITHUB_ENV"
MAESTRO_ALLOW_REGISTRY_BUN_INSTALL_SMOKE_SKIP<<SKIP
1
SKIP
EOF`,
					},
				],
			}),
		).toThrow(/GITHUB_ENV/u);
	});

	it("rejects multiline GITHUB_ENV skip writes", () => {
		const smokeStep = {
			run: "node scripts/smoke-registry-install.js",
		};

		expect(() =>
			expectRegistryInstallSmokeIsReleaseBlocking(smokeStep, [], {
				precedingSteps: [
					{
						run: `cat <<'EOF' >> "$GITHUB_ENV"
MAESTRO_SKIP_BUN_INSTALL_SMOKE<<VALUE
1
VALUE
EOF`,
					},
				],
			}),
		).toThrow(/GITHUB_ENV/u);
	});

	it("rejects constructed GITHUB_ENV skip writes", () => {
		const smokeStep = {
			run: "node scripts/smoke-registry-install.js",
		};

		expect(() =>
			expectRegistryInstallSmokeIsReleaseBlocking(smokeStep, [], {
				precedingSteps: [
					{
						run: `printf '%s=%s\\n' MAESTRO_SKIP_BUN_INSTALL_SMOKE 1 >> "$GITHUB_ENV"`,
					},
				],
			}),
		).toThrow(/GITHUB_ENV/u);
	});

	it("rejects skip variables written by preceding local composite actions", () => {
		const root = mkdtempSync(join(tmpdir(), "registry-smoke-guard-"));
		try {
			const actionDir = join(root, ".github/actions/setup-bun-nx");
			mkdirSync(actionDir, { recursive: true });
			writeFileSync(
				join(actionDir, "action.yml"),
				`name: setup-bun-nx
runs:
  using: composite
  steps:
    - shell: bash
      run: |
        printf '%s=%s\\n' MAESTRO_SKIP_BUN_INSTALL_SMOKE 1 >> "$GITHUB_ENV"
`,
			);
			const smokeStep = {
				run: "node scripts/smoke-registry-install.js",
			};

			expect(() =>
				expectRegistryInstallSmokeIsReleaseBlocking(smokeStep, [], {
					localActionRoot: root,
					precedingSteps: [{ uses: "./.github/actions/setup-bun-nx" }],
				}),
			).toThrow(/GITHUB_ENV/u);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});
});

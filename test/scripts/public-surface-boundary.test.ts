import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
const scriptPath = join(
	process.cwd(),
	"scripts/check-public-surface-boundary.mjs",
);

function makeFixture() {
	const root = join(
		tmpdir(),
		`maestro-public-surface-${process.pid}-${Date.now()}-${fixtures.length}`,
	);
	fixtures.push(root);
	mkdirSync(root, { recursive: true });
	write(join(root, "package.json"), JSON.stringify({ scripts: {} }, null, 2));
	write(join(root, "src/cli/args.ts"), "const COMMANDS = new Set([]);\n");
	write(
		join(root, ".github/public-release-mirror.exclude"),
		[
			"docs/internal/**",
			"evals/internal/**",
			"scripts/internal/**",
			"test/internal/**",
		].join("\n"),
	);
	return root;
}

function write(path: string, content: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function runCheck(root: string) {
	return spawnSync(process.execPath, [scriptPath], {
		cwd: root,
		encoding: "utf8",
	});
}

describe("check-public-surface-boundary", () => {
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("accepts internal-only scenario utilities outside the public surface", () => {
		const root = makeFixture();
		write(
			join(root, "scripts/internal/complex-task-scenarios.ts"),
			"export const internal = true;\n",
		);
		write(join(root, "evals/internal/complex-task-gauntlet.json"), "{}\n");

		const result = runCheck(root);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Public surface boundary check passed.");
	});

	it("accepts public mirror checkouts without the internal mirror exclude file", () => {
		const root = makeFixture();
		rmSync(join(root, ".github/public-release-mirror.exclude"), {
			force: true,
		});

		const result = runCheck(root);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Public surface boundary check passed.");
	});

	it("rejects package scripts and CLI commands for internal scenarios", () => {
		const root = makeFixture();
		write(
			join(root, "package.json"),
			JSON.stringify(
				{
					scripts: {
						"scenario:smoke":
							"tsx scripts/internal/complex-task-scenarios.ts run",
					},
				},
				null,
				2,
			),
		);
		write(
			join(root, "src/cli/args.ts"),
			'const COMMANDS = new Set(["scenario"]);\n',
		);

		const result = runCheck(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"package.json exposes internal scenario script: scenario:smoke",
		);
		expect(result.stderr).toContain(
			"src/cli/args.ts exposes internal scenario as a CLI command",
		);
	});

	it("rejects legacy public locations for the internal scenario runner", () => {
		const root = makeFixture();
		write(
			join(root, "docs/protocols/complex-task-scenarios.md"),
			"# internal\n",
		);
		write(join(root, "src/cli/commands/scenario.ts"), "export {};\n");

		const result = runCheck(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"docs/protocols/complex-task-scenarios.md must not exist",
		);
		expect(result.stderr).toContain(
			"src/cli/commands/scenario.ts must not exist",
		);
	});
});

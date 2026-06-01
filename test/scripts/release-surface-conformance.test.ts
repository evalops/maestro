import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkReleaseSurfaceConformance,
	loadReleaseSurfaceConformanceManifest,
} from "../../scripts/check-release-surface-conformance.mjs";

const publicPackageName = ["@evalops", "maestro"].join("/");
const publicPackageLatest = `${publicPackageName}@latest`;

describe("release-surface conformance", () => {
	let tempDir = "";

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("passes against the checked-in release surface manifest", () => {
		expect(
			checkReleaseSurfaceConformance({
				manifest: loadReleaseSurfaceConformanceManifest(),
			}),
		).toEqual([]);
	});

	it("requires every release surface area", () => {
		tempDir = join(tmpdir(), `release-surface-${process.pid}-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "surface.txt"), "present\n", "utf8");

		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "public-install-docs",
						path: "surface.txt",
						evidenceType: "doc",
						anchors: ["present", "missing"],
					},
				],
			},
		});

		expect(failures).toContain(
			'public-install-docs: surface.txt is missing anchor "missing"',
		);
		expect(failures).toContain(
			"manifest is missing required area package-metadata",
		);
		expect(failures).toContain(
			"manifest is missing required area registry-install-smoke",
		);
		expect(failures).toContain(
			"manifest is missing required area public-mirror-workflow",
		);
		expect(failures).toContain(
			"manifest is missing required area tag-release-workflow",
		);
	});

	it("rejects entries without evidence types or anchors", () => {
		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir || ".",
			manifest: {
				version: 1,
				checks: [
					{
						area: "public-install-docs",
						path: "missing.txt",
						anchors: [],
					},
				],
			},
		});

		expect(failures).toContain(
			"public-install-docs: missing.txt is missing evidenceType",
		);
		expect(failures).toContain(
			"public-install-docs: missing.txt must list at least one anchor",
		);
	});

	it("rejects manifest paths that escape the repository root", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-escape-${process.pid}-${Date.now()}`,
		);
		const repoDir = join(tempDir, "repo");
		mkdirSync(repoDir, { recursive: true });
		writeFileSync(join(tempDir, "outside.txt"), "present\n", "utf8");

		const failures = checkReleaseSurfaceConformance({
			rootDir: repoDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "public-install-docs",
						path: "../outside.txt",
						evidenceType: "doc",
						anchors: ["present"],
					},
				],
			},
		});

		expect(failures).toContain(
			"public-install-docs: ../outside.txt escapes repository root",
		);
	});

	it("rejects manifest symlinks that resolve outside the repository root", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-symlink-${process.pid}-${Date.now()}`,
		);
		const repoDir = join(tempDir, "repo");
		mkdirSync(repoDir, { recursive: true });
		const outsidePath = join(tempDir, "outside.txt");
		writeFileSync(outsidePath, "present\n", "utf8");
		symlinkSync(outsidePath, join(repoDir, "surface-link.txt"));

		const failures = checkReleaseSurfaceConformance({
			rootDir: repoDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "public-install-docs",
						path: "surface-link.txt",
						evidenceType: "doc",
						anchors: ["present"],
					},
				],
			},
		});

		expect(failures).toContain(
			"public-install-docs: surface-link.txt escapes repository root",
		);
	});

	it("requires release-gate script evidence to validate package scripts", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-script-shape-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "surface.txt"),
			'"release:check": "node scripts/release-readiness.js release"\n"check:release-surface": "node scripts/check-release-surface-conformance.mjs"\n',
			"utf8",
		);

		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate-scripts",
						path: "surface.txt",
						evidenceType: "source",
						anchors: [
							'"release:check": "node scripts/release-readiness.js release"',
							'"check:release-surface": "node scripts/check-release-surface-conformance.mjs"',
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate-scripts: surface.txt must use package.json as release-gate script evidence",
		);
		expect(failures).toContain(
			"release-gate-scripts: surface.txt must use package-script evidence for release-gate validation",
		);
	});

	it("requires public install docs to explain deprecated private workspace dependency failures", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-public-install-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "README.md"),
			[
				`bun install -g ${publicPackageName}`,
				`npm install -g ${publicPackageName}`,
				publicPackageLatest,
				"@evalops/tui",
				"@evalops/contracts",
				"deprecated 0.10.8-0.10.20 package",
				"published release verification now runs npm and Bun",
			].join("\n"),
			"utf8",
		);

		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "public-install-docs",
						path: "README.md",
						evidenceType: "doc",
						anchors: [
							`bun install -g ${publicPackageName}`,
							`npm install -g ${publicPackageName}`,
							publicPackageLatest,
							"@evalops/tui",
							"@evalops/contracts",
							"deprecated 0.10.8-0.10.20 package",
							"published release verification now runs npm and Bun",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"public-install-docs: README.md must anchor referenced private workspace dependencies",
		);
	});

	it("requires lint:evals to invoke the release surface conformance gate", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-script-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				scripts: {
					"release:check": "node scripts/release-readiness.js release",
					"check:release-surface":
						"node scripts/check-release-surface-conformance.mjs",
					"lint:evals":
						"node scripts/verify-evals.js && echo check:release-surface",
				},
			}),
			"utf8",
		);

		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate-scripts",
						path: "package.json",
						evidenceType: "package-script",
						anchors: [
							"release:check",
							"scripts/release-readiness.js",
							"check:release-surface",
							"scripts/check-release-surface-conformance.mjs",
							"lint:evals",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate-scripts: package.json scripts.lint:evals must run check:release-surface",
		);
	});

	it("requires registry install smokes to anchor Bun runtime execution", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-registry-smoke-${process.pid}-${Date.now()}`,
		);
		mkdirSync(join(tempDir, "scripts"), { recursive: true });
		writeFileSync(
			join(tempDir, "scripts/smoke-registry-install.js"),
			[
				'["install", packageSpec]',
				'["add", packageSpec]',
				"runPublishedReplayE2E",
				"runNpxCliSmoke",
				"runBunxCliSmoke",
				"runBunRuntimeCliSmoke",
			].join("\n"),
			"utf8",
		);

		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "registry-install-smoke",
						path: "scripts/smoke-registry-install.js",
						evidenceType: "live-smoke",
						anchors: [
							'["install", packageSpec]',
							'["add", packageSpec]',
							"runPublishedReplayE2E",
							"runNpxCliSmoke",
							"runBunxCliSmoke",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"registry-install-smoke: scripts/smoke-registry-install.js must anchor runBunRuntimeCliSmoke",
		);
	});

	it("requires registry install smokes to keep Bun install checks release-blocking", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-registry-bun-required-${process.pid}-${Date.now()}`,
		);
		mkdirSync(join(tempDir, "scripts"), { recursive: true });
		writeFileSync(
			join(tempDir, "scripts/smoke-registry-install.js"),
			[
				'["install", packageSpec]',
				'["add", packageSpec]',
				"runPublishedReplayE2E",
				"runNpxCliSmoke",
				"runBunxCliSmoke",
				"runBunRuntimeCliSmoke",
				"MAESTRO_SKIP_BUN_INSTALL_SMOKE",
			].join("\n"),
			"utf8",
		);

		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "registry-install-smoke",
						path: "scripts/smoke-registry-install.js",
						evidenceType: "live-smoke",
						anchors: [
							'["install", packageSpec]',
							'["add", packageSpec]',
							"runPublishedReplayE2E",
							"runNpxCliSmoke",
							"runBunxCliSmoke",
							"runBunRuntimeCliSmoke",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"registry-install-smoke: scripts/smoke-registry-install.js must anchor MAESTRO_ALLOW_REGISTRY_BUN_INSTALL_SMOKE_SKIP",
		);
	});

	it("requires published replay verifier coverage anchors", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-replay-verifier-${process.pid}-${Date.now()}`,
		);
		mkdirSync(join(tempDir, "scripts"), { recursive: true });
		const anchors = [
			'const REQUIRED_INSTALLERS = ["npm", "bun"];',
			'const REQUIRED_REPLAY_MODES = ["json", "rpc", "text"];',
			'"toolExecutionEvidence"',
			'"searchRipgrepEvidence"',
			'"queryableObservabilityIndex"',
			'"agentRuntimeLedger"',
			'"agentRuntimeLifecycle"',
			'"agent-runtime-lifecycle"',
			"function toolExecutionCoverageIsValid",
			"function agentRuntimeLifecycleIsValid",
			"assertPublishedReplayReleaseGate(evidence);",
		];
		writeFileSync(
			join(tempDir, "scripts/verify-published-replay-evidence.js"),
			anchors.join("\n"),
			"utf8",
		);

		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "published-replay-evidence-verifier",
						path: "scripts/verify-published-replay-evidence.js",
						evidenceType: "source",
						anchors: anchors.filter(
							(anchor) => anchor !== '"agentRuntimeLifecycle"',
						),
					},
				],
			},
		});

		expect(failures).toContain(
			'published-replay-evidence-verifier: scripts/verify-published-replay-evidence.js must anchor "agentRuntimeLifecycle"',
		);
	});

	it("requires the published replay release-gate assertion", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-replay-gate-${process.pid}-${Date.now()}`,
		);
		mkdirSync(join(tempDir, "scripts"), { recursive: true });
		writeFileSync(
			join(tempDir, "scripts/published-replay-evidence-gate.js"),
			[
				"export function assertPublishedReplayReleaseGate",
				"evidence?.releaseGate?.satisfied === true",
				"Published replay release gate failed",
			].join("\n"),
			"utf8",
		);

		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "published-replay-release-gate",
						path: "scripts/published-replay-evidence-gate.js",
						evidenceType: "source",
						anchors: [
							"export function assertPublishedReplayReleaseGate",
							"evidence?.releaseGate?.satisfied === true",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"published-replay-release-gate: scripts/published-replay-evidence-gate.js must anchor Published replay release gate failed",
		);
	});

	it("requires public mirror package scripts to expose published verification aliases", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-public-scripts-${process.pid}-${Date.now()}`,
		);
		mkdirSync(join(tempDir, "scripts"), { recursive: true });
		writeFileSync(
			join(tempDir, "scripts/prepare-public-release-mirror.mjs"),
			[
				'pkg.scripts["release:verify:published"] =',
				'"node scripts/smoke-registry-install.js";',
				'pkg.scripts["release:verify:published:e2e"] =',
				'"node scripts/smoke-published-replay-e2e.js";',
				'pkg.scripts["release:verify:published:evidence"] =',
				'"node scripts/verify-published-replay-evidence.js";',
				'pkg.scripts["release:deprecate"] = "node scripts/deprecate-release.js";',
			].join("\n"),
			"utf8",
		);

		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "public-mirror-package-scripts",
						path: "scripts/prepare-public-release-mirror.mjs",
						evidenceType: "source",
						anchors: [
							'pkg.scripts["release:verify:published"] =',
							'"node scripts/smoke-registry-install.js";',
							'pkg.scripts["release:verify:published:e2e"] =',
							'"node scripts/smoke-published-replay-e2e.js";',
							'"node scripts/verify-published-replay-evidence.js";',
							'pkg.scripts["release:deprecate"] = "node scripts/deprecate-release.js";',
						],
					},
				],
			},
		});

		expect(failures).toContain(
			'public-mirror-package-scripts: scripts/prepare-public-release-mirror.mjs must anchor pkg.scripts["release:verify:published:evidence"] =',
		);
	});

	it("rejects release-surface gates that can swallow failures", () => {
		tempDir = join(
			tmpdir(),
			`release-surface-script-swallow-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				scripts: {
					"release:check": "node scripts/release-readiness.js release",
					"check:release-surface":
						"node scripts/check-release-surface-conformance.mjs || true",
					"lint:evals": "npm run check:release-surface",
				},
			}),
			"utf8",
		);

		const failures = checkReleaseSurfaceConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate-scripts",
						path: "package.json",
						evidenceType: "package-script",
						anchors: [
							"release:check",
							"scripts/release-readiness.js",
							"check:release-surface",
							"scripts/check-release-surface-conformance.mjs",
							"lint:evals",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate-scripts: package.json scripts.check:release-surface must run scripts/check-release-surface-conformance.mjs",
		);
	});
});

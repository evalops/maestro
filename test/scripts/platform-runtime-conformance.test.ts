import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkPlatformRuntimeConformance,
	loadPlatformRuntimeManifest,
} from "../../scripts/check-platform-runtime-conformance.mjs";

describe("Platform runtime conformance", () => {
	let tempDir = "";

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("passes against the checked-in Platform runtime manifest", () => {
		expect(
			checkPlatformRuntimeConformance({
				manifest: loadPlatformRuntimeManifest(),
			}),
		).toEqual([]);
	});

	it("requires lifecycle claims and anchors with area context", () => {
		tempDir = join(tmpdir(), `platform-runtime-${process.pid}-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "surface.txt"), "present\n", "utf8");

		const failures = checkPlatformRuntimeConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "agentruntime-client-contract",
						evidenceType: "source",
						path: "surface.txt",
						lifecycle: ["turns"],
						anchors: ["present", "missing"],
					},
				],
			},
		});

		expect(failures).toContain(
			'agentruntime-client-contract: surface.txt is missing anchor "missing"',
		);
		expect(failures).toContain(
			"manifest is missing required area toolexecution-client-contract",
		);
		expect(failures).toContain("manifest is missing lifecycle claim approvals");
		expect(failures).toContain(
			"manifest is missing lifecycle claim tool-output-records",
		);
	});

	it("rejects empty anchors", () => {
		tempDir = join(
			tmpdir(),
			`platform-runtime-empty-anchor-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "surface.txt"), "present\n", "utf8");

		const failures = checkPlatformRuntimeConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "agentruntime-client-contract",
						evidenceType: "source",
						path: "surface.txt",
						lifecycle: ["turns"],
						anchors: ["present", ""],
					},
				],
			},
		});

		expect(failures).toContain(
			"agentruntime-client-contract: surface.txt has empty anchor",
		);
	});

	it("rejects evidence paths that escape the repository root", () => {
		tempDir = join(
			tmpdir(),
			`platform-runtime-escape-${process.pid}-${Date.now()}`,
		);
		const rootDir = join(tempDir, "repo");
		mkdirSync(rootDir, { recursive: true });
		writeFileSync(join(tempDir, "outside.txt"), "present\n", "utf8");

		const failures = checkPlatformRuntimeConformance({
			rootDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "agentruntime-client-contract",
						evidenceType: "source",
						path: "../outside.txt",
						lifecycle: ["turns"],
						anchors: ["present"],
					},
				],
			},
		});

		expect(failures).toContain(
			"agentruntime-client-contract: ../outside.txt escapes repository root",
		);
	});

	it("rejects entries without evidence type or lifecycle claims", () => {
		tempDir = join(
			tmpdir(),
			`platform-runtime-missing-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "surface.txt"), "present\n", "utf8");

		const failures = checkPlatformRuntimeConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "agentruntime-client-contract",
						path: "surface.txt",
						anchors: ["present"],
					},
				],
			},
		});

		expect(failures).toContain(
			"agentruntime-client-contract: surface.txt is missing evidenceType",
		);
		expect(failures).toContain(
			"agentruntime-client-contract: surface.txt must list at least one lifecycle claim",
		);
	});

	it("requires A2A realtime delivery producer evidence to stay release-gated", () => {
		const manifest = loadPlatformRuntimeManifest();
		const withoutRealtimeProducer = {
			...manifest,
			checks: manifest.checks
				.filter((check) => check.area !== "a2a-live-evidence-producer")
				.map((check) => ({
					...check,
					lifecycle: Array.isArray(check.lifecycle)
						? check.lifecycle.filter((claim) => claim !== "realtime-delivery")
						: check.lifecycle,
				})),
		};

		const failures = checkPlatformRuntimeConformance({
			manifest: withoutRealtimeProducer,
		});

		expect(failures).toContain(
			"manifest is missing required area a2a-live-evidence-producer",
		);
		expect(failures).toContain(
			"manifest is missing lifecycle claim realtime-delivery",
		);
	});

	it("requires realtime delivery to stay bound to the A2A evidence producer", () => {
		const manifest = loadPlatformRuntimeManifest();
		const withoutProducerRealtimeClaim = {
			...manifest,
			checks: manifest.checks.map((check) =>
				check.area === "a2a-live-evidence-producer"
					? {
							...check,
							lifecycle: check.lifecycle.filter(
								(claim) => claim !== "realtime-delivery",
							),
						}
					: check,
			),
		};

		const failures = checkPlatformRuntimeConformance({
			manifest: withoutProducerRealtimeClaim,
		});

		expect(failures).toContain(
			"a2a-live-evidence-producer: scripts/smoke-platform-a2a-delegation-live.ts must include lifecycle claim realtime-delivery",
		);
	});

	it("requires lint:evals to invoke the Platform runtime conformance gate", () => {
		tempDir = join(
			tmpdir(),
			`platform-runtime-script-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				scripts: {
					"check:platform-runtime-conformance":
						"node scripts/check-platform-runtime-conformance.mjs",
					"lint:evals":
						"node scripts/verify-evals.js && echo check:platform-runtime-conformance",
				},
			}),
			"utf8",
		);

		const failures = checkPlatformRuntimeConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate",
						evidenceType: "package-script",
						path: "package.json",
						lifecycle: ["release-gate"],
						anchors: [
							"check:platform-runtime-conformance",
							"scripts/check-platform-runtime-conformance.mjs",
							"lint:evals",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate: package.json scripts.lint:evals must run check:platform-runtime-conformance",
		);
	});

	it("requires the check script to run the Platform runtime conformance checker", () => {
		tempDir = join(
			tmpdir(),
			`platform-runtime-check-script-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				scripts: {
					"check:platform-runtime-conformance":
						"echo scripts/check-platform-runtime-conformance.mjs",
					"lint:evals": "npm run check:platform-runtime-conformance",
				},
			}),
			"utf8",
		);

		const failures = checkPlatformRuntimeConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate",
						evidenceType: "package-script",
						path: "package.json",
						lifecycle: ["release-gate"],
						anchors: [
							"check:platform-runtime-conformance",
							"scripts/check-platform-runtime-conformance.mjs",
							"lint:evals",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate: package.json scripts.check:platform-runtime-conformance must run scripts/check-platform-runtime-conformance.mjs",
		);
	});

	it("rejects check scripts that can swallow Platform runtime conformance failures", () => {
		tempDir = join(
			tmpdir(),
			`platform-runtime-check-swallow-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				scripts: {
					"check:platform-runtime-conformance":
						"node scripts/check-platform-runtime-conformance.mjs && echo ok; true",
					"lint:evals": "npm run check:platform-runtime-conformance",
				},
			}),
			"utf8",
		);

		const failures = checkPlatformRuntimeConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate",
						evidenceType: "package-script",
						path: "package.json",
						lifecycle: ["release-gate"],
						anchors: [
							"check:platform-runtime-conformance",
							"scripts/check-platform-runtime-conformance.mjs",
							"lint:evals",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate: package.json scripts.check:platform-runtime-conformance must run scripts/check-platform-runtime-conformance.mjs",
		);
	});

	it("rejects check scripts that hide failures with newline command-list tails", () => {
		tempDir = join(
			tmpdir(),
			`platform-runtime-check-newline-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				scripts: {
					"check:platform-runtime-conformance":
						"node scripts/check-platform-runtime-conformance.mjs && echo ok\ntrue",
					"lint:evals": "npm run check:platform-runtime-conformance",
				},
			}),
			"utf8",
		);

		const failures = checkPlatformRuntimeConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate",
						evidenceType: "package-script",
						path: "package.json",
						lifecycle: ["release-gate"],
						anchors: [
							"check:platform-runtime-conformance",
							"scripts/check-platform-runtime-conformance.mjs",
							"lint:evals",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate: package.json scripts.check:platform-runtime-conformance must run scripts/check-platform-runtime-conformance.mjs",
		);
	});

	it("rejects check scripts that hide failures with background command-list tails", () => {
		tempDir = join(
			tmpdir(),
			`platform-runtime-check-background-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				scripts: {
					"check:platform-runtime-conformance":
						"node scripts/check-platform-runtime-conformance.mjs && echo ok &",
					"lint:evals": "npm run check:platform-runtime-conformance",
				},
			}),
			"utf8",
		);

		const failures = checkPlatformRuntimeConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate",
						evidenceType: "package-script",
						path: "package.json",
						lifecycle: ["release-gate"],
						anchors: [
							"check:platform-runtime-conformance",
							"scripts/check-platform-runtime-conformance.mjs",
							"lint:evals",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate: package.json scripts.check:platform-runtime-conformance must run scripts/check-platform-runtime-conformance.mjs",
		);
	});

	it("requires release-gate evidence to validate package scripts", () => {
		tempDir = join(
			tmpdir(),
			`platform-runtime-release-shape-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "surface.txt"),
			"check:platform-runtime-conformance\nlint:evals\n",
			"utf8",
		);

		const failures = checkPlatformRuntimeConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate",
						evidenceType: "source",
						path: "surface.txt",
						lifecycle: ["release-gate"],
						anchors: ["check:platform-runtime-conformance", "lint:evals"],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate: surface.txt must use package.json as release-gate evidence",
		);
		expect(failures).toContain(
			"release-gate: surface.txt must use package-script evidence for release-gate validation",
		);
	});

	it("rejects lint:evals wiring that ignores Platform runtime conformance failures", () => {
		tempDir = join(
			tmpdir(),
			`platform-runtime-ignored-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				scripts: {
					"check:platform-runtime-conformance":
						"node scripts/check-platform-runtime-conformance.mjs",
					"lint:evals": "npm run check:platform-runtime-conformance || true",
				},
			}),
			"utf8",
		);

		const failures = checkPlatformRuntimeConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate",
						evidenceType: "package-script",
						path: "package.json",
						lifecycle: ["release-gate"],
						anchors: [
							"check:platform-runtime-conformance",
							"scripts/check-platform-runtime-conformance.mjs",
							"lint:evals",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate: package.json scripts.lint:evals must run check:platform-runtime-conformance",
		);
	});

	it("rejects lint:evals chains that can swallow later gate failures", () => {
		tempDir = join(
			tmpdir(),
			`platform-runtime-swallowed-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				scripts: {
					"check:platform-runtime-conformance":
						"node scripts/check-platform-runtime-conformance.mjs",
					"lint:evals":
						"npm run check:platform-runtime-conformance && npm run developer-surface:check || true",
				},
			}),
			"utf8",
		);

		const failures = checkPlatformRuntimeConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate",
						evidenceType: "package-script",
						path: "package.json",
						lifecycle: ["release-gate"],
						anchors: [
							"check:platform-runtime-conformance",
							"scripts/check-platform-runtime-conformance.mjs",
							"lint:evals",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate: package.json scripts.lint:evals must run check:platform-runtime-conformance",
		);
	});

	it("rejects lint:evals chains that hide failures with command-list tails", () => {
		tempDir = join(
			tmpdir(),
			`platform-runtime-lint-tail-${process.pid}-${Date.now()}`,
		);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			join(tempDir, "package.json"),
			JSON.stringify({
				scripts: {
					"check:platform-runtime-conformance":
						"node scripts/check-platform-runtime-conformance.mjs",
					"lint:evals":
						"npm run check:platform-runtime-conformance && npm run developer-surface:check; true",
				},
			}),
			"utf8",
		);

		const failures = checkPlatformRuntimeConformance({
			rootDir: tempDir,
			manifest: {
				version: 1,
				checks: [
					{
						area: "release-gate",
						evidenceType: "package-script",
						path: "package.json",
						lifecycle: ["release-gate"],
						anchors: [
							"check:platform-runtime-conformance",
							"scripts/check-platform-runtime-conformance.mjs",
							"lint:evals",
						],
					},
				],
			},
		});

		expect(failures).toContain(
			"release-gate: package.json scripts.lint:evals must run check:platform-runtime-conformance",
		);
	});
});

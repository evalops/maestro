import * as fs from "node:fs";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type SpecModeConfig,
	approveSpecMode,
	enterSpecMode,
	exitSpecMode,
	generateSpecSlug,
	getCurrentSpecPath,
	isSpecModeActive,
	isSpecModeApproved,
	isSpecModePending,
	listSpecs,
	loadSpecModeState,
	readCurrentSpec,
} from "../../src/agent/spec-mode.js";

/**
 * Match a write attempt against an expected suffix, also recognizing
 * the `writeTextFileAtomic` temp-then-rename pattern. The atomic
 * helper writes to `<dir>/.<basename>.tmp.<pid>.<ts>.<hex>` before
 * renaming over the destination, so the spy sees the temp path
 * instead of the final one. This helper makes the mocks resilient
 * to that switch (#2631).
 */
function pathTargets(actualPath: string, expectedSuffix: string): boolean {
	const path = String(actualPath);
	if (path.endsWith(expectedSuffix)) return true;
	const lastSlash = expectedSuffix.lastIndexOf("/");
	if (lastSlash < 0) return false;
	const dirSuffix = expectedSuffix.slice(0, lastSlash);
	const base = expectedSuffix.slice(lastSlash + 1);
	return path.includes(`${dirSuffix}/.${base}.tmp.`);
}

function makeConfig(root: string): SpecModeConfig {
	return {
		specsDir: join(root, "specs"),
		stateFile: join(root, "state", "spec-state.json"),
	};
}

function withReadOnlyStateFile<T>(
	config: SpecModeConfig,
	callback: () => T,
): T {
	const originalMode = fs.statSync(config.stateFile).mode & 0o777;
	fs.chmodSync(config.stateFile, 0o400);
	try {
		return callback();
	} finally {
		fs.chmodSync(config.stateFile, originalMode);
	}
}

function pointTrackedSpecAtSiblingSpec(
	config: SpecModeConfig,
	siblingSlug = "sibling-spec",
	body = "# Spec: Sibling\n\nStatus: pending\n",
): string {
	const siblingDir = join(config.specsDir, siblingSlug);
	mkdirSync(siblingDir, { recursive: true });
	const siblingSpecFilePath = join(siblingDir, "spec.md");
	writeFileSync(siblingSpecFilePath, body);
	const tracked = loadSpecModeState(config);
	if (!tracked) {
		throw new Error("No tracked spec state to tamper");
	}
	writeFileSync(
		config.stateFile,
		JSON.stringify(
			{
				...tracked,
				specDir: siblingDir,
				specFilePath: siblingSpecFilePath,
			},
			null,
			2,
		),
	);
	return siblingSpecFilePath;
}

describe("agent/spec-mode", () => {
	let testRoot: string;
	let config: SpecModeConfig;

	beforeEach(() => {
		testRoot = join(tmpdir(), `spec-mode-test-${Date.now()}-${Math.random()}`);
		mkdirSync(testRoot, { recursive: true });
		config = makeConfig(testRoot);
	});

	afterEach(() => {
		if (existsSync(testRoot)) {
			rmSync(testRoot, { recursive: true, force: true });
		}
	});

	describe("generateSpecSlug", () => {
		it("derives a kebab slug from a name and stamps it", () => {
			const slug = generateSpecSlug("Add OAuth Login");
			expect(slug).toMatch(/^add-oauth-login-/);
		});

		it("falls back to a timestamped slug when no name is given", () => {
			const slug = generateSpecSlug();
			expect(slug).toMatch(/^spec-/);
		});

		it("falls back to a timestamped slug when the name has no safe chars", () => {
			const slug = generateSpecSlug("!!!");
			expect(slug).toMatch(/^spec-/);
		});
	});

	describe("enterSpecMode", () => {
		it("creates a pending spec with a markdown skeleton", () => {
			const state = enterSpecMode({ name: "Add OAuth", config });

			expect(state.status).toBe("pending");
			expect(state.slug).toMatch(/^add-oauth-/);
			expect(existsSync(state.specFilePath)).toBe(true);

			const body = readFileSync(state.specFilePath, "utf-8");
			expect(body).toContain("# Spec: Add OAuth");
			expect(body).toContain("## Acceptance criteria");
			expect(body).toContain("## Out of scope");
		});

		it("captures model + reasoning effort so reviewers can attribute the spec", () => {
			const state = enterSpecMode({
				name: "Refactor billing",
				modelId: "claude-opus-4-7",
				reasoningEffort: "high",
				config,
			});

			expect(state.modelId).toBe("claude-opus-4-7");
			expect(state.reasoningEffort).toBe("high");
			const body = readFileSync(state.specFilePath, "utf-8");
			expect(body).toContain("Model: claude-opus-4-7");
		});

		it("resumes an existing pending spec instead of creating a new one", () => {
			const first = enterSpecMode({ name: "First spec", config });
			const second = enterSpecMode({ config });

			expect(second.slug).toBe(first.slug);
			expect(second.specFilePath).toBe(first.specFilePath);
		});

		it("creates a new spec when an explicit slug is given mid-pending", () => {
			const first = enterSpecMode({ name: "First spec", config });
			const second = enterSpecMode({ slug: "manual-slug", config });

			expect(second.slug).toBe("manual-slug");
			expect(second.slug).not.toBe(first.slug);
			expect(existsSync(second.specFilePath)).toBe(true);
			expect(readFileSync(first.specFilePath, "utf-8")).toContain(
				"Status: archived",
			);
		});

		it("rejects explicit slugs that escape the specs directory", () => {
			expect(() =>
				enterSpecMode({ slug: "../outside-spec", config }),
			).toThrowError(/Invalid spec slug|escapes specs directory/);
		});

		it("preserves approved state when re-entering the active spec by slug", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			const approved = approveSpecMode(config);
			const resumed = enterSpecMode({ slug: entered.slug, config });

			expect(approved?.status).toBe("approved");
			expect(resumed.status).toBe("approved");
			expect(resumed.createdAt).toBe(entered.createdAt);
			expect(resumed.approvedAt).toBe(approved?.approvedAt);
		});

		it("rewrites the spec.md heading when resume changes the name", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			const beforeBody = readFileSync(entered.specFilePath, "utf-8");
			expect(beforeBody).toContain("# Spec: Add OAuth");

			enterSpecMode({ name: "Add SSO", config });

			const afterBody = readFileSync(entered.specFilePath, "utf-8");
			expect(afterBody).toContain("# Spec: Add SSO");
			expect(afterBody).not.toContain("# Spec: Add OAuth");
		});

		it("does not rename an approved spec when resuming with a new name", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			approveSpecMode(config);

			const resumed = enterSpecMode({ name: "Add SSO", config });

			expect(resumed.status).toBe("approved");
			expect(resumed.name).toBe("Add OAuth");
			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("# Spec: Add OAuth");
			expect(body).not.toContain("# Spec: Add SSO");
		});

		it("does not overwrite an approved spec's model attribution on resume", () => {
			enterSpecMode({
				name: "Add OAuth",
				modelId: "claude-opus-4-7",
				reasoningEffort: "high",
				config,
			});
			approveSpecMode(config);

			// Later resume with a different model — the recorded
			// attribution must stay pinned. Reviewers reading the spec
			// later need to see which model wrote it.
			const resumed = enterSpecMode({
				modelId: "claude-sonnet-4-6",
				reasoningEffort: "medium",
				config,
			});

			expect(resumed.status).toBe("approved");
			expect(resumed.modelId).toBe("claude-opus-4-7");
			expect(resumed.reasoningEffort).toBe("high");
			expect(readFileSync(resumed.specFilePath, "utf-8")).toContain(
				"Model: claude-opus-4-7",
			);
		});

		it("uses caller attribution when recreating a pending same-slug spec after spec.md is deleted", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				modelId: "claude-opus-4-7",
				reasoningEffort: "high",
				config,
			});
			rmSync(entered.specFilePath);

			const recreated = enterSpecMode({
				name: "Add SSO",
				slug: entered.slug,
				modelId: "claude-sonnet-4-6",
				reasoningEffort: "medium",
				config,
			});

			expect(recreated.status).toBe("pending");
			expect(recreated.modelId).toBe("claude-sonnet-4-6");
			expect(recreated.reasoningEffort).toBe("medium");
			const body = readFileSync(recreated.specFilePath, "utf-8");
			expect(body).toContain("Model: claude-sonnet-4-6");
			expect(body).not.toContain("Model: claude-opus-4-7");
		});

		it("leaves the spec.md heading untouched when resume keeps the same name", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			const before = readFileSync(entered.specFilePath, "utf-8");

			enterSpecMode({ name: "Add OAuth", config });

			expect(readFileSync(entered.specFilePath, "utf-8")).toBe(before);
		});

		it("keeps the saved state and markdown heading unchanged when resume persistence fails", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			const beforeBody = readFileSync(entered.specFilePath, "utf-8");

			withReadOnlyStateFile(config, () => {
				expect(() =>
					enterSpecMode({
						name: "Add SSO",
						sessionId: "session-2",
						config,
					}),
				).toThrow(/Failed to persist spec mode state/);
			});

			expect(loadSpecModeState(config)?.name).toBe("Add OAuth");
			expect(loadSpecModeState(config)?.sessionId).toBeUndefined();
			expect(readFileSync(entered.specFilePath, "utf-8")).toBe(beforeBody);
		});

		it("refreshes reused spec.md metadata when re-entering an archived slug", () => {
			const first = enterSpecMode({
				name: "Add OAuth",
				modelId: "claude-opus-4-7",
				config,
			});
			const approved = approveSpecMode(config);
			exitSpecMode(config);

			const reopened = enterSpecMode({
				slug: first.slug,
				name: "Add SSO",
				config,
			});

			const body = readFileSync(reopened.specFilePath, "utf-8");
			expect(body).toContain("# Spec: Add SSO");
			expect(body).toContain("Status: pending");
			expect(body).toContain(`Created: ${reopened.createdAt}`);
			expect(body).not.toContain("Status: approved");
			expect(body).not.toContain(`Approved: ${approved?.approvedAt}`);
			expect(body).not.toContain("Model: claude-opus-4-7");
		});

		it("archives the abandoned on-disk spec.md when tracking moves to a different slug from a tampered state", () => {
			const old = enterSpecMode({
				name: "Old plan",
				slug: "old-plan",
				config,
			});
			expect(readFileSync(old.specFilePath, "utf-8")).toContain(
				"Status: pending",
			);

			// Tamper the state file: tracked paths now escape the specs dir,
			// but the real spec.md at `specs/old-plan/spec.md` still says
			// Status: pending and isn't tracked anywhere.
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			const tampered = {
				...loadSpecModeState(config),
				specDir: escapedDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tampered, null, 2));

			// User starts a brand new spec under a different slug.
			enterSpecMode({ name: "New plan", slug: "new-plan", config });

			// The abandoned on-disk spec should be archived rather than left
			// at Status: pending — otherwise it lingers forever as a tracked
			// pending spec the system has no way to find again.
			const oldBody = readFileSync(old.specFilePath, "utf-8");
			expect(oldBody).toContain("Status: archived");
			expect(oldBody).not.toContain("Status: pending");
		});

		it("does not treat a body line containing 'Status: archived' as an archived spec", () => {
			// Create an approved spec, then write a body that mentions
			// "Status: archived" inside the acceptance criteria. The
			// preamble still says approved; the on-disk file is NOT
			// archived. The previous regex match against /m would have
			// treated this as archived and blocked slug-based tamper
			// recovery; the preamble-parser-based check shouldn't.
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			approveSpecMode(config);
			const body = readFileSync(entered.specFilePath, "utf-8");
			writeFileSync(
				entered.specFilePath,
				`${body}\n\n## Body mention\n\nThe runner refuses Status: archived inputs.\n`,
			);

			// Tamper paths so the recovery code path runs.
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			const tampered = {
				...loadSpecModeState(config),
				specDir: escapedDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tampered, null, 2));

			const recovered = enterSpecMode({ slug: "oauth", config });
			// If the regex had matched the body line, recovery would have
			// taken the archived-reuse path and downgraded to pending.
			expect(recovered.status).toBe("approved");
		});

		it("preserves reasoningEffort from the tracked state during tamper-recovery (not in spec.md preamble)", () => {
			enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				modelId: "claude-opus-4-7",
				reasoningEffort: "high",
				config,
			});
			approveSpecMode(config);

			// Tamper the state file so paths escape; the disk spec.md
			// still says approved + model but doesn't (and can't) carry
			// reasoning effort.
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			const tampered = {
				...loadSpecModeState(config),
				specDir: escapedDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tampered, null, 2));

			const recovered = enterSpecMode({ slug: "oauth", config });
			// Pre-fix `reasoningEffort` was silently dropped to undefined
			// because the disk preamble can't carry it. The fall-through
			// to `previousTrackedSpec` recovers it from the (tampered
			// but still loaded) state record.
			expect(recovered.reasoningEffort).toBe("high");
		});

		it("preserves approved attribution during tamper recovery when the spec preamble omits Model", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				modelId: "claude-opus-4-7",
				reasoningEffort: "high",
				config,
			});
			approveSpecMode(config);
			writeFileSync(
				entered.specFilePath,
				readFileSync(entered.specFilePath, "utf-8").replace(
					"Model: claude-opus-4-7\n",
					"",
				),
			);

			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			writeFileSync(
				config.stateFile,
				JSON.stringify(
					{
						...loadSpecModeState(config),
						specDir: escapedDir,
						specFilePath: join(escapedDir, "spec.md"),
					},
					null,
					2,
				),
			);

			const recovered = enterSpecMode({
				slug: entered.slug,
				modelId: "claude-sonnet-4-6",
				reasoningEffort: "medium",
				config,
			});

			expect(recovered.status).toBe("approved");
			expect(recovered.modelId).toBe("claude-opus-4-7");
			expect(recovered.reasoningEffort).toBe("high");
			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("Model: claude-opus-4-7");
			expect(body).not.toContain("Model: claude-sonnet-4-6");
		});

		it("preserves approved status from on-disk spec.md when tamper-recovering by slug", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			const approved = approveSpecMode(config);
			expect(approved?.status).toBe("approved");
			const approvedAt = approved?.approvedAt;

			// Tamper the state file so paths escape; the disk spec.md still
			// lives at the original slug and still says Status: approved.
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			const tampered = {
				...loadSpecModeState(config),
				specDir: escapedDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tampered, null, 2));

			// Re-enter with the same slug. Recovery should re-attach to the
			// existing spec.md and carry approved lifecycle, not restart at
			// pending.
			const recovered = enterSpecMode({ slug: entered.slug, config });
			expect(recovered.status).toBe("approved");
			expect(recovered.approvedAt).toBe(approvedAt);
			expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
				"Status: approved",
			);
		});

		it("keeps approved recovery active when disk recovery falls back to archived unsafe state", async () => {
			vi.resetModules();
			const fs = await import("node:fs");
			let isolatedRoot: string | undefined;
			let failRecoveryReads = false;
			let recoverySpecReads = 0;
			vi.doMock("node:fs", () => ({
				...fs,
				readFileSync: ((
					path: Parameters<typeof fs.readFileSync>[0],
					options?: Parameters<typeof fs.readFileSync>[1],
				) => {
					if (
						failRecoveryReads &&
						String(path).endsWith("/specs/oauth/spec.md")
					) {
						recoverySpecReads += 1;
						if (recoverySpecReads === 2) {
							throw new Error("spec read failed");
						}
					}
					return fs.readFileSync(path, options);
				}) as typeof fs.readFileSync,
			}));

			try {
				const specMode = await import("../../src/agent/spec-mode.js");
				isolatedRoot = join(
					tmpdir(),
					`spec-mode-recover-read-fail-${Date.now()}-${Math.random()}`,
				);
				mkdirSync(isolatedRoot, { recursive: true });
				const isolatedConfig = makeConfig(isolatedRoot);

				const entered = specMode.enterSpecMode({
					name: "Add OAuth",
					slug: "oauth",
					config: isolatedConfig,
				});
				specMode.approveSpecMode(isolatedConfig);
				const escapedDir = join(isolatedRoot, "outside-specs");
				mkdirSync(escapedDir, { recursive: true });
				writeFileSync(
					isolatedConfig.stateFile,
					JSON.stringify(
						{
							...specMode.loadSpecModeState(isolatedConfig),
							status: "archived",
							specDir: escapedDir,
							specFilePath: join(escapedDir, "spec.md"),
						},
						null,
						2,
					),
				);
				failRecoveryReads = true;

				const recovered = specMode.enterSpecMode({
					slug: entered.slug,
					config: isolatedConfig,
				});

				expect(recovered.status).toBe("approved");
				expect(specMode.isSpecModeActive(isolatedConfig)).toBe(true);
				expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
					"Status: approved",
				);
			} finally {
				if (isolatedRoot && existsSync(isolatedRoot)) {
					rmSync(isolatedRoot, { recursive: true, force: true });
				}
				vi.doUnmock("node:fs");
				vi.resetModules();
			}
		});

		it("heals stale spec.md status after recovery fallback saves approved state", async () => {
			vi.resetModules();
			const fs = await import("node:fs");
			let isolatedRoot: string | undefined;
			let failRecoveryReads = false;
			let recoverySpecReads = 0;
			vi.doMock("node:fs", () => ({
				...fs,
				readFileSync: ((
					path: Parameters<typeof fs.readFileSync>[0],
					options?: Parameters<typeof fs.readFileSync>[1],
				) => {
					if (
						failRecoveryReads &&
						String(path).endsWith("/specs/oauth/spec.md")
					) {
						recoverySpecReads += 1;
						if (recoverySpecReads === 2 || recoverySpecReads === 3) {
							throw new Error("spec read failed");
						}
					}
					return fs.readFileSync(path, options);
				}) as typeof fs.readFileSync,
			}));

			try {
				const specMode = await import("../../src/agent/spec-mode.js");
				isolatedRoot = join(
					tmpdir(),
					`spec-mode-recover-stale-status-${Date.now()}-${Math.random()}`,
				);
				mkdirSync(isolatedRoot, { recursive: true });
				const isolatedConfig = makeConfig(isolatedRoot);

				const entered = specMode.enterSpecMode({
					name: "Add OAuth",
					slug: "oauth",
					config: isolatedConfig,
				});
				const approved = specMode.approveSpecMode(isolatedConfig);
				writeFileSync(
					entered.specFilePath,
					readFileSync(entered.specFilePath, "utf-8").replace(
						"Status: approved",
						"Status: pending",
					),
				);
				const escapedDir = join(isolatedRoot, "outside-specs");
				mkdirSync(escapedDir, { recursive: true });
				writeFileSync(
					isolatedConfig.stateFile,
					JSON.stringify(
						{
							...specMode.loadSpecModeState(isolatedConfig),
							specDir: escapedDir,
							specFilePath: join(escapedDir, "spec.md"),
						},
						null,
						2,
					),
				);
				failRecoveryReads = true;

				const recovered = specMode.enterSpecMode({
					slug: entered.slug,
					config: isolatedConfig,
				});

				expect(recovered.status).toBe("approved");
				expect(specMode.isSpecModeApproved(isolatedConfig)).toBe(true);
				const body = readFileSync(entered.specFilePath, "utf-8");
				expect(body).toContain("Status: approved");
				expect(body).not.toContain("Status: pending");
				expect(body).toContain(`Approved: ${approved?.approvedAt}`);
			} finally {
				if (isolatedRoot && existsSync(isolatedRoot)) {
					rmSync(isolatedRoot, { recursive: true, force: true });
				}
				vi.doUnmock("node:fs");
				vi.resetModules();
			}
		});

		it("swallows archived spec read failures when reopening an archived slug", async () => {
			vi.resetModules();
			const fs = await import("node:fs");
			let isolatedRoot: string | undefined;
			let failSpecReads = false;
			vi.doMock("node:fs", () => ({
				...fs,
				readFileSync: ((
					path: Parameters<typeof fs.readFileSync>[0],
					options?: Parameters<typeof fs.readFileSync>[1],
				) => {
					if (failSpecReads && String(path).endsWith("/specs/oauth/spec.md")) {
						throw new Error("spec read failed");
					}
					return fs.readFileSync(path, options);
				}) as typeof fs.readFileSync,
			}));

			try {
				const specMode = await import("../../src/agent/spec-mode.js");
				isolatedRoot = join(
					tmpdir(),
					`spec-mode-archived-read-fail-${Date.now()}-${Math.random()}`,
				);
				mkdirSync(isolatedRoot, { recursive: true });
				const isolatedConfig = makeConfig(isolatedRoot);

				const entered = specMode.enterSpecMode({
					name: "Add OAuth",
					slug: "oauth",
					config: isolatedConfig,
				});
				specMode.approveSpecMode(isolatedConfig);
				specMode.exitSpecMode(isolatedConfig);

				failSpecReads = true;
				const reopened = specMode.enterSpecMode({
					slug: entered.slug,
					config: isolatedConfig,
				});

				expect(reopened.status).toBe("pending");
				expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
					"Status: archived",
				);
			} finally {
				if (isolatedRoot && existsSync(isolatedRoot)) {
					rmSync(isolatedRoot, { recursive: true, force: true });
				}
				vi.doUnmock("node:fs");
				vi.resetModules();
			}
		});

		it("ignores a tampered state file whose specDir escapes the specs directory", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			writeFileSync(join(escapedDir, "spec.md"), "# attacker controlled");
			const tampered = {
				...loadSpecModeState(config),
				specDir: escapedDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tampered, null, 2));

			const fresh = enterSpecMode({ name: "Add SSO", config });

			expect(fresh.slug).not.toBe(entered.slug);
			expect(fresh.specDir.startsWith(config.specsDir)).toBe(true);
		});

		it("archives the prior canonical spec markdown when switching away from tampered state", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			const tampered = {
				...loadSpecModeState(config),
				specDir: escapedDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tampered, null, 2));

			const fresh = enterSpecMode({ name: "Add SSO", config });

			expect(fresh.slug).not.toBe(entered.slug);
			expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
				"Status: archived",
			);
			expect(readFileSync(fresh.specFilePath, "utf-8")).toContain(
				"Status: pending",
			);
		});

		it("refuses to archive an unrelated on-disk spec that just happens to share the tampered slug", () => {
			// Cross-project staleness: spec-state.json carries a slug
			// from another project (MAESTRO_SPEC_DIR moved / state file
			// copied between repos), but the canonical resolution of
			// that slug points at an UNRELATED local spec. Lifecycle
			// sync must not write `Status: archived` onto a spec it
			// doesn't own.
			const owned = enterSpecMode({ name: "Add OAuth", config });

			// Simulate an unrelated spec authored by a different
			// project at the canonical path. Reuse the same slug to
			// trigger the collision; differentiate via `Created`.
			writeFileSync(
				owned.specFilePath,
				[
					"# Spec: Unrelated other-project spec",
					"",
					"Status: approved",
					"Created: 1999-01-01T00:00:00.000Z",
					"Approved: 1999-01-02T00:00:00.000Z",
					"",
					"## Problem",
					"",
					"_Authored by another project._",
				].join("\n"),
			);

			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			const tampered = {
				...loadSpecModeState(config),
				specDir: escapedDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tampered, null, 2));

			// Switching to a new slug should NOT rewrite the unrelated
			// on-disk spec, even though its path matches the tampered
			// state's canonical slug.
			enterSpecMode({ name: "Add SSO", config });

			const onDisk = readFileSync(owned.specFilePath, "utf-8");
			expect(onDisk).toContain("Created: 1999-01-01T00:00:00.000Z");
			// Status must remain the unrelated spec's original.
			expect(onDisk).toContain("Status: approved");
			expect(onDisk).not.toContain("Status: archived");
		});

		it("refuses to recover onto an unrelated same-slug spec when state paths are tampered", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			const unrelatedBody = [
				"# Spec: Unrelated other-project spec",
				"",
				"Status: approved",
				"Created: 1999-01-01T00:00:00.000Z",
				"Approved: 1999-01-02T00:00:00.000Z",
				"",
				"## Problem",
				"",
				"_Keep me untouched._",
			].join("\n");
			writeFileSync(entered.specFilePath, unrelatedBody);

			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			writeFileSync(
				config.stateFile,
				JSON.stringify(
					{
						...loadSpecModeState(config),
						specDir: escapedDir,
						specFilePath: join(escapedDir, "spec.md"),
					},
					null,
					2,
				),
			);

			expect(() =>
				enterSpecMode({
					name: "Recovered",
					slug: entered.slug,
					config,
				}),
			).toThrow(/already has a spec\.md on disk/);
			expect(readFileSync(entered.specFilePath, "utf-8")).toBe(unrelatedBody);
			expect(loadSpecModeState(config)?.createdAt).toBe(entered.createdAt);
		});

		it("refuses to recover onto an unrelated different-slug spec when state paths are tampered", () => {
			// Bugbot's "tamper recovery overwrites unrelated slugs":
			// when state has unsafe paths AND the requested slug
			// doesn't match the tampered record's slug, the disk
			// recovery branch used to skip ownership verification
			// entirely (no matching tracked spec to compare against)
			// and silently take over any pre-existing spec.md sharing
			// the requested slug.
			const original = enterSpecMode({
				name: "Original",
				slug: "original",
				config,
			});
			const unrelatedDir = join(config.specsDir, "unrelated");
			mkdirSync(unrelatedDir, { recursive: true });
			const unrelatedBody = [
				"# Spec: Unrelated other-project spec",
				"",
				"Status: pending",
				"Created: 1999-01-01T00:00:00.000Z",
				"",
				"## Problem",
				"",
				"_Authored elsewhere - keep me untouched._",
			].join("\n");
			const unrelatedPath = join(unrelatedDir, "spec.md");
			writeFileSync(unrelatedPath, unrelatedBody);

			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			writeFileSync(
				config.stateFile,
				JSON.stringify(
					{
						...loadSpecModeState(config),
						specDir: escapedDir,
						specFilePath: join(escapedDir, "spec.md"),
					},
					null,
					2,
				),
			);

			// Request the unrelated slug. With unsafeTracked === null
			// (slug mismatch), the disk-recovery path is no longer
			// auto-trusted; the collision check fires.
			expect(() =>
				enterSpecMode({
					name: "Recovered",
					slug: "unrelated",
					config,
				}),
			).toThrow(/already has a spec\.md on disk/);
			expect(readFileSync(unrelatedPath, "utf-8")).toBe(unrelatedBody);
			// The original spec.md is also untouched.
			expect(existsSync(original.specFilePath)).toBe(true);
			expect(loadSpecModeState(config)?.slug).toBe(original.slug);
			expect(loadSpecModeState(config)?.createdAt).toBe(original.createdAt);
		});

		it("getCurrentSpecPath returns null when the tracked path escapes the specs directory", () => {
			enterSpecMode({ name: "Add OAuth", config });
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			const tampered = {
				...loadSpecModeState(config),
				specDir: escapedDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tampered, null, 2));

			expect(getCurrentSpecPath(config)).toBeNull();
		});

		it("treats escaped tracked paths as inactive for status helpers", () => {
			enterSpecMode({ name: "Add OAuth", config });
			expect(isSpecModeActive(config)).toBe(true);
			expect(isSpecModePending(config)).toBe(true);
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			const tamperedPending = {
				...loadSpecModeState(config),
				specDir: escapedDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tamperedPending, null, 2));

			expect(isSpecModeActive(config)).toBe(false);
			expect(isSpecModePending(config)).toBe(false);

			writeFileSync(
				config.stateFile,
				JSON.stringify(
					{
						...tamperedPending,
						status: "approved",
						approvedAt: new Date().toISOString(),
					},
					null,
					2,
				),
			);

			expect(isSpecModeActive(config)).toBe(false);
			expect(isSpecModeApproved(config)).toBe(false);
		});

		it("preserves the active spec when a replacement slug collides on disk", () => {
			const first = enterSpecMode({
				name: "First",
				slug: "first-spec",
				config,
			});
			approveSpecMode(config);

			const collidingDir = join(config.specsDir, "manual-slug");
			mkdirSync(collidingDir, { recursive: true });
			writeFileSync(join(collidingDir, "spec.md"), "# Spec: Prior\n");

			expect(() =>
				enterSpecMode({ name: "Reuse", slug: "manual-slug", config }),
			).toThrow(/already has a spec\.md/);

			expect(loadSpecModeState(config)?.slug).toBe(first.slug);
			expect(loadSpecModeState(config)?.status).toBe("approved");
			expect(readFileSync(first.specFilePath, "utf-8")).toContain(
				"Status: approved",
			);
		});

		it("preserves the active spec when a replacement slug collides with a maestro-shaped spec on disk", () => {
			const first = enterSpecMode({
				name: "First",
				slug: "first-spec",
				config,
			});
			approveSpecMode(config);

			const collidingDir = join(config.specsDir, "manual-slug");
			mkdirSync(collidingDir, { recursive: true });
			const collidingBody = [
				"# Spec: Prior",
				"",
				"Status: pending",
				"Created: 1999-01-01T00:00:00.000Z",
				"",
				"## Problem",
				"",
				"Keep me.",
				"",
			].join("\n");
			writeFileSync(join(collidingDir, "spec.md"), collidingBody);

			expect(() =>
				enterSpecMode({ name: "Reuse", slug: "manual-slug", config }),
			).toThrow(/already has a spec\.md/);

			expect(loadSpecModeState(config)?.slug).toBe(first.slug);
			expect(loadSpecModeState(config)?.status).toBe("approved");
			expect(readFileSync(join(collidingDir, "spec.md"), "utf-8")).toBe(
				collidingBody,
			);
			expect(readFileSync(first.specFilePath, "utf-8")).toContain(
				"Status: approved",
			);
		});

		it("syncs spec.md Model line on resume when the modelId changes", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				modelId: "claude-opus-4-7",
				config,
			});
			expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
				"Model: claude-opus-4-7",
			);

			enterSpecMode({
				name: "Add OAuth",
				slug: entered.slug,
				modelId: "claude-sonnet-4-6",
				config,
			});

			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("Model: claude-sonnet-4-6");
			expect(body).not.toContain("Model: claude-opus-4-7");
		});
		it("heals spec.md Status drift on resume when state and file disagree", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			approveSpecMode(config);

			// Simulate a stale spec.md whose Status line lags the state (e.g.
			// the prior approve write succeeded for state but failed for the
			// markdown). Re-entering the same slug should reconcile.
			writeFileSync(
				entered.specFilePath,
				readFileSync(entered.specFilePath, "utf-8").replace(
					"Status: approved",
					"Status: pending",
				),
			);
			expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
				"Status: pending",
			);

			enterSpecMode({ slug: entered.slug, config });

			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("Status: approved");
			expect(body).not.toContain("Status: pending");
		});

		it("archives the previous active spec when entering a new one with a different slug", () => {
			const first = enterSpecMode({
				name: "First",
				slug: "first-spec",
				config,
			});
			const firstApproved = approveSpecMode(config);
			expect(firstApproved?.status).toBe("approved");

			const second = enterSpecMode({
				name: "Second",
				slug: "second-spec",
				config,
			});

			expect(second.slug).toBe("second-spec");
			expect(second.status).toBe("pending");

			const firstBody = readFileSync(first.specFilePath, "utf-8");
			expect(firstBody).toContain("Status: archived");
			expect(firstBody).not.toContain("Status: approved");
		});

		it("does not archive a same-slug spec under the current specs root when stale state came from another specs directory", () => {
			const sharedStateFile = join(testRoot, "shared-state", "spec-state.json");
			const legacyConfig: SpecModeConfig = {
				specsDir: join(testRoot, "legacy-specs"),
				stateFile: sharedStateFile,
			};
			const currentConfig: SpecModeConfig = {
				specsDir: join(testRoot, "current-specs"),
				stateFile: sharedStateFile,
			};

			enterSpecMode({
				name: "Legacy",
				slug: "shared-spec",
				config: legacyConfig,
			});

			const currentSpecDir = join(currentConfig.specsDir, "shared-spec");
			mkdirSync(currentSpecDir, { recursive: true });
			const currentSpecFilePath = join(currentSpecDir, "spec.md");
			const currentBody = [
				"# Spec: Current",
				"",
				"Status: pending",
				"",
				"## Problem",
				"",
				"Keep me.",
				"",
			].join("\n");
			writeFileSync(currentSpecFilePath, currentBody);

			enterSpecMode({
				name: "Fresh",
				slug: "fresh-spec",
				config: currentConfig,
			});

			expect(readFileSync(currentSpecFilePath, "utf-8")).toBe(currentBody);
		});

		it("reopens a superseded archived slug from disk", () => {
			const first = enterSpecMode({
				name: "First",
				slug: "first-spec",
				config,
			});
			approveSpecMode(config);

			const second = enterSpecMode({
				name: "Second",
				slug: "second-spec",
				config,
			});
			expect(readFileSync(first.specFilePath, "utf-8")).toContain(
				"Status: archived",
			);

			const reopened = enterSpecMode({
				name: "First reopened",
				slug: first.slug,
				config,
			});

			expect(reopened.slug).toBe(first.slug);
			expect(reopened.status).toBe("pending");
			expect(loadSpecModeState(config)?.slug).toBe(first.slug);
			expect(readFileSync(reopened.specFilePath, "utf-8")).toContain(
				"# Spec: First reopened",
			);
			expect(readFileSync(reopened.specFilePath, "utf-8")).toContain(
				"Status: pending",
			);
			expect(readFileSync(second.specFilePath, "utf-8")).toContain(
				"Status: archived",
			);
		});

		it("refuses to reopen a superseded slug when its on-disk status drifted back to pending", () => {
			const first = enterSpecMode({
				name: "First",
				slug: "first-spec",
				config,
			});
			approveSpecMode(config);

			const second = enterSpecMode({
				name: "Second",
				slug: "second-spec",
				config,
			});

			writeFileSync(
				first.specFilePath,
				readFileSync(first.specFilePath, "utf-8").replace(
					"Status: archived",
					"Status: pending",
				),
			);

			const firstSummary = listSpecs(config).find((s) => s.slug === first.slug);
			expect(firstSummary?.status).toBe("archived");

			expect(() =>
				enterSpecMode({
					name: "First reopened",
					slug: first.slug,
					config,
				}),
			).toThrow(/already has a spec\.md/);

			expect(loadSpecModeState(config)?.slug).toBe(second.slug);
			expect(loadSpecModeState(config)?.status).toBe("pending");
			expect(readFileSync(first.specFilePath, "utf-8")).toContain(
				"Status: pending",
			);
			expect(readFileSync(second.specFilePath, "utf-8")).toContain(
				"Status: pending",
			);
		});

		it("allows slug-based recovery when state file paths are tampered/escaped", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			// Tamper the state file to point at an escaped path; state is now
			// untrustworthy but the on-disk spec at `entered.slug` is still valid.
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			const tampered = {
				...loadSpecModeState(config),
				specDir: escapedDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tampered, null, 2));

			// Re-entering by the original slug should heal — without this fix,
			// the collision check threw because canReuseArchivedSpecFile didn't
			// account for the "state is untrustworthy" case.
			const recovered = enterSpecMode({
				name: "Recovered",
				slug: entered.slug,
				config,
			});
			expect(recovered.slug).toBe(entered.slug);
			expect(recovered.name).toBe("Recovered");
			expect(existsSync(entered.specFilePath)).toBe(true);
			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("# Spec: Recovered");
			expect(body).not.toContain("# Spec: Add OAuth");
		});

		it("preserves approved metadata during slug-based recovery from unsafe state", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				modelId: "claude-opus-4-7",
				reasoningEffort: "high",
				config,
			});
			const approved = approveSpecMode(config);
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			const tampered = {
				...loadSpecModeState(config),
				specDir: escapedDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tampered, null, 2));

			const recovered = enterSpecMode({
				slug: entered.slug,
				config,
			});

			expect(recovered.status).toBe("approved");
			expect(recovered.createdAt).toBe(entered.createdAt);
			expect(recovered.approvedAt).toBe(approved?.approvedAt);
			expect(recovered.modelId).toBe("claude-opus-4-7");
			expect(recovered.reasoningEffort).toBe("high");
			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("Status: approved");
			expect(body).toContain(`Created: ${entered.createdAt}`);
			expect(body).toContain(`Approved: ${approved?.approvedAt}`);
			expect(body).toContain("Model: claude-opus-4-7");
		});

		it("preserves the tracked approved name when spec.md falls back to a generic heading", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			const approved = approveSpecMode(config);
			writeFileSync(
				entered.specFilePath,
				readFileSync(entered.specFilePath, "utf-8").replace(
					"# Spec: Add OAuth",
					"# Spec",
				),
			);
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			writeFileSync(
				config.stateFile,
				JSON.stringify(
					{
						...loadSpecModeState(config),
						specDir: escapedDir,
						specFilePath: join(escapedDir, "spec.md"),
					},
					null,
					2,
				),
			);

			const recovered = enterSpecMode({ slug: entered.slug, config });

			expect(recovered.status).toBe("approved");
			expect(recovered.name).toBe("Add OAuth");
			expect(recovered.approvedAt).toBe(approved?.approvedAt);
			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("# Spec: Add OAuth");
			expect(body).not.toContain("# Spec\n");
		});

		it("keeps tracked approved status during tamper recovery when spec.md Status is stale", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			const approved = approveSpecMode(config);
			writeFileSync(
				entered.specFilePath,
				readFileSync(entered.specFilePath, "utf-8").replace(
					"Status: approved",
					"Status: pending",
				),
			);
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			writeFileSync(
				config.stateFile,
				JSON.stringify(
					{
						...loadSpecModeState(config),
						specDir: escapedDir,
						specFilePath: join(escapedDir, "spec.md"),
					},
					null,
					2,
				),
			);

			const recovered = enterSpecMode({ slug: entered.slug, config });

			expect(recovered.status).toBe("approved");
			expect(recovered.approvedAt).toBe(approved?.approvedAt);
			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("Status: approved");
			expect(body).not.toContain("Status: pending");
			expect(body).toContain(`Approved: ${approved?.approvedAt}`);
		});

		it("drops orphan approvedAt during pending tamper recovery", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			writeFileSync(
				entered.specFilePath,
				readFileSync(entered.specFilePath, "utf-8").replace(
					"Created: ",
					`Approved: ${new Date().toISOString()}\nCreated: `,
				),
			);
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			writeFileSync(
				config.stateFile,
				JSON.stringify(
					{
						...loadSpecModeState(config),
						specDir: escapedDir,
						specFilePath: join(escapedDir, "spec.md"),
					},
					null,
					2,
				),
			);

			const recovered = enterSpecMode({ slug: entered.slug, config });

			expect(recovered.status).toBe("pending");
			expect(recovered.approvedAt).toBeUndefined();
			expect(loadSpecModeState(config)?.approvedAt).toBeUndefined();
			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("Status: pending");
			expect(body).not.toContain("Approved:");
		});

		it("does not rewrite a sibling spec when tracked paths point at another in-tree slug", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "add-oauth",
				config,
			});
			const siblingBody = [
				"# Spec: Sibling",
				"",
				"Status: pending",
				"",
				"## Problem",
				"",
				"Keep me.",
				"",
			].join("\n");
			const siblingSpecFilePath = pointTrackedSpecAtSiblingSpec(
				config,
				"sibling-spec",
				siblingBody,
			);

			const recovered = enterSpecMode({ slug: entered.slug, config });

			expect(recovered.slug).toBe(entered.slug);
			expect(recovered.specFilePath).toBe(entered.specFilePath);
			expect(readFileSync(siblingSpecFilePath, "utf-8")).toBe(siblingBody);
			expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
				"# Spec: Add OAuth",
			);
		});

		it("does not re-archive a fresh spec.md when same-slug recreate follows missing-file detection", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			rmSync(entered.specFilePath);

			// Re-enter with the SAME slug. The recreated spec should end up
			// Status: pending, NOT archived (which would happen if the late
			// "archive previous on entry" step re-marked the same path).
			const recreated = enterSpecMode({
				name: "Add OAuth",
				slug: entered.slug,
				config,
			});

			expect(recreated.status).toBe("pending");
			expect(recreated.specFilePath).toBe(entered.specFilePath);
			const body = readFileSync(recreated.specFilePath, "utf-8");
			expect(body).toContain("Status: pending");
			expect(body).not.toContain("Status: archived");
		});

		it("archives state and starts fresh when the tracked spec.md is missing on resume", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			// Simulate a manual delete / crash-after-state-save: state still
			// claims pending but spec.md is gone.
			rmSync(entered.specFilePath);
			expect(loadSpecModeState(config)?.status).toBe("pending");

			// Re-entering should detect the missing file, archive the bad
			// state, and create a fresh spec instead of returning a state
			// that lies about a file that doesn't exist.
			const fresh = enterSpecMode({ name: "Add SSO", config });
			expect(fresh.specFilePath).not.toBe(entered.specFilePath);
			expect(existsSync(fresh.specFilePath)).toBe(true);
			// The state file now points at the new fresh spec (not the broken
			// resumed one), and isSpecModePending agrees with readCurrentSpec.
			expect(isSpecModePending(config)).toBe(true);
			expect(readCurrentSpec(config)).toContain("Status: pending");
		});

		it("does not archive state eagerly when the replacement save fails after missing-file detection", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			// Delete spec.md so the missing-file branch fires on the
			// next entry. Then make the state file read-only so the
			// late `saveSpecModeState(state, config)` save throws and
			// the new-spec creation never lands.
			rmSync(entered.specFilePath);

			expect(() =>
				withReadOnlyStateFile(config, () =>
					enterSpecMode({ name: "Add SSO", config }),
				),
			).toThrow();

			// Pre-fix the state was archived eagerly when the missing
			// file was detected, so a subsequent failure left the user
			// with an archived state and no new spec — the worst of
			// both worlds. With the fix the state stays untouched and
			// the next call can recover.
			const state = loadSpecModeState(config);
			expect(state?.status).toBe("pending");
			expect(state?.slug).toBe(entered.slug);
		});

		it("does not unlink an existing on-disk spec.md when the rollback path has no body to restore", () => {
			// Build a state where:
			//   - the tracked slug has a spec.md on disk (so existsSync
			//     is true at the start of enterSpecMode)
			//   - state file is read-only so saveSpecModeState fails
			// Pre-fix: rollback saw `previousSpecBody === null` and
			// unlinked the existing file even though the call never
			// created it.
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			const initialBody = readFileSync(entered.specFilePath, "utf-8");

			// Make the state save fail mid-reentry. We use the same
			// slug so the archived-reuse branch runs and tries to
			// modify the existing file.
			expect(() =>
				withReadOnlyStateFile(config, () =>
					enterSpecMode({
						name: "Add OAuth",
						slug: "oauth",
						sessionId: "session-2",
						config,
					}),
				),
			).toThrow();

			// File still exists with its content intact.
			expect(existsSync(entered.specFilePath)).toBe(true);
			expect(readFileSync(entered.specFilePath, "utf-8")).toBe(initialBody);
		});

		it("refuses to start a new explicit slug while an approved spec has a missing spec.md", () => {
			// Approved specs are durable acceptance criteria. If the
			// file vanishes and the user calls enterSpecMode with a
			// DIFFERENT explicit slug, silently overwriting state would
			// drop the approval without leaving an archive trail (the
			// archive step can't rewrite Status: archived on a missing
			// file). Force the caller to recover or exit first.
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			const approved = approveSpecMode(config);
			expect(approved?.status).toBe("approved");
			rmSync(entered.specFilePath);

			expect(() =>
				enterSpecMode({ name: "Add SSO", slug: "sso", config }),
			).toThrow(/approved spec "oauth" has a missing spec\.md/);

			// Same-slug entry still works as a recovery path.
			const recovered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			expect(recovered.slug).toBe("oauth");
			expect(recovered.status).toBe("approved");
		});

		it("preserves modelId from tampered tracked state when the preamble lacks Model:", () => {
			// Bugbot: modelId fell back only to recoveredSpecMetadata
			// then options. If the on-disk preamble lacked `Model:`
			// (e.g. an older spec.md), tamper-recovery silently cleared
			// the modelId that the original tracked entry recorded.
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				modelId: "claude-opus-4-7",
				config,
			});

			// Strip the Model line from spec.md to simulate an older
			// preamble that doesn't carry modelId.
			const body = readFileSync(entered.specFilePath, "utf-8").replace(
				/^Model:.*$\n/m,
				"",
			);
			writeFileSync(entered.specFilePath, body);

			// Tamper state to untrustworthy paths.
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			writeFileSync(
				config.stateFile,
				JSON.stringify(
					{
						...loadSpecModeState(config),
						specDir: escapedDir,
						specFilePath: join(escapedDir, "spec.md"),
					},
					null,
					2,
				),
			);

			const recovered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			expect(recovered.modelId).toBe("claude-opus-4-7");
		});

		it("preserves modelId + reasoningEffort on approved-spec recovery, ignoring new caller options", () => {
			// Bugbot: reasoningEffort preferred options.reasoningEffort
			// before falling back to tracked state, contradicting the
			// resume-path rule that approved attribution must not be
			// overwritten. Same fix applies to modelId.
			enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				modelId: "claude-opus-4-7",
				reasoningEffort: "high",
				config,
			});
			approveSpecMode(config);

			// Tamper state to untrustworthy paths so recovery fires.
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			writeFileSync(
				config.stateFile,
				JSON.stringify(
					{
						...loadSpecModeState(config),
						specDir: escapedDir,
						specFilePath: join(escapedDir, "spec.md"),
					},
					null,
					2,
				),
			);

			const recovered = enterSpecMode({
				slug: "oauth",
				modelId: "claude-sonnet-4-6",
				reasoningEffort: "low",
				config,
			});
			expect(recovered.status).toBe("approved");
			expect(recovered.modelId).toBe("claude-opus-4-7");
			expect(recovered.reasoningEffort).toBe("high");
		});

		it("falls back to tracked-state name when approved spec.md has a bare '# Spec' heading", () => {
			// Bugbot: recoveredName took the parsed preamble first; if
			// the heading was the generic "# Spec" (no name), the
			// recovery dropped a perfectly good tracked name and the
			// preamble got rewritten to the generic title.
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			approveSpecMode(config);

			// Replace the heading with the bare form (no name).
			const body = readFileSync(entered.specFilePath, "utf-8").replace(
				/^# Spec: .*$/m,
				"# Spec",
			);
			writeFileSync(entered.specFilePath, body);

			// Tamper state paths so recovery fires.
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			writeFileSync(
				config.stateFile,
				JSON.stringify(
					{
						...loadSpecModeState(config),
						specDir: escapedDir,
						specFilePath: join(escapedDir, "spec.md"),
					},
					null,
					2,
				),
			);

			const recovered = enterSpecMode({ slug: "oauth", config });
			expect(recovered.status).toBe("approved");
			expect(recovered.name).toBe("Add OAuth");
		});

		it("preserves an approved spec's slug + status on parameterless resume when spec.md is missing", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			const approved = approveSpecMode(config);
			expect(approved?.status).toBe("approved");

			// File disappears. Parameterless re-entry must recover the
			// same slug + approved lifecycle instead of synthesizing a
			// fresh timestamped slug and dropping the approval.
			rmSync(entered.specFilePath);

			const recovered = enterSpecMode({ config });
			expect(recovered.slug).toBe(entered.slug);
			expect(recovered.status).toBe("approved");
			expect(recovered.approvedAt).toBe(approved?.approvedAt);
		});

		it("keeps a recreated same-slug spec pending when the tracked spec.md is missing", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "add-oauth",
				config,
			});
			rmSync(entered.specFilePath);

			const recreated = enterSpecMode({
				name: "Add SSO",
				slug: entered.slug,
				config,
			});

			expect(recreated.slug).toBe(entered.slug);
			expect(recreated.status).toBe("pending");
			expect(loadSpecModeState(config)?.status).toBe("pending");
			const body = readFileSync(recreated.specFilePath, "utf-8");
			expect(body).toContain("Status: pending");
			expect(body).not.toContain("Status: archived");
			expect(readCurrentSpec(config)).toContain("Status: pending");
		});

		it("does not archive tracked state before missing-file recovery is durable", async () => {
			vi.resetModules();
			const fs = await import("node:fs");
			let isolatedRoot: string | undefined;
			let enforceSingleStateWrite = false;
			let stateWriteCount = 0;
			vi.doMock("node:fs", () => ({
				...fs,
				writeFileSync: ((
					path: Parameters<typeof fs.writeFileSync>[0],
					data: Parameters<typeof fs.writeFileSync>[1],
					options?: Parameters<typeof fs.writeFileSync>[2],
				) => {
					if (
						enforceSingleStateWrite &&
						pathTargets(path, "/state/spec-state.json")
					) {
						stateWriteCount += 1;
						if (stateWriteCount > 1) {
							throw new Error("unexpected second state write");
						}
					}
					return fs.writeFileSync(path, data, options);
				}) as typeof fs.writeFileSync,
			}));

			try {
				const specMode = await import("../../src/agent/spec-mode.js");
				isolatedRoot = join(
					tmpdir(),
					`spec-mode-missing-file-recovery-${Date.now()}-${Math.random()}`,
				);
				mkdirSync(isolatedRoot, { recursive: true });
				const isolatedConfig = makeConfig(isolatedRoot);

				const entered = specMode.enterSpecMode({
					name: "First",
					slug: "first-spec",
					config: isolatedConfig,
				});
				specMode.approveSpecMode(isolatedConfig);
				rmSync(entered.specFilePath);

				enforceSingleStateWrite = true;
				stateWriteCount = 0;

				const fresh = specMode.enterSpecMode({
					name: "Second",
					config: isolatedConfig,
				});

				expect(stateWriteCount).toBe(1);
				// Approved spec recovery preserves the slug + status —
				// silently spawning a new pending slug would drop durable
				// approved acceptance criteria the user committed to.
				expect(fresh.slug).toBe(entered.slug);
				expect(specMode.loadSpecModeState(isolatedConfig)?.slug).toBe(
					fresh.slug,
				);
				expect(specMode.loadSpecModeState(isolatedConfig)?.status).toBe(
					"approved",
				);
			} finally {
				if (isolatedRoot && existsSync(isolatedRoot)) {
					rmSync(isolatedRoot, { recursive: true, force: true });
				}
				vi.doUnmock("node:fs");
				vi.resetModules();
			}
		});

		it("keeps a recreated same-slug approved spec approved when the tracked spec.md is missing", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "add-oauth",
				config,
			});
			const approved = approveSpecMode(config);
			expect(approved?.status).toBe("approved");
			expect(approved?.approvedAt).toBeDefined();
			rmSync(entered.specFilePath);

			const recreated = enterSpecMode({
				name: "Add OAuth",
				slug: entered.slug,
				config,
			});

			expect(recreated.slug).toBe(entered.slug);
			expect(recreated.status).toBe("approved");
			expect(recreated.approvedAt).toBe(approved?.approvedAt);
			expect(loadSpecModeState(config)?.status).toBe("approved");
			const body = readFileSync(recreated.specFilePath, "utf-8");
			expect(body).toContain("Status: approved");
			expect(body).toContain(`Approved: ${approved?.approvedAt}`);
			expect(readCurrentSpec(config)).toContain("Status: approved");
		});

		it("keeps the previous spec active when persisting the replacement state fails", () => {
			const first = enterSpecMode({
				name: "First",
				slug: "first-spec",
				config,
			});
			const firstApproved = approveSpecMode(config);
			expect(firstApproved?.status).toBe("approved");

			withReadOnlyStateFile(config, () => {
				expect(() =>
					enterSpecMode({
						name: "Second",
						slug: "second-spec",
						config,
					}),
				).toThrow(/Failed to persist spec mode state/);
			});

			expect(loadSpecModeState(config)?.slug).toBe(first.slug);
			expect(loadSpecModeState(config)?.status).toBe("approved");
			const firstBody = readFileSync(first.specFilePath, "utf-8");
			expect(firstBody).toContain("Status: approved");
			expect(firstBody).not.toContain("Status: archived");
		});

		it("preserves the previous active spec when the replacement spec.md write fails", async () => {
			vi.resetModules();
			const fs = await import("node:fs");
			let isolatedRoot: string | undefined;
			vi.doMock("node:fs", () => ({
				...fs,
				writeFileSync: ((
					path: Parameters<typeof fs.writeFileSync>[0],
					data: Parameters<typeof fs.writeFileSync>[1],
					options?: Parameters<typeof fs.writeFileSync>[2],
				) => {
					if (pathTargets(path, "/specs/second-spec/spec.md")) {
						throw new Error("spec write failed");
					}
					return fs.writeFileSync(path, data, options);
				}) as typeof fs.writeFileSync,
			}));

			try {
				const specMode = await import("../../src/agent/spec-mode.js");
				isolatedRoot = join(
					tmpdir(),
					`spec-mode-write-fail-${Date.now()}-${Math.random()}`,
				);
				mkdirSync(isolatedRoot, { recursive: true });
				const isolatedConfig = makeConfig(isolatedRoot);

				const first = specMode.enterSpecMode({
					name: "First",
					slug: "first-spec",
					config: isolatedConfig,
				});
				specMode.approveSpecMode(isolatedConfig);

				expect(
					() =>
						specMode.enterSpecMode({
							name: "Second",
							slug: "second-spec",
							config: isolatedConfig,
						}),
					// Atomic helper wraps the inner error as a FileSystemError
					// (#2631); the original "spec write failed" message lives
					// on `.cause`. Match either the original or the wrapped form.
				).toThrow(/spec write failed|Failed to write file atomically/);

				expect(specMode.loadSpecModeState(isolatedConfig)?.slug).toBe(
					first.slug,
				);
				expect(specMode.loadSpecModeState(isolatedConfig)?.status).toBe(
					"approved",
				);
				expect(readFileSync(first.specFilePath, "utf-8")).toContain(
					"Status: approved",
				);
				expect(readFileSync(first.specFilePath, "utf-8")).not.toContain(
					"Status: archived",
				);
			} finally {
				if (isolatedRoot && existsSync(isolatedRoot)) {
					rmSync(isolatedRoot, { recursive: true, force: true });
				}
				vi.doUnmock("node:fs");
				vi.resetModules();
			}
		});
	});

	describe("approveSpecMode", () => {
		it("refuses to approve a spec whose spec.md is missing on disk", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			// Delete spec.md so the file is gone but state still says pending.
			rmSync(entered.specFilePath);

			expect(() => approveSpecMode(config)).toThrow(/spec\.md is missing/);
			// State stays pending — the inconsistency the throw exists to
			// prevent never lands on disk.
			expect(loadSpecModeState(config)?.status).toBe("pending");
		});

		it("transitions pending → approved and stamps approvedAt", () => {
			enterSpecMode({ name: "Add OAuth", config });
			const approved = approveSpecMode(config);

			expect(approved?.status).toBe("approved");
			expect(approved?.approvedAt).toBeDefined();
			expect(isSpecModeApproved(config)).toBe(true);
			expect(isSpecModePending(config)).toBe(false);
		});

		it("rewrites spec.md to reflect the approved status", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
				"Status: pending",
			);

			const approved = approveSpecMode(config);

			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("Status: approved");
			expect(body).not.toContain("Status: pending");
			expect(body).toContain(`Approved: ${approved?.approvedAt}`);
		});

		it("updates only the preamble Status line, never body lines that mention 'Status:'", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			// Add an acceptance-criteria body line that mentions
			// `Status:` so the previous body-wide regex would have
			// matched it. The preamble-scoped sync must leave the body
			// alone and only update the preamble's `Status:` row.
			const initial = readFileSync(entered.specFilePath, "utf-8");
			const tampered = `${initial}\n## Acceptance\n\n- Status: archived runs are read-only.\n`;
			writeFileSync(entered.specFilePath, tampered);

			approveSpecMode(config);

			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("Status: archived runs are read-only.");
			// Preamble swapped pending → approved as expected.
			expect(body.split("## Acceptance")[0]).toContain("Status: approved");
			expect(body.split("## Acceptance")[0]).not.toContain("Status: pending");
		});

		it("leaves state and markdown pending when approval persistence fails", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });

			expect(() =>
				withReadOnlyStateFile(config, () => approveSpecMode(config)),
			).toThrow(/Failed to persist spec mode state during approval/);

			expect(loadSpecModeState(config)?.status).toBe("pending");
			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("Status: pending");
			expect(body).not.toContain("Status: approved");
			expect(body).not.toContain("Approved:");
		});

		it("returns null when no spec is tracked", () => {
			expect(approveSpecMode(config)).toBeNull();
		});

		it("treats escaped tracked paths as inactive during approval", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			const tampered = {
				...loadSpecModeState(config),
				specDir: escapedDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tampered, null, 2));

			expect(approveSpecMode(config)).toBeNull();
			expect(loadSpecModeState(config)?.status).toBe("pending");
			expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
				"Status: pending",
			);
		});

		it("treats sibling-spec path swaps as inactive during approval", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "add-oauth",
				config,
			});
			const siblingSpecFilePath = pointTrackedSpecAtSiblingSpec(config);

			expect(approveSpecMode(config)).toBeNull();
			expect(loadSpecModeState(config)?.status).toBe("pending");
			expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
				"Status: pending",
			);
			expect(readFileSync(siblingSpecFilePath, "utf-8")).toContain(
				"Status: pending",
			);
		});

		it("is a no-op when the spec is already archived", () => {
			enterSpecMode({ name: "Add OAuth", config });
			exitSpecMode(config);
			const result = approveSpecMode(config);

			expect(result?.status).toBe("archived");
		});

		it("throws and leaves spec.md unchanged when saving approval fails", async () => {
			vi.resetModules();
			const fs = await import("node:fs");
			let isolatedRoot: string | undefined;
			vi.doMock("node:fs", () => ({
				...fs,
				writeFileSync: ((
					path: Parameters<typeof fs.writeFileSync>[0],
					data: Parameters<typeof fs.writeFileSync>[1],
					options?: Parameters<typeof fs.writeFileSync>[2],
				) => {
					if (
						pathTargets(path, "/state/spec-state.json") &&
						typeof data === "string" &&
						data.includes('"status": "approved"')
					) {
						throw new Error("state save failed");
					}
					return fs.writeFileSync(path, data, options);
				}) as typeof fs.writeFileSync,
			}));

			try {
				const specMode = await import("../../src/agent/spec-mode.js");
				isolatedRoot = join(
					tmpdir(),
					`spec-mode-approve-save-fail-${Date.now()}-${Math.random()}`,
				);
				mkdirSync(isolatedRoot, { recursive: true });
				const isolatedConfig = makeConfig(isolatedRoot);

				const entered = specMode.enterSpecMode({
					name: "Add OAuth",
					config: isolatedConfig,
				});

				expect(() => specMode.approveSpecMode(isolatedConfig)).toThrow(
					/Failed to persist spec mode state during approval/,
				);
				expect(specMode.loadSpecModeState(isolatedConfig)?.status).toBe(
					"pending",
				);
				expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
					"Status: pending",
				);
				expect(readFileSync(entered.specFilePath, "utf-8")).not.toContain(
					"Status: approved",
				);
			} finally {
				if (isolatedRoot && existsSync(isolatedRoot)) {
					rmSync(isolatedRoot, { recursive: true, force: true });
				}
				vi.doUnmock("node:fs");
				vi.resetModules();
			}
		});
	});

	describe("exitSpecMode", () => {
		it("archives a pending spec without approving it", () => {
			enterSpecMode({ name: "Add OAuth", config });
			const archived = exitSpecMode(config);

			expect(archived?.status).toBe("archived");
			expect(isSpecModeActive(config)).toBe(false);
		});

		it("rewrites spec.md to reflect the archived status", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
				"Status: pending",
			);

			exitSpecMode(config);

			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("Status: archived");
			expect(body).not.toContain("Status: pending");
		});

		it("rewrites spec.md status after approval → archive transition", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			approveSpecMode(config);
			expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
				"Status: approved",
			);

			exitSpecMode(config);

			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("Status: archived");
			expect(body).not.toContain("Status: approved");
		});

		it("archives the safe on-disk spec.md when the tracked path was tampered outside the specs directory", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
				"Status: pending",
			);

			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			const tampered = {
				...loadSpecModeState(config),
				specDir: escapedDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tampered, null, 2));

			const archived = exitSpecMode(config);

			expect(archived?.status).toBe("archived");
			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("Status: archived");
			expect(body).not.toContain("Status: pending");
		});

		it("leaves state and markdown approved when archive persistence fails", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			const approved = approveSpecMode(config);
			expect(approved?.status).toBe("approved");

			expect(() =>
				withReadOnlyStateFile(config, () => exitSpecMode(config)),
			).toThrow(/Failed to persist spec mode state during exit/);

			expect(loadSpecModeState(config)?.status).toBe("approved");
			const body = readFileSync(entered.specFilePath, "utf-8");
			expect(body).toContain("Status: approved");
			expect(body).not.toContain("Status: archived");
		});

		it("archives an approved spec when called after approval", () => {
			enterSpecMode({ name: "Add OAuth", config });
			approveSpecMode(config);
			const archived = exitSpecMode(config);

			expect(archived?.status).toBe("archived");
			expect(archived?.approvedAt).toBeDefined();
		});

		it("preserves the spec file on disk after archiving", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			exitSpecMode(config);

			expect(existsSync(entered.specFilePath)).toBe(true);
		});

		it("archives the canonical spec markdown when tracked paths are tampered before exit", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			const tampered = {
				...loadSpecModeState(config),
				specDir: escapedDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tampered, null, 2));

			const archived = exitSpecMode(config);

			expect(archived?.status).toBe("archived");
			expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
				"Status: archived",
			);
		});

		it("does not archive a same-slug spec under the current specs root when stale state came from another specs directory", () => {
			const sharedStateFile = join(testRoot, "shared-state", "spec-state.json");
			const legacyConfig: SpecModeConfig = {
				specsDir: join(testRoot, "legacy-specs"),
				stateFile: sharedStateFile,
			};
			const currentConfig: SpecModeConfig = {
				specsDir: join(testRoot, "current-specs"),
				stateFile: sharedStateFile,
			};

			enterSpecMode({
				name: "Legacy",
				slug: "shared-spec",
				config: legacyConfig,
			});

			const currentSpecDir = join(currentConfig.specsDir, "shared-spec");
			mkdirSync(currentSpecDir, { recursive: true });
			const currentSpecFilePath = join(currentSpecDir, "spec.md");
			const currentBody = [
				"# Spec: Current",
				"",
				"Status: pending",
				"",
				"## Problem",
				"",
				"Keep me.",
				"",
			].join("\n");
			writeFileSync(currentSpecFilePath, currentBody);

			const archived = exitSpecMode(currentConfig);

			expect(archived?.status).toBe("archived");
			expect(readFileSync(currentSpecFilePath, "utf-8")).toBe(currentBody);
		});

		it("throws and leaves spec.md unchanged when saving archive state fails", async () => {
			vi.resetModules();
			const fs = await import("node:fs");
			let isolatedRoot: string | undefined;
			vi.doMock("node:fs", () => ({
				...fs,
				writeFileSync: ((
					path: Parameters<typeof fs.writeFileSync>[0],
					data: Parameters<typeof fs.writeFileSync>[1],
					options?: Parameters<typeof fs.writeFileSync>[2],
				) => {
					if (
						pathTargets(path, "/state/spec-state.json") &&
						typeof data === "string" &&
						data.includes('"status": "archived"')
					) {
						throw new Error("state save failed");
					}
					return fs.writeFileSync(path, data, options);
				}) as typeof fs.writeFileSync,
			}));

			try {
				const specMode = await import("../../src/agent/spec-mode.js");
				isolatedRoot = join(
					tmpdir(),
					`spec-mode-exit-save-fail-${Date.now()}-${Math.random()}`,
				);
				mkdirSync(isolatedRoot, { recursive: true });
				const isolatedConfig = makeConfig(isolatedRoot);

				const entered = specMode.enterSpecMode({
					name: "Add OAuth",
					config: isolatedConfig,
				});
				specMode.approveSpecMode(isolatedConfig);

				expect(() => specMode.exitSpecMode(isolatedConfig)).toThrow(
					/Failed to persist spec mode state during exit/,
				);
				expect(specMode.loadSpecModeState(isolatedConfig)?.status).toBe(
					"approved",
				);
				expect(readFileSync(entered.specFilePath, "utf-8")).toContain(
					"Status: approved",
				);
				expect(readFileSync(entered.specFilePath, "utf-8")).not.toContain(
					"Status: archived",
				);
			} finally {
				if (isolatedRoot && existsSync(isolatedRoot)) {
					rmSync(isolatedRoot, { recursive: true, force: true });
				}
				vi.doUnmock("node:fs");
				vi.resetModules();
			}
		});
	});

	describe("getCurrentSpecPath and readCurrentSpec", () => {
		it("returns the spec path while pending and while approved", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			expect(getCurrentSpecPath(config)).toBe(entered.specFilePath);

			approveSpecMode(config);
			expect(getCurrentSpecPath(config)).toBe(entered.specFilePath);
		});

		it("returns null after archiving", () => {
			enterSpecMode({ name: "Add OAuth", config });
			exitSpecMode(config);

			expect(getCurrentSpecPath(config)).toBeNull();
			expect(readCurrentSpec(config)).toBeNull();
		});

		it("reads the spec body when one is active", () => {
			enterSpecMode({ name: "Add OAuth", config });
			const body = readCurrentSpec(config);

			expect(body).toContain("# Spec: Add OAuth");
		});

		it("returns null when the tracked path points at a sibling spec within the specs directory", () => {
			enterSpecMode({
				name: "Add OAuth",
				slug: "add-oauth",
				config,
			});
			pointTrackedSpecAtSiblingSpec(config);

			expect(getCurrentSpecPath(config)).toBeNull();
			expect(readCurrentSpec(config)).toBeNull();
		});
	});

	describe("listSpecs", () => {
		it("returns the tracked spec annotated with its current status", () => {
			enterSpecMode({ name: "Add OAuth", config });
			const summaries = listSpecs(config);

			expect(summaries).toHaveLength(1);
			expect(summaries[0].status).toBe("pending");
			expect(summaries[0].name).toBe("Add OAuth");
		});

		it("reports specs only on disk (not tracked) as archived", () => {
			const first = enterSpecMode({ name: "First", config });
			exitSpecMode(config);
			enterSpecMode({ name: "Second", config });

			const summaries = listSpecs(config);
			const firstSummary = summaries.find((s) => s.slug === first.slug);
			expect(firstSummary?.status).toBe("archived");
		});

		it("skips symlinked spec directories that point outside the specs tree", () => {
			const tracked = enterSpecMode({ name: "Tracked", config });
			const escapedDir = join(testRoot, "outside-spec");
			mkdirSync(escapedDir, { recursive: true });
			writeFileSync(join(escapedDir, "spec.md"), "# Spec: Outside");
			symlinkSync(escapedDir, join(config.specsDir, "linked-spec"));

			const summaries = listSpecs(config);

			expect(summaries.map((summary) => summary.slug)).toContain(tracked.slug);
			expect(summaries.some((summary) => summary.slug === "linked-spec")).toBe(
				false,
			);
		});

		it("sorts most-recently-updated first", () => {
			enterSpecMode({ name: "First", config });
			exitSpecMode(config);
			enterSpecMode({ name: "Second", config });

			const summaries = listSpecs(config);
			expect(summaries[0].name).toBe("Second");
		});

		it("treats a tracked spec as archived when state.specFilePath escapes the specs directory", () => {
			const entered = enterSpecMode({ name: "Add OAuth", config });
			const escapedDir = join(testRoot, "outside-specs");
			mkdirSync(escapedDir, { recursive: true });
			const tampered = {
				...loadSpecModeState(config),
				specDir: entered.specDir,
				specFilePath: join(escapedDir, "spec.md"),
			};
			writeFileSync(config.stateFile, JSON.stringify(tampered, null, 2));

			const summaries = listSpecs(config);
			expect(summaries).toHaveLength(1);
			expect(summaries[0].status).toBe("archived");
			expect(summaries[0].name).toBeUndefined();
		});

		it("returns an empty list when the specs directory does not exist and no tracked spec", () => {
			expect(listSpecs(config)).toEqual([]);
		});

		it("surfaces the tracked active spec when the specs directory is missing entirely", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			// Delete the whole specs directory to simulate the host filesystem
			// going away mid-session. /spec list should still show the
			// tracked spec so it matches what `isSpecModeActive` reports.
			rmSync(config.specsDir, { recursive: true, force: true });
			expect(existsSync(config.specsDir)).toBe(false);
			const summaries = listSpecs(config);
			expect(summaries.map((s) => s.slug)).toEqual([entered.slug]);
			expect(summaries[0]?.status).toBe("pending");
		});

		it("still surfaces the tracked active spec when its spec.md is missing on disk", () => {
			const entered = enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			// Simulate the spec.md (and its directory) disappearing between
			// state save and the next list call — e.g. someone deleted the
			// directory by hand. The state machine still says we're tracking
			// `oauth` as pending; the list should agree.
			rmSync(entered.specDir, { recursive: true, force: true });

			const summaries = listSpecs(config);
			const active = summaries.find((s) => s.slug === "oauth");
			expect(active).toBeDefined();
			expect(active?.status).toBe("pending");
			expect(active?.name).toBe("Add OAuth");
		});

		it("returns an empty list when the specs path is a file rather than a directory", () => {
			mkdirSync(dirname(config.specsDir), { recursive: true });
			writeFileSync(config.specsDir, "not a directory");

			expect(listSpecs(config)).toEqual([]);
		});

		it("still surfaces the tracked active spec when specs directory enumeration fails", () => {
			enterSpecMode({
				name: "Add OAuth",
				slug: "oauth",
				config,
			});
			rmSync(config.specsDir, { recursive: true, force: true });
			writeFileSync(config.specsDir, "not a directory");

			expect(listSpecs(config)).toEqual([
				expect.objectContaining({
					slug: "oauth",
					status: "pending",
					name: "Add OAuth",
				}),
			]);
		});

		it("skips disk-only specs when statSync on spec.md fails mid-enumeration", async () => {
			vi.resetModules();
			const fs = await import("node:fs");
			let specFileStats = 0;
			let isolatedRoot: string | undefined;
			vi.doMock("node:fs", () => ({
				...fs,
				statSync: ((
					path: Parameters<typeof fs.statSync>[0],
					options?: Parameters<typeof fs.statSync>[1],
				) => {
					if (String(path).endsWith("/spec.md")) {
						specFileStats += 1;
						if (specFileStats === 2) {
							throw new Error("spec disappeared");
						}
					}
					return fs.statSync(path, options);
				}) as typeof fs.statSync,
			}));

			try {
				const specMode = await import("../../src/agent/spec-mode.js");
				isolatedRoot = join(
					tmpdir(),
					`spec-mode-race-${Date.now()}-${Math.random()}`,
				);
				mkdirSync(isolatedRoot, { recursive: true });
				const isolatedConfig = makeConfig(isolatedRoot);

				specMode.enterSpecMode({ name: "First", config: isolatedConfig });
				specMode.exitSpecMode(isolatedConfig);
				specMode.enterSpecMode({ name: "Second", config: isolatedConfig });

				expect(() => specMode.listSpecs(isolatedConfig)).not.toThrow();
			} finally {
				if (isolatedRoot && existsSync(isolatedRoot)) {
					rmSync(isolatedRoot, { recursive: true, force: true });
				}
				vi.doUnmock("node:fs");
				vi.resetModules();
			}
		});
	});

	describe("loadSpecModeState", () => {
		it("returns null when no state file has ever been written", () => {
			expect(loadSpecModeState(config)).toBeNull();
		});

		it("round-trips state through enter → load", () => {
			const entered = enterSpecMode({
				name: "Refactor billing",
				modelId: "claude-opus-4-7",
				config,
			});
			const loaded = loadSpecModeState(config);

			expect(loaded?.slug).toBe(entered.slug);
			expect(loaded?.modelId).toBe("claude-opus-4-7");
		});
	});
});

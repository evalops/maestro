import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaestroAppServerResponseSchema } from "../../packages/contracts/src/maestro-app-server.js";
import {
	createMaestroAppServerSessionApi,
	handleMaestroAppServerRequest,
} from "../../src/app-server/session-api.js";
import { SessionManager } from "../../src/session/manager.js";
import { loadSkills } from "../../src/skills/loader.js";

function writePluginBundle(root: string): string {
	const packageDir = join(root, "vendor", "review-bundle");
	const skillDir = join(packageDir, "skills", "reviewing");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify(
			{
				name: "@test/maestro-review-bundle",
				version: "1.0.0",
				keywords: ["maestro-package"],
				maestro: { skills: ["./skills"] },
			},
			null,
			2,
		),
		"utf8",
	);
	writeFileSync(
		join(skillDir, "SKILL.md"),
		"---\nname: reviewing\ndescription: Review imported through plugin bundle lifecycle.\n---\n\n# Reviewing\n",
		"utf8",
	);
	return packageDir;
}

describe("Maestro app-server plugin bundle lifecycle API", () => {
	let testDir: string;
	let previousMaestroHome: string | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `maestro-app-server-plugin-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		previousMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = join(testDir, "home");
	});

	afterEach(() => {
		if (previousMaestroHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = previousMaestroHome;
		}
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("advertises plugin bundle lifecycle capabilities", () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);

		expect(api.initialize()).toMatchObject({
			capabilities: {
				pluginBundles: true,
			},
		});
	});

	it("installs, lists, loads, and removes a local plugin bundle", async () => {
		const projectRoot = join(testDir, "project");
		const packageDir = writePluginBundle(projectRoot);
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);

		const installed = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "plugin-install",
			method: "pluginBundle/install",
			params: {
				projectRoot,
				scope: "local",
				source: `local:${packageDir}`,
			},
		});
		expect(installed.result).toMatchObject({
			changed: true,
			configPath: join(projectRoot, ".maestro", "config.local.toml"),
			scope: "local",
			source: `local:${packageDir}`,
			message: "Plugin bundle installed",
		});
		expect(Value.Check(MaestroAppServerResponseSchema, installed)).toBe(true);

		const listed = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "plugin-list",
			method: "pluginBundle/list",
			params: { projectRoot },
		});
		expect(listed.result?.bundles).toEqual([
			expect.objectContaining({
				scope: "local",
				source: "../vendor/review-bundle",
			}),
		]);
		expect(listed.result?.resources.skills.project).toEqual(
			expect.arrayContaining([join(packageDir, "skills", "reviewing")]),
		);
		expect(loadSkills(projectRoot, { includeSystem: false }).skills).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "reviewing",
					sourceType: "project",
				}),
			]),
		);

		const duplicatePreview = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "plugin-install-duplicate-dry-run",
			method: "pluginBundle/install",
			params: {
				projectRoot,
				scope: "local",
				dryRun: true,
				source: `local:${packageDir}`,
			},
		});
		expect(duplicatePreview.error).toMatchObject({
			code: -32602,
			message: expect.stringContaining("already exists"),
		});

		const removePreview = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "plugin-remove-dry-run",
			method: "pluginBundle/remove",
			params: {
				projectRoot,
				dryRun: true,
				source: `local:${packageDir}`,
			},
		});
		expect(removePreview.result).toMatchObject({
			changed: false,
			configPath: join(projectRoot, ".maestro", "config.local.toml"),
			scope: "local",
			message: "Plugin bundle removal planned",
		});

		const removed = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "plugin-remove",
			method: "pluginBundle/remove",
			params: {
				projectRoot,
				source: `local:${packageDir}`,
			},
		});
		expect(removed.result).toMatchObject({
			changed: true,
			scope: "local",
		});
		expect(Value.Check(MaestroAppServerResponseSchema, removed)).toBe(true);

		const listedAfterRemove = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "plugin-list-after-remove",
			method: "pluginBundle/list",
			params: { projectRoot },
		});
		expect(listedAfterRemove.result?.bundles).toEqual([]);
	});

	it("previews plugin bundle installs without writing config", async () => {
		const projectRoot = join(testDir, "dry-run-project");
		const packageDir = writePluginBundle(projectRoot);
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "dry-run-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);

		const planned = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "plugin-install-dry-run",
			method: "pluginBundle/install",
			params: {
				projectRoot,
				dryRun: true,
				source: `local:${packageDir}`,
			},
		});

		expect(planned.result).toMatchObject({
			changed: false,
			configPath: join(projectRoot, ".maestro", "config.local.toml"),
			message: "Plugin bundle install planned",
		});
		expect(existsSync(join(projectRoot, ".maestro", "config.local.toml"))).toBe(
			false,
		);
	});

	it("returns invalid params for malformed plugin bundle install sources", async () => {
		const projectRoot = join(testDir, "malformed-source-project");
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "malformed-source-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);

		const rejected = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "plugin-install-malformed-source",
			method: "pluginBundle/install",
			params: {
				projectRoot,
				source: "not a package source",
			},
		});

		expect(rejected.error).toMatchObject({
			code: -32602,
			message: "Invalid package source format: not a package source",
		});
		expect(Value.Check(MaestroAppServerResponseSchema, rejected)).toBe(true);
	});

	it("rejects invalid scopes and missing removal previews", async () => {
		const projectRoot = join(testDir, "invalid-project");
		const packageDir = writePluginBundle(projectRoot);
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "invalid-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);

		const invalidScope = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "plugin-install-invalid-scope",
			method: "pluginBundle/install",
			params: {
				projectRoot,
				scope: "workspace",
				source: `local:${packageDir}`,
			},
		});
		expect(invalidScope.error).toMatchObject({
			code: -32602,
			message: "Invalid plugin bundle scope",
		});

		const missingRemoval = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "plugin-remove-missing-dry-run",
			method: "pluginBundle/remove",
			params: {
				projectRoot,
				dryRun: true,
				source: `local:${packageDir}`,
			},
		});
		expect(missingRemoval.error).toMatchObject({
			code: -32602,
			message: expect.stringContaining("was not found"),
		});
	});
});

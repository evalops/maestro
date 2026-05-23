import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];

function makeFixture() {
	const root = join(
		tmpdir(),
		`maestro-workspace-utils-${process.pid}-${Date.now()}-${fixtures.length}`,
	);
	fixtures.push(root);
	return root;
}

function copyScript(root: string, scriptName: string) {
	mkdirSync(join(root, "scripts"), { recursive: true });
	writeFileSync(
		join(root, "scripts", scriptName),
		readFileSync(join(process.cwd(), "scripts", scriptName), "utf8"),
	);
}

function writePackage(root: string, relativePath: string) {
	const packageDir = join(root, relativePath);
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({ name: relativePath.replaceAll("/", "-") }),
	);
}

function readWorkspacePaths(root: string) {
	const output = execFileSync(process.execPath, ["--input-type=module"], {
		cwd: root,
		encoding: "utf8",
		input: [
			'import { getWorkspacePackagePaths, loadRootPackage } from "./scripts/workspace-utils.js";',
			"console.log(JSON.stringify(await getWorkspacePackagePaths(loadRootPackage())));",
		].join("\n"),
	});
	return JSON.parse(output).sort();
}

describe("getWorkspacePackagePaths", () => {
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("treats ** as zero or more path segments without glob installed", () => {
		const root = makeFixture();
		copyScript(root, "workspace-utils.js");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "fixture",
				type: "module",
				workspaces: ["packages/**/pkg-*"],
			}),
		);
		writePackage(root, "packages/pkg-a");
		writePackage(root, "packages/nested/pkg-b");

		expect(readWorkspacePaths(root)).toEqual([
			realpathSync(resolve(root, "packages/nested/pkg-b/package.json")),
			realpathSync(resolve(root, "packages/pkg-a/package.json")),
		]);
	});

	it("treats brace segments as alternatives without glob installed", () => {
		const root = makeFixture();
		copyScript(root, "workspace-utils.js");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "fixture",
				type: "module",
				workspaces: ["{packages,apps}/*"],
			}),
		);
		writePackage(root, "apps/app-a");
		writePackage(root, "packages/pkg-a");

		expect(readWorkspacePaths(root)).toEqual([
			realpathSync(resolve(root, "apps/app-a/package.json")),
			realpathSync(resolve(root, "packages/pkg-a/package.json")),
		]);
	});

	it("preserves wildcard semantics inside brace alternatives without glob installed", () => {
		const root = makeFixture();
		copyScript(root, "workspace-utils.js");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "fixture",
				type: "module",
				workspaces: ["{packages,pkg-*}/*"],
			}),
		);
		writePackage(root, "packages/pkg-a");
		writePackage(root, "pkg-tools/tool-a");

		expect(readWorkspacePaths(root)).toEqual([
			realpathSync(resolve(root, "packages/pkg-a/package.json")),
			realpathSync(resolve(root, "pkg-tools/tool-a/package.json")),
		]);
	});

	it("treats brace segments as alternatives with wildcards without glob installed", () => {
		const root = makeFixture();
		copyScript(root, "workspace-utils.js");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "fixture",
				type: "module",
				workspaces: ["{packages,apps-*}/*"],
			}),
		);
		writePackage(root, "apps-web/app-a");
		writePackage(root, "packages/pkg-a");

		expect(readWorkspacePaths(root)).toEqual([
			realpathSync(resolve(root, "apps-web/app-a/package.json")),
			realpathSync(resolve(root, "packages/pkg-a/package.json")),
		]);
	});
});

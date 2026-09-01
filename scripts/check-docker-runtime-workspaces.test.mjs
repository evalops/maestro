import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const checker = join(repositoryRoot, "scripts/check-docker-runtime-workspaces.mjs");
const sourceDockerfile = readFileSync(join(repositoryRoot, "Dockerfile"), "utf8");
const runtimeCopy = "COPY packages/runtime-rs ./packages/runtime-rs";

const sourceCargoManifest = readFileSync(join(repositoryRoot, "Cargo.toml"), "utf8");

function runChecker(dockerfile, cargoManifest = sourceCargoManifest) {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "maestro-docker-runtime-"));
	writeFileSync(join(fixtureRoot, "Dockerfile"), dockerfile);
	writeFileSync(join(fixtureRoot, "Cargo.toml"), cargoManifest);
	return execFileSync(process.execPath, [checker], {
		cwd: fixtureRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

test("Docker runtime guard rejects a runtime copy missing from the native stage", () => {
	const firstCopy = sourceDockerfile.indexOf(runtimeCopy);
	const secondCopy = sourceDockerfile.indexOf(runtimeCopy, firstCopy + runtimeCopy.length);
	assert.notEqual(firstCopy, -1, "planner runtime copy fixture");
	assert.notEqual(secondCopy, -1, "native runtime copy fixture");

	const withoutNativeCopy =
		sourceDockerfile.slice(0, secondCopy) + sourceDockerfile.slice(secondCopy + runtimeCopy.length);
	const duplicatedPlannerCopy = withoutNativeCopy.replace(
		runtimeCopy,
		`${runtimeCopy}\n${runtimeCopy}`,
	);

	assert.throws(
		() => runChecker(duplicatedPlannerCopy),
		(error) => {
			assert.equal(error.status, 1);
			assert.match(
				`${error.stdout}\n${error.stderr}`,
				/native runtime boundary crate in native Docker stage/,
			);
			return true;
		},
	);
});

test("Docker runtime guard accepts the checked-in Dockerfile and workspace", () => {
	const output = runChecker(sourceDockerfile);
	assert.match(output, /Verified native-only Docker runtime contract\./);
});

test("Docker runtime guard rejects a workspace member no stage copies", () => {
	const ledgerCopy = "COPY packages/a2a-ledger-rs ./packages/a2a-ledger-rs";
	assert.ok(
		sourceDockerfile.includes(ledgerCopy),
		"the checked-in Dockerfile copies the ledger crate",
	);

	assert.throws(
		() => runChecker(sourceDockerfile.replaceAll(`${ledgerCopy}\n`, "")),
		(error) => {
			assert.equal(error.status, 1);
			assert.match(
				`${error.stdout}\n${error.stderr}`,
				/does not copy every Cargo workspace member: packages\/a2a-ledger-rs in the planner stage, packages\/a2a-ledger-rs in the native stage/,
			);
			return true;
		},
	);
});

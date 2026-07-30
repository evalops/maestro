import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const versionBumpWorkflow = readFileSync(
	new URL("../.github/workflows/version-bump.yml", import.meta.url),
	"utf8",
);
const versionScript = fileURLToPath(new URL("./version.js", import.meta.url));

function writeFixtureFile(root, path, content) {
	const destination = join(root, path);
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, content);
}

function createFixture({ version = "1.2.3", lockHasMaestro = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), "maestro-version-test-"));
	writeFixtureFile(
		root,
		"package.json",
		`${JSON.stringify({ name: "@evalops/maestro", version }, null, "\t")}\n`,
	);
	writeFixtureFile(
		root,
		"packages/maestro-rs/Cargo.toml",
		`[package]\nname = "maestro"\nversion = "${version}"\n`,
	);
	writeFixtureFile(
		root,
		"Cargo.lock",
		lockHasMaestro
			? `[[package]]\nname = "maestro"\nversion = "${version}"\n`
			: '[[package]]\nname = "some-other-package"\nversion = "9.9.9"\n',
	);
	return root;
}

function runSet(root, version) {
	return spawnSync(process.execPath, [versionScript, "set", version], {
		cwd: root,
		encoding: "utf8",
	});
}

function readFixtureFile(root, path) {
	return readFileSync(join(root, path), "utf8");
}

test("set accepts Rust version files that already contain the requested version", (t) => {
	const root = createFixture();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const result = runSet(root, "1.2.3");
	assert.equal(result.status, 0, result.stderr);
	assert.match(readFixtureFile(root, "Cargo.lock"), /version = "1\.2\.3"/u);
});

test("set continues to update Rust version files when the version differs", (t) => {
	const root = createFixture();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const result = runSet(root, "1.2.4");
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		readFixtureFile(root, "packages/maestro-rs/Cargo.toml"),
		/version = "1\.2\.4"/u,
	);
	assert.match(readFixtureFile(root, "Cargo.lock"), /version = "1\.2\.4"/u);
});

test("set fails on a missing Rust package entry and rolls back earlier writes", (t) => {
	const root = createFixture({ lockHasMaestro: false });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const originalPackage = readFixtureFile(root, "package.json");
	const originalManifest = readFixtureFile(
		root,
		"packages/maestro-rs/Cargo.toml",
	);
	const result = runSet(root, "1.2.4");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Unable to update Rust package version/u);
	assert.equal(readFixtureFile(root, "package.json"), originalPackage);
	assert.equal(
		readFixtureFile(root, "packages/maestro-rs/Cargo.toml"),
		originalManifest,
	);
});

test("version-bump installs clippy before running release lint", () => {
	assert.match(
		versionBumpWorkflow,
		/uses: \.\/\.github\/actions\/setup-rust\n\s+with: \{ toolchain: stable, components: "rustfmt,clippy" \}/u,
	);
	assert.match(
		versionBumpWorkflow,
		/name: Run release commit validators[\s\S]*?npm run lint/u,
	);
});

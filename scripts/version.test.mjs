import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const versionBumpWorkflow = readFileSync(
	new URL("../.github/workflows/version-bump.yml", import.meta.url),
	"utf8",
);
const versionBumpBranchStep =
	versionBumpWorkflow.match(
		/- id: branch[\s\S]*?(?=\n {6}- name: Prepare versioned files)/u,
	)?.[0] ?? "";
const versionBumpBranchScript =
	versionBumpBranchStep
		.match(/run: \|\n(?<script>(?: {10}.*\n?)+)$/u)
		?.groups?.script.replace(/^ {10}/gmu, "") ?? "";
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

function runBranchDetection(t, mode) {
	const root = mkdtempSync(join(tmpdir(), "maestro-branch-detection-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const fakeGit = join(bin, "git");
	writeFileSync(
		fakeGit,
		`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" != "ls-remote --heads origin refs/heads/\${RELEASE_BRANCH}" ]]; then
  echo "unexpected git arguments: $*" >&2
  exit 97
fi
case "$FAKE_LS_REMOTE_MODE" in
  existing)
    printf '0123456789abcdef0123456789abcdef01234567\\trefs/heads/%s\\n' "$RELEASE_BRANCH"
    ;;
  absent)
    exit 0
    ;;
  failure)
    echo "simulated release-branch authentication failure" >&2
    exit 128
    ;;
  *)
    echo "unexpected fake-git mode: $FAKE_LS_REMOTE_MODE" >&2
    exit 98
    ;;
esac
`,
	);
	chmodSync(fakeGit, 0o755);
	const outputPath = join(root, "github-output");
	const env = {
		...process.env,
		FAKE_LS_REMOTE_MODE: mode,
		GITHUB_OUTPUT: outputPath,
		PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
		RELEASE_BRANCH: "release/v9.9.9",
	};
	const bashArgs = ["--noprofile", "--norc", "-c"];
	const resolvedGit = spawnSync("bash", [...bashArgs, "command -v git"], {
		encoding: "utf8",
		env,
	});
	assert.equal(resolvedGit.status, 0, resolvedGit.stderr);
	assert.equal(resolvedGit.stdout.trim(), fakeGit);
	const result = spawnSync("bash", [...bashArgs, versionBumpBranchScript], {
		encoding: "utf8",
		env,
	});
	const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
	return { output, result };
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

test("version-bump release branch detection is exact and fails closed", () => {
	assert.match(
		versionBumpBranchStep,
		/if ! remote_ref="\$\(git ls-remote --heads origin "refs\/heads\/\$\{RELEASE_BRANCH\}"\)"; then[\s\S]*?::error::Failed to query release branch \$RELEASE_BRANCH from origin\.[\s\S]*?exit 1/u,
		"a remote or authentication failure must stop the release instead of looking absent",
	);
	assert.match(
		versionBumpBranchStep,
		/if \[\[ -n "\$remote_ref" \]\]; then\s+echo "exists=true" >> "\$GITHUB_OUTPUT"\s+else\s+echo "exists=false" >> "\$GITHUB_OUTPUT"/u,
		"a successful exact-ref lookup must distinguish existing output from an absent empty result",
	);
	assert.doesNotMatch(
		versionBumpBranchStep,
		/ls-remote --exit-code|ls-remote[\s\S]*?2>&1/u,
		"branch detection must not collapse an absent ref and a failed lookup into the same path",
	);
});

test("version-bump release branch detection executes all remote outcomes", (t) => {
	const existing = runBranchDetection(t, "existing");
	assert.equal(existing.result.status, 0, existing.result.stderr);
	assert.equal(
		existing.output,
		"exists=true\n",
		`${existing.result.stdout}\n${existing.result.stderr}`,
	);

	const absent = runBranchDetection(t, "absent");
	assert.equal(absent.result.status, 0, absent.result.stderr);
	assert.equal(absent.output, "exists=false\n");

	const failure = runBranchDetection(t, "failure");
	assert.notEqual(failure.result.status, 0);
	assert.equal(
		failure.output,
		"",
		"a failed remote lookup must not emit either branch-existence value",
	);
	assert.match(
		failure.result.stderr,
		/simulated release-branch authentication failure/u,
	);
	assert.match(
		failure.result.stdout,
		/::error::Failed to query release branch release\/v9\.9\.9 from origin\./u,
	);
});

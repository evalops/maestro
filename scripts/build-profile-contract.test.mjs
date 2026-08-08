import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const packageJson = JSON.parse(read("package.json"));
const cargo = read("Cargo.toml");
const materialize = read("scripts/materialize-native-package.mjs");
const releaseBuilder = read("scripts/build-release-binary.mjs");
const dockerfile = read("Dockerfile");
const ci = read(".github/workflows/ci.yml");
const release = read(".github/workflows/release.yml");
const ghcr = read(".github/workflows/ghcr-publish.yml");
const mirror = read(".github/workflows/public-release-mirror.yml");

test("fast validation and distribution profiles have distinct optimization contracts", () => {
	assert.match(cargo, /\[profile\.fast-validation\][\s\S]*?lto = false[\s\S]*?codegen-units = 16/);
	assert.match(cargo, /\[profile\.release\][\s\S]*?lto = "thin"[\s\S]*?codegen-units = 1/);
	assert.match(cargo, /\[profile\.release-dist\][\s\S]*?lto = "thin"[\s\S]*?codegen-units = 1/);
});

test("PR build selects fast-validation and materializes its profile output", () => {
	assert.match(packageJson.scripts.build, /--profile fast-validation/);
	assert.match(packageJson.scripts.build, /materialize-native-package\.mjs --profile fast-validation/);
	assert.match(ci, /- run: npm run build\n\s+- run: npm run smoke:release-native-only/);
	assert.match(materialize, /const profileIndex = process\.argv\.indexOf\("--profile"\)/);
	assert.match(materialize, /resolve\(\s*"target",\s*profile/);
});

test("release and container entrypoints select optimized release", () => {
	assert.match(packageJson.scripts["build:release"], /--profile release/);
	assert.match(packageJson.scripts["release:check"], /build:release/);
	assert.match(releaseBuilder, /profile: "release"/);
	assert.match(releaseBuilder, /"--profile"[\s\S]*?options\.profile/);
	assert.match(releaseBuilder, /target\/\$\{target\}\/\$\{options\.profile\}/);
	assert.match(dockerfile, /cargo chef prepare --recipe-path recipe\.json/);
	assert.match(dockerfile, /cargo chef cook --release --locked -p maestro/);
	assert.match(dockerfile, /cargo build --release --locked -p maestro/);
	assert.match(dockerfile, /target\/release\/maestro/);
	assert.match(
		ghcr,
		/cancel-in-progress: \$\{\{ github\.event_name != 'workflow_dispatch' \}\}/,
	);
	assert.match(ghcr, /docker\/build-push-action/);
	assert.match(mirror, /npm run build:release/);
	assert.match(release, /build-release-binary\.mjs --platform/);
});

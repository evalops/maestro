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
const runtimeConformance = read("scripts/run-runtime-conformance.mjs");
const passport = read("scripts/generate-runtime-passport.mjs");

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

test("release artifacts are proven by exact-runtime conformance and passports", () => {
	assert.match(runtimeConformance, /--docker-image/);
	assert.match(runtimeConformance, /--binary-launcher/);
	assert.match(runtimeConformance, /approval_request_and_resolution/);
	assert.match(runtimeConformance, /drain_terminal_receipt/);
	assert.match(runtimeConformance, /CONFORMANCE_FIXTURE/);
	assert.match(runtimeConformance, /runtime-conformance-v1\.json/);
	assert.match(runtimeConformance, /FETCH_TIMEOUT_MS/);
	assert.match(runtimeConformance, /--artifact-digest/);
	assert.match(passport, /runtime-passport\.v1/);
	assert.match(release, /Conformance against the exact native release artifact/);
	assert.match(release, /Conformance against the exact release binary/);
	assert.match(release, /host_arch.*uname -m/);
	assert.match(release, /runtime-passport-maestro-\$\{platform\}\.cosign\.bundle/);
	assert.match(ghcr, /Conformance against the exact OCI release artifact/);
	assert.match(ghcr, /push: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/);
	assert.match(ghcr, /load: \$\{\{ github\.event_name == 'push' \}\}/);
	assert.match(ghcr, /conformance-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
	assert.match(ghcr, /IMAGE: \$\{\{ env\.IMAGE_NAME \}\}@\$\{\{ steps\.conformance-image\.outputs\.digest \}\}/);
	assert.match(ghcr, /--docker-image "\$IMAGE"/);
	assert.match(ghcr, /Publish isolated conformance image/);
	assert.match(ghcr, /timeout --signal=TERM --kill-after=30s 10m docker push "\$IMAGE_TAG"/);
	assert.match(ghcr, /pushed_digest.*EXPECTED_DIGEST/);
	assert.doesNotMatch(ghcr, /for \(index = 1; index <= NF; index \+= 1\)/);
	assert.match(ghcr, /for \(field_index = 1; field_index <= NF; field_index \+= 1\)/);
	assert.match(ghcr, /Remove isolated conformance image/);
	assert.match(ghcr, /always\(\).*github\.event_name == 'push'/);
	assert.match(ghcr, /PUSH_MARKER/);
	assert.match(ghcr, /touch "\$PUSH_MARKER"/);
	assert.match(ghcr, /gh api "orgs\/\$\{package_owner\}\/packages\/container\/\$\{package_name\}\/versions\?per_page=100"/);
	assert.match(ghcr, /packages\/container\/\$\{package_name\}\/versions/);
	assert.match(ghcr, /\[\.\[\] \| select\(\(\.metadata\.container\.tags/);
	assert.doesNotMatch(ghcr, /\[\.\[\]\[\] \| select\(\(\.metadata\.container\.tags/);
	assert.match(ghcr, /gh api --method DELETE/);
	assert.match(ghcr, /refusing to delete .*also carries/);
	const conformanceIndex = ghcr.indexOf("- name: Conformance against the exact OCI release artifact");
	const isolatedConformanceIndex = ghcr.indexOf("- name: Publish isolated conformance image");
	const cleanupIndex = ghcr.indexOf("- name: Remove isolated conformance image");
	const publishIndex = ghcr.indexOf("- name: Publish verified image tags");
	const signIndex = ghcr.indexOf("- name: Sign image with cosign");
	assert(conformanceIndex >= 0 && conformanceIndex < publishIndex);
	assert(isolatedConformanceIndex >= 0 && isolatedConformanceIndex < conformanceIndex);
	assert(conformanceIndex < cleanupIndex && cleanupIndex < publishIndex);
	assert(publishIndex < signIndex);
	assert.match(ghcr, /timeout --signal=TERM --kill-after=30s 10m docker push/);
	assert.match(ghcr, /maestro-runtime-passport\/v1/);
});

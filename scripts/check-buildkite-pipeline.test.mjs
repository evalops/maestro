import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const pipeline = await readFile(new URL(".buildkite/pipeline.yml", root), "utf8");
const advisory = await readFile(new URL(".buildkite/advisory.yml", root), "utf8");
const nextest = await readFile(new URL(".config/nextest.toml", root), "utf8");
const tooling = await readFile(new URL("scripts/run-buildkite-ci-tooling.sh", root), "utf8");
const jetbrains = await readFile(new URL("scripts/run-buildkite-jetbrains.sh", root), "utf8");
const coverage = await readFile(new URL("scripts/run-buildkite-coverage.sh", root), "utf8");

test("Buildkite routes jobs through the configured Maestro worker pool", () => {
  assert.match(pipeline, /queue: "\$\{MAESTRO_CI_QUEUE:-hetzner-linux-medium\}"/);
  assert.match(pipeline, /image: "\$\{MAESTRO_CI_IMAGE:-evalops-platform-ci-v3\}"/);
  assert.match(pipeline, /queue: "\$\{MAESTRO_CI_JETBRAINS_QUEUE:-hetzner-linux-heavy\}"/);
  assert.match(pipeline, /image: "\$\{MAESTRO_CI_JETBRAINS_IMAGE:-evalops-platform-ci-v3\}"/);
});

test("Buildkite bounds shared worker concurrency and infrastructure retries", () => {
	assert.equal(
		pipeline.match(/priority: 50/gu)?.length,
		9,
		"required repository validation lanes should outrank advisory and stale default-priority work",
	);
  assert.equal((pipeline.match(/concurrency: 3/g) ?? []).length, 9);
  assert.equal((pipeline.match(/MAESTRO_CI_CONCURRENCY_GROUP/g) ?? []).length, 8);
  assert.equal((pipeline.match(/MAESTRO_CI_JETBRAINS_CONCURRENCY_GROUP/g) ?? []).length, 1);
  assert.equal((pipeline.match(/MAESTRO_CI_ADVISORY_CONCURRENCY_GROUP/g) ?? []).length, 0);
  assert.equal((advisory.match(/MAESTRO_CI_ADVISORY_CONCURRENCY_GROUP/g) ?? []).length, 2);
  assert.equal((pipeline.match(/exit_status: -1/g) ?? []).length, 9);
  assert.equal((pipeline.match(/signal_reason: none/g) ?? []).length, 9);
  assert.equal((pipeline.match(/signal_reason: agent_stop/g) ?? []).length, 9);
  assert.equal((advisory.match(/exit_status: -1/g) ?? []).length, 2);
  assert.equal((advisory.match(/signal_reason: none/g) ?? []).length, 2);
  assert.equal((advisory.match(/signal_reason: agent_stop/g) ?? []).length, 2);
  assert.doesNotMatch(pipeline, /exit_status: "\*"/);
});

test("Buildkite network and long-running operations are bounded", () => {
  assert.equal((pipeline.match(/5m npm ci --ignore-scripts/g) ?? []).length, 4);
  assert.match(pipeline, /npm_config_fetch_retries: "1"/);
  assert.match(pipeline, /npm_config_fetch_timeout: "30000"/);
  assert.equal((pipeline.match(/2m docker pull/g) ?? []).length, 2);
  for (const command of [
    "45m npm run check",
    "30m npm run lint",
    "45m cargo nextest run --profile buildkite --workspace --locked --no-fail-fast",
    "20m cargo test --workspace --locked --doc",
    "30m cargo build --locked -p maestro-tui",
    "45m npm run build",
    "30m cargo test --locked -p maestro-runtime-gateway",
    "30m cargo test --locked -p maestro-tui --test tools_integration",
    "30m cargo build --locked -p maestro-scenario",
  ]) {
    assert.match(pipeline, new RegExp(command.replaceAll("-", "\\-")));
  }
});

test("advisory coverage uses nextest and an isolated instrumented target dir", () => {
  assert.match(coverage, /CARGO_TARGET_DIR="\$\{repo_root\}\/\.buildkite\/cache\/cargo-target-cov"/);
  assert.match(coverage, /cargo llvm-cov nextest/);
  assert.match(coverage, /--lib/);
  assert.match(coverage, /--no-clean/);
  assert.match(coverage, /--ignore-run-fail/);
  assert.match(coverage, /--profile buildkite/);
  assert.match(
    coverage,
    /cargo-llvm-cov-x86_64-unknown-linux-gnu\.tar\.gz/,
  );
  assert.match(
    coverage,
    /b068f7c98841aacb9c4f382b4a0c184ae82f49b56a32d442b429b2961c73be15/,
  );
  assert.doesNotMatch(coverage, /cargo install cargo-llvm-cov/);
  assert.doesNotMatch(coverage, /cargo llvm-cov --workspace --locked --no-report/);
  assert.doesNotMatch(coverage, /--html/);
});

test("advisory coverage and perf are not in the default pipeline", () => {
  assert.doesNotMatch(pipeline, /key: "coverage"/);
  assert.doesNotMatch(pipeline, /key: "perf-baseline"/);
  assert.match(pipeline, /key: "advisory-upload"/);
  assert.match(pipeline, /soft_fail: true/);
  assert.match(
    pipeline,
    /BUILDKITE_SOURCE\}" == "schedule" && -f \.buildkite\/advisory\.yml[\s\S]*pipeline upload \.buildkite\/advisory\.yml/,
  );
  assert.match(advisory, /queue: "\$\{MAESTRO_CI_QUEUE:-hetzner-linux-medium\}"/);
  assert.match(advisory, /image: "\$\{MAESTRO_CI_IMAGE:-evalops-platform-ci-v3\}"/);
  assert.match(advisory, /CARGO_TARGET_DIR: "\.buildkite\/cache\/cargo-target"/);
  assert.match(advisory, /key: "coverage"[\s\S]*priority: 10/);
  assert.match(advisory, /key: "perf-baseline"[\s\S]*priority: 10/);
  assert.doesNotMatch(advisory, /^\s*if:/mu);
});

test("Buildkite covers every migrated validation family", () => {
  for (const key of [
    "lint", "rust-tests", "native-release", "integration", "scenario-replay",
    "ci-contracts", "workflow-tooling", "supply-chain", "jetbrains-plugin",
    "advisory-upload",
  ]) {
    assert.match(pipeline, new RegExp(`key: "${key}"`));
  }
  for (const key of ["coverage", "perf-baseline"]) {
    assert.match(advisory, new RegExp(`key: "${key}"`));
  }
  for (const script of ["ci-tooling", "supply-chain", "jetbrains"]) {
    assert.match(pipeline, new RegExp(`scripts/run-buildkite-${script}\\.sh`));
  }
  for (const script of ["coverage", "perf"]) {
    assert.match(advisory, new RegExp(`scripts/run-buildkite-${script}\\.sh`));
  }
});

test("workflow tooling installs pinned binaries without requiring Go", () => {
  assert.doesNotMatch(tooling, /go install/);
  assert.match(tooling, /actionlint_1\.7\.9_\$\{actionlint_platform\}\.tar\.gz/);
  assert.match(tooling, /233b280d05e100837f4af1433c7b40a5dcb306e3aa68fb4f17f8a7f45a7df7b4/);
  assert.match(tooling, /sha256sum --check --status/);
  assert.match(tooling, /shasum -a 256 --check --status/);
  assert.match(tooling, /! -f \.github\/workflows\/sync-public-release-mirror\.yml/);
});

test("JetBrains validation fails fast and retries only its stuck-JVM exit", () => {
  assert.match(pipeline, /key: "jetbrains-plugin"[\s\S]*exit_status: 137[\s\S]*limit: 1/);
  assert.match(jetbrains, /10m \\\n\s+\.\/gradlew check buildPlugin --no-daemon -Dorg\.gradle\.jvmargs=/);
});

test("internal-only contracts are conditional in the shared public pipeline", () => {
  assert.match(pipeline, /if \[\[ -d test\/internal \]\]; then\n\s+npm run test:internal\n\s+fi/);
  assert.match(pipeline, /if \[\[ -f scripts\/measure-ci-build-latency\.test\.mjs \]\]; then/);
});

test("public projections skip the internal mirror workflow contract", () => {
  assert.match(
    tooling,
    /check-sync-public-release-mirror-workflow\.test\.mjs[\s\S]*?\.github\/workflows\/sync-public-release-mirror\.yml/,
  );
});

test("Rust validation uses the pinned canonical nextest split", () => {
  assert.match(pipeline, /nextest_version="0\.9\.143"/);
  assert.match(pipeline, /66786b9abe23920d022a182d1416b1bbc8130dd4872a9553d76985a1708dcd1e/);
  assert.match(pipeline, /cargo nextest run --profile buildkite --workspace --locked --no-fail-fast/);
  assert.match(pipeline, /cargo test --workspace --locked --doc/);
  assert.match(nextest, /filter = 'binary\(pty_e2e\)'/);
  assert.match(nextest, /test-group = 'pty-e2e'/);
  assert.match(nextest, /\[test-groups\.pty-e2e\]\nmax-threads = 1/);
});

test("integration containers are removed by their actual names", () => {
  assert.match(pipeline, /trap 'docker rm -f "\$\$redis" "\$\$postgres"/);
});

test("legacy GitHub validation workflows are absent", async () => {
  const names = [
    "actionlint.yml", "ci.yml", "coverage.yml", "evals.yml", "hooks.yml",
    "integration.yml", "jetbrains-plugin.yml", "perf-baselines.yml",
    "required-checks-invariant.yml", "scenario-replay.yml", "shellcheck.yml",
    "supply-chain.yml",
  ];
  for (const name of names) {
    await assert.rejects(access(new URL(`.github/workflows/${name}`, root)));
  }
});

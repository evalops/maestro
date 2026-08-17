import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const pipeline = await readFile(new URL(".buildkite/pipeline.yml", root), "utf8");
const nextest = await readFile(new URL(".config/nextest.toml", root), "utf8");
const tooling = await readFile(new URL("scripts/run-buildkite-ci-tooling.sh", root), "utf8");
const jetbrains = await readFile(new URL("scripts/run-buildkite-jetbrains.sh", root), "utf8");

test("Buildkite routes jobs through the configured Maestro worker pool", () => {
  assert.match(pipeline, /queue: "\$\{MAESTRO_CI_QUEUE:-hetzner-linux-heavy\}"/);
  assert.match(pipeline, /image: "\$\{MAESTRO_CI_IMAGE:-evalops-platform-ci-v6\}"/);
  assert.match(pipeline, /queue: "\$\{MAESTRO_CI_JETBRAINS_QUEUE:-hetzner-linux-heavy\}"/);
  assert.match(pipeline, /image: "\$\{MAESTRO_CI_JETBRAINS_IMAGE:-evalops-platform-ci-v6\}"/);
  assert.doesNotMatch(pipeline, /hetzner-linux-medium/);
});

test("Buildkite bounds shared worker concurrency and infrastructure retries", () => {
	assert.equal(
		pipeline.match(/priority: 50/gu)?.length,
		11,
		"all repository validation lanes should outrank stale default-priority work",
	);
  assert.equal((pipeline.match(/concurrency: 3/g) ?? []).length, 11);
  assert.equal((pipeline.match(/MAESTRO_CI_CONCURRENCY_GROUP/g) ?? []).length, 10);
  assert.equal((pipeline.match(/MAESTRO_CI_JETBRAINS_CONCURRENCY_GROUP/g) ?? []).length, 1);
  assert.equal((pipeline.match(/exit_status: -1/g) ?? []).length, 11);
  assert.equal((pipeline.match(/signal_reason: none/g) ?? []).length, 11);
  assert.equal((pipeline.match(/signal_reason: agent_stop/g) ?? []).length, 11);
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

test("Buildkite covers every migrated validation family", () => {
  for (const key of [
    "lint", "rust-tests", "native-release", "integration", "scenario-replay",
    "ci-contracts", "workflow-tooling", "supply-chain", "jetbrains-plugin",
    "coverage", "perf-baseline",
  ]) {
    assert.match(pipeline, new RegExp(`key: "${key}"`));
  }
  for (const script of ["ci-tooling", "supply-chain", "jetbrains", "coverage", "perf"]) {
    assert.match(pipeline, new RegExp(`scripts/run-buildkite-${script}\\.sh`));
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
  assert.match(jetbrains, /10m \.\/gradlew check buildPlugin --no-daemon/);
});

test("internal-only contracts are conditional in the shared public pipeline", () => {
  assert.match(pipeline, /if \[\[ -d test\/internal \]\]; then\n\s+npm run test:internal\n\s+fi/);
  assert.match(pipeline, /if \[\[ -f scripts\/measure-ci-build-latency\.test\.mjs \]\]; then/);
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

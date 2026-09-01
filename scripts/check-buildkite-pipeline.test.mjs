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
const miseRunner = await readFile(new URL(".buildkite/run-with-mise", root), "utf8");
const a2aTmuxSmoke = await readFile(new URL("scripts/smoke-maestro-a2a-tmux.sh", root), "utf8");

test("Buildkite routes jobs through the configured Maestro worker pool", () => {
  assert.match(pipeline, /queue: "\$\{MAESTRO_CI_QUEUE:-hetzner-linux-heavy\}"/);
  assert.match(pipeline, /image: "\$\{MAESTRO_CI_IMAGE:-evalops-platform-ci-v6\}"/);
  assert.match(pipeline, /queue: "\$\{MAESTRO_CI_JETBRAINS_QUEUE:-hetzner-linux-heavy\}"/);
  assert.match(pipeline, /image: "\$\{MAESTRO_CI_JETBRAINS_IMAGE:-evalops-platform-ci-v6\}"/);
  assert.match(pipeline, /queue: "\$\{MAESTRO_CI_INTEGRATION_QUEUE:-linux-medium\}"/);
  assert.match(pipeline, /image: "\$\{MAESTRO_CI_INTEGRATION_IMAGE:-evalops-platform-ci-v6\}"/);
});

test("Rust lanes bootstrap the pinned toolchain before invoking Cargo", () => {
	assert.equal((pipeline.match(/\.buildkite\/run-with-mise "rust@1\.95\.0"/g) ?? []).length, 5);
	assert.equal(
		(pipeline.match(/\.buildkite\/run-with-mise "rust@1\.95\.0 gh@2\.88\.1"/g) ?? []).length,
		1,
	);
  assert.match(miseRunner, /mise_version="2026\.4\.24"/);
  assert.match(miseRunner, /4ecf49b825741e1e3e8ff8c92ee242cf728da951d1b3592ef1c2f080201fa454/);
  assert.match(miseRunner, /sha256sum --check --status/);
  assert.match(miseRunner, /exec "\$\{tools\[@\]\}" -- "\$@"/);
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
  assert.equal((pipeline.match(/exit_status: -1/g) ?? []).length, 10);
  assert.equal((pipeline.match(/signal_reason: none/g) ?? []).length, 10);
  assert.equal((pipeline.match(/signal_reason: agent_stop/g) ?? []).length, 10);
  assert.equal((advisory.match(/exit_status: -1/g) ?? []).length, 2);
  assert.equal((advisory.match(/signal_reason: none/g) ?? []).length, 2);
  assert.equal((advisory.match(/signal_reason: agent_stop/g) ?? []).length, 2);
  assert.doesNotMatch(pipeline, /exit_status: "\*"/);
});

test("Buildkite network and long-running operations are bounded", () => {
  assert.equal((pipeline.match(/5m npm ci --ignore-scripts/g) ?? []).length, 5);
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

test("Buildkite publishes only the offline machine-auth contract", () => {
  assert.doesNotMatch(
    pipeline,
    /live exchange remains disabled|Identity owns|durable replay store/,
  );
});

test("advisory coverage uses nextest and an isolated instrumented target dir", () => {
  assert.match(coverage, /CARGO_TARGET_DIR="\$\{repo_root\}\/\.buildkite\/cache\/cargo-target-cov"/);
  assert.match(coverage, /cargo llvm-cov nextest/);
  assert.match(coverage, /--lib/);
  assert.match(coverage, /--no-clean/);
  assert.doesNotMatch(coverage, /llvm-cov nextest[\s\S]*--no-report/);
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
  assert.match(advisory, /queue: "\$\{MAESTRO_CI_QUEUE:-hetzner-linux-heavy\}"/);
  assert.match(advisory, /image: "\$\{MAESTRO_CI_IMAGE:-evalops-platform-ci-v6\}"/);
  assert.match(advisory, /CARGO_TARGET_DIR: "\.buildkite\/cache\/cargo-target"/);
  assert.match(advisory, /key: "coverage"[\s\S]*priority: 10/);
  assert.match(advisory, /key: "perf-baseline"[\s\S]*priority: 10/);
  assert.doesNotMatch(advisory, /^\s*if:/mu);
});

test("Buildkite covers every migrated validation family", () => {
  for (const key of [
    "protocol-contracts", "lint", "rust-tests", "native-release", "integration",
    "scenario-replay", "ci-contracts", "workflow-tooling", "supply-chain",
    "jetbrains-plugin", "advisory-upload",
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
  assert.match(jetbrains, /10m \\\n\s+\.\/gradlew check buildPlugin --no-daemon \\/);
  assert.match(jetbrains, /org\.gradle\.workers\.max=1/);
  assert.match(
    jetbrains,
    /org\.gradle\.jvmargs="-Xmx1g -XX:MaxMetaspaceSize=256m -XX:\+ExitOnOutOfMemoryError"/,
  );
});

test("protocol lock fails the build before heavy jobs start", () => {
  assert.match(pipeline, /key: "protocol-contracts"/);
  assert.match(pipeline, /npm run check:protocol-manifest/);
  assert.equal((pipeline.match(/depends_on: "protocol-contracts"/g) ?? []).length, 4);
});

test("protocol lock does not share the rust-tests Hetzner queue", () => {
  const lock = pipeline.split('key: "protocol-contracts"')[1]?.split('key: "')[0] ?? "";
  const rust = pipeline.split('key: "rust-tests"')[1]?.split('key: "')[0] ?? "";
  assert.match(lock, /queue: "\$\{MAESTRO_CI_PROTOCOL_QUEUE:-linux-medium\}"/);
  assert.match(lock, /image: "\$\{MAESTRO_CI_PROTOCOL_IMAGE:-evalops-platform-ci-v6\}"/);
  assert.match(rust, /queue: "\$\{MAESTRO_CI_QUEUE:-hetzner-linux-heavy\}"/);
  assert.doesNotMatch(lock, /queue: "\$\{MAESTRO_CI_QUEUE:-hetzner-linux-heavy\}"/);
});

test("rust-tests caps compile jobs and retries OOM SIGKILL", () => {
  assert.match(pipeline, /key: "rust-tests"[\s\S]*?CARGO_BUILD_JOBS: "4"/);
  assert.match(pipeline, /key: "rust-tests"[\s\S]*?exit_status: 137/);
});

test("CI caps rustc codegen units so one crate cannot SIGKILL the worker", () => {
  assert.match(pipeline, /CARGO_PROFILE_DEV_CODEGEN_UNITS: "16"/);
  assert.match(pipeline, /CARGO_PROFILE_TEST_CODEGEN_UNITS: "16"/);
  assert.match(advisory, /CARGO_PROFILE_DEV_CODEGEN_UNITS: "16"/);
  assert.match(advisory, /CARGO_PROFILE_TEST_CODEGEN_UNITS: "16"/);
  assert.match(pipeline, /CARGO_BUILD_JOBS: "4"/);
  assert.match(pipeline, /key: "lint"[\s\S]*?exit_status: 137/);
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

test("tag-release contract stays green when the public tree omits public-release-mirror.yml", async () => {
  const contract = await readFile(new URL("scripts/tag-release-contract.test.mjs", root), "utf8");
  assert.match(contract, /existsSync\(/);
  assert.match(contract, /public-release-mirror\.yml/);
  assert.match(contract, /dispatch-public-release:/);
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

test("rust-tests explicitly proves CI machine auth fails closed without privileged tokens", () => {
  const rust = pipeline.split('key: "rust-tests"')[1]?.split('key: "')[0] ?? "";
  assert.match(rust, /cargo test --locked -p maestro-tui ci_auth_conformance/);
  assert.doesNotMatch(rust, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
});

test("integration containers are removed by their actual names", () => {
  assert.match(pipeline, /trap 'docker rm -f "\$\$redis" "\$\$postgres"/);
});

test("Docker integration and supply-chain checks select their required runtimes", () => {
  const integration = pipeline.split('key: "integration"')[1]?.split('key: "')[0] ?? "";
  const integrationAgents = integration.split("agents:")[1]?.split("cache:")[0] ?? "";
  const supplyChain = pipeline.split('key: "supply-chain"')[1]?.split('key: "')[0] ?? "";
  assert.match(integration, /queue: "\$\{MAESTRO_CI_INTEGRATION_QUEUE:-linux-medium\}"/);
  assert.doesNotMatch(integration, /queue: "\$\{MAESTRO_CI_QUEUE:-hetzner-linux-heavy\}"/);
  assert.doesNotMatch(integrationAgents, /#/);
  assert.match(integration, /docker pull/);
  assert.match(supplyChain, /queue: "\$\{MAESTRO_CI_SUPPLY_CHAIN_QUEUE:-linux-medium\}"/);
  assert.match(supplyChain, /image: "\$\{MAESTRO_CI_SUPPLY_CHAIN_IMAGE:-evalops-platform-ci-v6\}"/);
  assert.match(
    supplyChain,
    /command: \.buildkite\/run-with-mise "rust@1\.95\.0 gh@2\.88\.1" scripts\/run-buildkite-supply-chain\.sh/,
  );
});

test("A2A tmux smoke atomically reserves its session before resetting durable task databases", () => {
  const cleanup = a2aTmuxSmoke.split("cleanup() {")[1]?.split("a2a_cli() {")[0] ?? "";
  const startup = a2aTmuxSmoke.split('cd "$ROOT_DIR"')[1] ?? "";
  const reservation = startup.indexOf('tmux new-session -d -s "$SESSION_NAME" -n peer-a "sleep 300"');
  const resetStart = startup.indexOf("rm -f");
  const respawn = startup.indexOf('tmux respawn-window -k -t "$SESSION_NAME:peer-a"');
  assert.match(cleanup, /if \[\[ "\$OWNS_SESSION" == "1" \]\]; then/);
  assert.match(startup, /if tmux new-session[^\n]+; then\n\tOWNS_SESSION=1/);
  assert.ok(reservation >= 0, "smoke must atomically reserve the tmux session");
  assert.ok(resetStart > reservation, "state reset must follow session reservation");
  assert.ok(respawn > resetStart, "peer A must start after state reset");
  assert.doesNotMatch(startup, /tmux has-session/);
  const reset = startup.slice(resetStart, respawn);
  for (const tasks of ["TASKS_A", "TASKS_B"]) {
    for (const suffix of ["", ".sqlite3", ".sqlite3-wal", ".sqlite3-shm"]) {
      assert.ok(reset.includes(`"$${tasks}${suffix}"`), `reset must remove $${tasks}${suffix}`);
    }
  }
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
